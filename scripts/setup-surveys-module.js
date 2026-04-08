const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();

async function upsertSurveyModuleConfig() {
  const modulesRef = db.collection('_config').doc('modules');
  await modulesRef.set(
    {
      surveys: {
        enabled: true
      }
    },
    { merge: true }
  );
}

async function ensureSampleSurvey() {
  const surveysRef = db.collection('surveys');
  const existing = await surveysRef.limit(1).get();
  if (!existing.empty) {
    console.log('Surveys collection already has data. Sample survey skipped.');
    return;
  }

  await surveysRef.doc('sample_survey_welcome').set({
    question: 'Que modulo te gustaria ver mas en CdeluAR?',
    description: 'Ayudanos a priorizar mejoras para la comunidad.',
    status: 'active',
    isMultipleChoice: false,
    maxVotesPerUser: 1,
    totalVotes: 0,
    options: [
      {
        id: 'opt_news',
        text: 'Noticias',
        voteCount: 0,
        active: true
      },
      {
        id: 'opt_community',
        text: 'Comunidad',
        voteCount: 0,
        active: true
      },
      {
        id: 'opt_ads',
        text: 'Publicidad relevante',
        voteCount: 0,
        active: true
      }
    ],
    createdBy: 'system',
    updatedBy: 'system',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: null
  });
}

async function run() {
  try {
    console.log('Setting up surveys module configuration...');
    await upsertSurveyModuleConfig();
    await ensureSampleSurvey();
    console.log('Surveys module setup completed.');
    process.exit(0);
  } catch (error) {
    console.error('Surveys module setup failed:', error);
    process.exit(1);
  }
}

run();
