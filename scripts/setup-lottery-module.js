const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();

async function upsertLotteryModuleConfig() {
  await db.collection('_config').doc('modules').set(
    {
      lottery: {
        enabled: true
      }
    },
    { merge: true }
  );
}

async function ensureSampleLottery() {
  const lotteriesRef = db.collection('lotteries');
  const existing = await lotteriesRef.limit(1).get();
  if (!existing.empty) {
    console.log('Lotteries collection already has data. Sample lottery skipped.');
    return;
  }

  const now = Date.now();
  const startAt = new Date(now - 5 * 60 * 1000);
  const endAt = new Date(now + 60 * 60 * 1000);

  await lotteriesRef.doc('sample_lottery_welcome').set({
    title: 'Loteria de bienvenida CdeluAR',
    description: 'Sorteo de ejemplo para validar el modulo.',
    status: 'active',
    startsAt: admin.firestore.Timestamp.fromDate(startAt),
    endsAt: admin.firestore.Timestamp.fromDate(endAt),
    participantsCount: 0,
    winner: null,
    createdBy: 'system',
    updatedBy: 'system',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    deletedAt: null
  });
}

async function run() {
  try {
    console.log('Setting up lottery module configuration...');
    await upsertLotteryModuleConfig();
    await ensureSampleLottery();
    console.log('Lottery module setup completed.');
    process.exit(0);
  } catch (error) {
    console.error('Lottery module setup failed:', error);
    process.exit(1);
  }
}

run();
