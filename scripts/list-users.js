const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function listUsers() {
  const snapshot = await db.collection('users').get();
  console.log('--- USERS IN DB ---');
  snapshot.forEach(doc => {
    console.log(`- ID: ${doc.id}, Username: ${doc.data().username}, Email: ${doc.data().email}`);
  });
  console.log('--- END ---');
  process.exit(0);
}

listUsers().catch(err => {
  console.error(err);
  process.exit(1);
});
