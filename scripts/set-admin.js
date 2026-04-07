const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();

async function setAdmin(username) {
  console.log(`Searching for user with username: ${username}...`);

  try {
    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('username', '==', username).get();

    if (snapshot.empty) {
      console.error(`User with username '${username}' not found.`);
      process.exit(1);
    }

    const docId = snapshot.docs[0].id;
    await usersRef.doc(docId).update({
      rol: 'admin'
    });

    console.log(`✅ User '${username}' (ID: ${docId}) is now an Administrator.`);
    process.exit(0);
  } catch (error) {
    console.error('Error updating user:', error);
    process.exit(1);
  }
}

// Set 'matias4315' as admin
setAdmin('matias4315');
