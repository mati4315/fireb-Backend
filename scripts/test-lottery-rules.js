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

function toFsInt(value) {
  return { integerValue: String(value) };
}

function toFsNull() {
  return { nullValue: null };
}

function toFsTimestamp(value) {
  return { timestampValue: value.toISOString() };
}

function toFsMap(fields) {
  return { mapValue: { fields } };
}

function buildLotteryFields() {
  const now = Date.now();
  return {
    title: toFsString('Loteria test reglas'),
    description: toFsString('Prueba e2e reglas loteria'),
    status: toFsString('active'),
    startsAt: toFsTimestamp(new Date(now - 60000)),
    endsAt: toFsTimestamp(new Date(now + 3600000)),
    participantsCount: toFsInt(0),
    winner: toFsNull(),
    createdBy: toFsString('rules-test'),
    updatedBy: toFsString('rules-test'),
    createdAt: toFsTimestamp(new Date()),
    updatedAt: toFsTimestamp(new Date()),
    deletedAt: toFsNull()
  };
}

function buildEntryFields({ uid, lotteryId }) {
  return {
    userId: toFsString(uid),
    userName: toFsString('Usuario test'),
    userProfilePicUrl: toFsString(''),
    lotteryId: toFsString(lotteryId),
    createdAt: toFsTimestamp(new Date()),
    updatedAt: toFsTimestamp(new Date())
  };
}

async function signInAndGetIdToken(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Auth signIn failed: ${JSON.stringify(body)}`);
  }
  return body.idToken;
}

async function firestoreRequest({ method, token, path: documentPath, body }) {
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const url = `${base}/${documentPath}`;

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let parsed;
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed };
}

function expectStatus(label, actual, expectedStatuses) {
  if (!expectedStatuses.includes(actual)) {
    throw new Error(`${label} expected ${expectedStatuses.join('/')} and got ${actual}`);
  }
}

async function run() {
  console.log('Running lottery rules E2E test...');

  const lotteryId = randomId('lottery-rules');
  const regularEmail = `${randomId('lot-user')}@example.com`;
  const regularPassword = `Pwd!${Math.floor(Math.random() * 100000)}Ab`;
  const staffEmail = `${randomId('lot-staff')}@example.com`;
  const staffPassword = `Pwd!${Math.floor(Math.random() * 100000)}Ab`;

  let regularUid = null;
  let staffUid = null;

  try {
    const regularUser = await admin.auth().createUser({
      email: regularEmail,
      password: regularPassword,
      displayName: 'Lottery Rules User'
    });
    regularUid = regularUser.uid;

    const staffUser = await admin.auth().createUser({
      email: staffEmail,
      password: staffPassword,
      displayName: 'Lottery Rules Staff'
    });
    staffUid = staffUser.uid;
    await admin.auth().setCustomUserClaims(staffUid, { admin: true });

    await Promise.all([
      db.collection('users').doc(regularUid).set({
        email: regularEmail,
        nombre: 'Lottery Rules User',
        username: randomId('lot_user'),
        rol: 'user'
      }, { merge: true }),
      db.collection('users').doc(staffUid).set({
        email: staffEmail,
        nombre: 'Lottery Rules Staff',
        username: randomId('lot_staff'),
        rol: 'colaborador'
      }, { merge: true }),
      db.collection('_config').doc('modules').set({
        lottery: { enabled: true }
      }, { merge: true })
    ]);

    const [regularToken, staffToken] = await Promise.all([
      signInAndGetIdToken(regularEmail, regularPassword),
      signInAndGetIdToken(staffEmail, staffPassword)
    ]);

    const regularCreateLottery = await firestoreRequest({
      method: 'POST',
      token: regularToken,
      path: `lotteries?documentId=${encodeURIComponent(lotteryId)}`,
      body: { fields: buildLotteryFields() }
    });
    expectStatus('Regular user create lottery denied', regularCreateLottery.status, [403]);
    console.log('PASS regular user cannot create lotteries.');

    const staffCreateLottery = await firestoreRequest({
      method: 'POST',
      token: staffToken,
      path: `lotteries?documentId=${encodeURIComponent(lotteryId)}`,
      body: { fields: buildLotteryFields() }
    });
    expectStatus('Staff create lottery allowed', staffCreateLottery.status, [200]);
    console.log('PASS staff can create lotteries.');

    const regularReadLottery = await firestoreRequest({
      method: 'GET',
      token: regularToken,
      path: `lotteries/${lotteryId}`
    });
    expectStatus('Regular user read lottery allowed', regularReadLottery.status, [200]);
    console.log('PASS regular authenticated user can read lotteries.');

    const unauthEntryCreate = await firestoreRequest({
      method: 'POST',
      path: `lotteries/${lotteryId}/entries?documentId=${encodeURIComponent(regularUid)}`,
      body: { fields: buildEntryFields({ uid: regularUid, lotteryId }) }
    });
    expectStatus('Unauth direct entry denied', unauthEntryCreate.status, [401, 403]);
    console.log('PASS unauthenticated users cannot write entries directly.');

    const authEntryCreate = await firestoreRequest({
      method: 'POST',
      token: regularToken,
      path: `lotteries/${lotteryId}/entries?documentId=${encodeURIComponent(regularUid)}`,
      body: { fields: buildEntryFields({ uid: regularUid, lotteryId }) }
    });
    expectStatus('Authenticated direct entry denied', authEntryCreate.status, [403]);
    console.log('PASS entries are callable-only (direct writes blocked).');

    const staffUpdateLottery = await firestoreRequest({
      method: 'PATCH',
      token: staffToken,
      path: `lotteries/${lotteryId}?updateMask.fieldPaths=status`,
      body: {
        fields: {
          status: toFsString('closed')
        }
      }
    });
    expectStatus('Staff update lottery allowed', staffUpdateLottery.status, [200]);
    console.log('PASS staff can update lotteries.');

    console.log('PASS: lottery rules E2E validations completed.');
    process.exit(0);
  } catch (error) {
    console.error('FAIL:', error.message);
    process.exit(1);
  } finally {
    try { await db.collection('lotteries').doc(lotteryId).delete(); } catch {}
    if (regularUid) {
      try { await db.collection('users').doc(regularUid).delete(); } catch {}
      try { await admin.auth().deleteUser(regularUid); } catch {}
    }
    if (staffUid) {
      try { await db.collection('users').doc(staffUid).delete(); } catch {}
      try { await admin.auth().deleteUser(staffUid); } catch {}
    }
  }
}

run();
