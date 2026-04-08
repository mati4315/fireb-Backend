const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();

async function upsertCommentsModuleConfig() {
  await db.collection('_config').doc('modules').set(
    {
      comments: {
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
    console.log('Setting up comments module configuration...');
    await upsertCommentsModuleConfig();
    console.log('Comments module setup completed.');
    process.exit(0);
  } catch (error) {
    console.error('Comments module setup failed:', error);
    process.exit(1);
  }
}

run();
