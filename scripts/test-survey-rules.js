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

function toFsNull() {
  return { nullValue: null };
}

function toFsTimestamp(date) {
  return { timestampValue: date.toISOString() };
}

function toFsArray(values) {
  return { arrayValue: { values } };
}

function toFsMap(fields) {
  return { mapValue: { fields } };
}

function buildSurveyFields() {
  return {
    question: toFsString('Encuesta de prueba E2E'),
    description: toFsString('Validacion automatica de reglas'),
    status: toFsString('active'),
    isMultipleChoice: toFsBool(false),
    maxVotesPerUser: toFsInt(1),
    totalVotes: toFsInt(0),
    options: toFsArray([
      toFsMap({
        id: toFsString('opt_a'),
        text: toFsString('Opcion A'),
        voteCount: toFsInt(0),
        active: toFsBool(true)
      }),
      toFsMap({
        id: toFsString('opt_b'),
        text: toFsString('Opcion B'),
        voteCount: toFsInt(0),
        active: toFsBool(true)
      })
    ]),
    createdBy: toFsString('rules-test'),
    updatedBy: toFsString('rules-test'),
    createdAt: toFsTimestamp(new Date()),
    updatedAt: toFsTimestamp(new Date()),
    expiresAt: toFsNull()
  };
}

function buildVoteFields({ surveyId, uid }) {
  return {
    surveyId: toFsString(surveyId),
    userId: toFsString(uid),
    optionIds: toFsArray([toFsString('opt_a')]),
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

async function firestoreRequest({ method, token, collection, documentId, body }) {
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const target = documentId
    ? `${base}/${collection}/${documentId}`
    : `${base}/${collection}`;
  const url = documentId || method === 'GET' || method === 'DELETE'
    ? target
    : `${target}?documentId=${encodeURIComponent(body.documentId)}`;

  const headers = {
    'Content-Type': 'application/json'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const payload = body && body.fields ? { fields: body.fields } : undefined;

  const response = await fetch(url, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined
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
  console.log('Running survey rules E2E test...');

  const regularEmail = `${randomId('survey-user')}@example.com`;
  const regularPassword = `Pwd!${Math.floor(Math.random() * 100000)}Ab`;
  const staffEmail = `${randomId('survey-staff')}@example.com`;
  const staffPassword = `Pwd!${Math.floor(Math.random() * 100000)}Ab`;
  const surveyId = randomId('e2e-survey');
  const voteDocId = `${surveyId}_vote_test`;

  let regularUid = null;
  let staffUid = null;

  try {
    const regularUser = await admin.auth().createUser({
      email: regularEmail,
      password: regularPassword,
      displayName: 'Survey Rules User'
    });
    regularUid = regularUser.uid;

    const staffUser = await admin.auth().createUser({
      email: staffEmail,
      password: staffPassword,
      displayName: 'Survey Rules Staff'
    });
    staffUid = staffUser.uid;

    await db.collection('users').doc(regularUid).set({
      email: regularEmail,
      nombre: 'Survey Rules User',
      username: randomId('survey_user'),
      rol: 'user'
    }, { merge: true });

    await db.collection('users').doc(staffUid).set({
      email: staffEmail,
      nombre: 'Survey Rules Staff',
      username: randomId('survey_staff'),
      rol: 'colaborador'
    }, { merge: true });

    const regularToken = await signInAndGetIdToken(regularEmail, regularPassword);
    const staffToken = await signInAndGetIdToken(staffEmail, staffPassword);

    const publicRead = await firestoreRequest({
      method: 'GET',
      collection: 'surveys?pageSize=1'
    });
    expectStatus('Public surveys read', publicRead.status, [200]);
    console.log('PASS public can read surveys.');

    const unauthVoteWrite = await firestoreRequest({
      method: 'POST',
      collection: 'survey_votes',
      body: {
        documentId: voteDocId,
        fields: buildVoteFields({ surveyId, uid: regularUid })
      }
    });
    expectStatus('Public vote direct write denied', unauthVoteWrite.status, [401, 403]);
    console.log('PASS public cannot write survey_votes directly.');

    const userCreateSurvey = await firestoreRequest({
      method: 'POST',
      token: regularToken,
      collection: 'surveys',
      body: {
        documentId: surveyId,
        fields: buildSurveyFields()
      }
    });
    expectStatus('Regular user survey create denied', userCreateSurvey.status, [403]);
    console.log('PASS regular user cannot create surveys.');

    const staffCreateSurvey = await firestoreRequest({
      method: 'POST',
      token: staffToken,
      collection: 'surveys',
      body: {
        documentId: surveyId,
        fields: buildSurveyFields()
      }
    });
    expectStatus('Staff survey create allowed', staffCreateSurvey.status, [200]);
    console.log('PASS staff can create surveys.');

    const userDirectVote = await firestoreRequest({
      method: 'POST',
      token: regularToken,
      collection: 'survey_votes',
      body: {
        documentId: voteDocId,
        fields: buildVoteFields({ surveyId, uid: regularUid })
      }
    });
    expectStatus('Regular user direct vote write denied', userDirectVote.status, [403]);
    console.log('PASS direct vote writes are blocked (callable required).');

    const staffDeleteSurvey = await firestoreRequest({
      method: 'DELETE',
      token: staffToken,
      collection: 'surveys',
      documentId: surveyId
    });
    expectStatus('Staff survey delete allowed', staffDeleteSurvey.status, [200]);
    console.log('PASS staff can delete surveys.');

    console.log('PASS: survey rules E2E validations completed.');
    process.exit(0);
  } catch (error) {
    console.error('FAIL:', error.message);
    process.exit(1);
  } finally {
    try { await db.collection('surveys').doc(surveyId).delete(); } catch {}
    try { await db.collection('survey_votes').doc(voteDocId).delete(); } catch {}
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
