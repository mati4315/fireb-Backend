const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID
  });
}

const db = admin.firestore();

async function upsertLikesModuleConfig() {
  await db.collection('_config').doc('modules').set(
    {
      likes: {
        enabled: true,
        newsEnabled: true,
        communityEnabled: true
      }
    },
    { merge: true }
  );
}

async function run() {
  try {
    console.log('Setting up likes module configuration...');
    await upsertLikesModuleConfig();
    console.log('Likes module setup completed.');
    process.exit(0);
  } catch (error) {
    console.error('Likes module setup failed:', error);
    process.exit(1);
  }
}

run();
