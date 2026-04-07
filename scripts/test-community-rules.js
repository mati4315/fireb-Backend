const path = require('path');
const admin = require('firebase-admin');
const dotenv = require('dotenv');

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../Frontend/.env') });

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID
  });
}

const db = admin.firestore();
const projectId = process.env.FIREBASE_PROJECT_ID;
const apiKey = process.env.VITE_FIREBASE_API_KEY;

if (!projectId || !apiKey) {
  console.error('Missing FIREBASE_PROJECT_ID or VITE_FIREBASE_API_KEY in env.');
  process.exit(1);
}

function randomId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function toFsString(value) {
  return { stringValue: value };
}

function toFsBool(value) {
  return { booleanValue: value };
}

function toFsInt(value) {
  return { integerValue: String(value) };
}

function toFsTimestamp(value) {
  return { timestampValue: value.toISOString() };
}

function toFsArrayStrings(values) {
  return {
    arrayValue: {
      values: values.map((v) => toFsString(v))
    }
  };
}

function toFsNull() {
  return { nullValue: null };
}

function buildContentFields({ uid, module, isOficial }) {
  return {
    type: toFsString(module === 'news' ? 'news' : 'post'),
    source: toFsString('user'),
    module: toFsString(module),
    isOficial: toFsBool(isOficial),
    titulo: toFsString('Test E2E Comunidad'),
    descripcion: toFsString('Validacion automatica de reglas'),
    images: toFsArrayStrings([]),
    userId: toFsString(uid),
    userName: toFsString('E2E Rules User'),
    userProfilePicUrl: toFsString(''),
    stats: {
      mapValue: {
        fields: {
          likesCount: toFsInt(0),
          commentsCount: toFsInt(0),
          viewsCount: toFsInt(0)
        }
      }
    },
    createdAt: toFsTimestamp(new Date()),
    updatedAt: toFsTimestamp(new Date()),
    deletedAt: toFsNull()
  };
}

async function signInAndGetIdToken(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Auth signIn failed: ${JSON.stringify(body)}`);
  }
  return body.idToken;
}

async function writeContentWithToken(token, docId, fields) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/content?documentId=${docId}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ fields })
  });

  let body;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

function expectStatus(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name} expected HTTP ${expected}, got ${actual}`);
  }
}

async function run() {
  console.log('Running community rules E2E test...');

  const email = `${randomId('rules-user')}@example.com`;
  const password = `Pwd!${Math.floor(Math.random() * 100000)}Ab`;

  const allowedDocId = randomId('e2e-allow-community');
  const denyNewsDocId = randomId('e2e-deny-news');
  const denyOfficialDocId = randomId('e2e-deny-official');

  let uid = null;
  try {
    const user = await admin.auth().createUser({ email, password, displayName: 'E2E Rules User' });
    uid = user.uid;
    console.log(`Auth test user created: ${uid}`);

    const token = await signInAndGetIdToken(email, password);
    console.log('ID token acquired.');

    const allowRes = await writeContentWithToken(
      token,
      allowedDocId,
      buildContentFields({ uid, module: 'community', isOficial: false })
    );
    expectStatus('Community create', allowRes.status, 200);
    console.log('PASS create community post (non-admin).');

    const denyNewsRes = await writeContentWithToken(
      token,
      denyNewsDocId,
      buildContentFields({ uid, module: 'news', isOficial: false })
    );
    expectStatus('News create denial', denyNewsRes.status, 403);
    console.log('PASS deny create news post from client user.');

    const denyOfficialRes = await writeContentWithToken(
      token,
      denyOfficialDocId,
      buildContentFields({ uid, module: 'community', isOficial: true })
    );
    expectStatus('Official flag denial', denyOfficialRes.status, 403);
    console.log('PASS deny create official community post from client user.');

    console.log('PASS: community rules E2E validations completed.');
    process.exit(0);
  } catch (error) {
    console.error('FAIL:', error.message);
    process.exit(1);
  } finally {
    try {
      await db.collection('content').doc(allowedDocId).delete();
    } catch {}
    try {
      await db.collection('content').doc(denyNewsDocId).delete();
    } catch {}
    try {
      await db.collection('content').doc(denyOfficialDocId).delete();
    } catch {}
    if (uid) {
      try {
        await admin.auth().deleteUser(uid);
      } catch {}
    }
  }
}

run();
