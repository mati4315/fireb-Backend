const admin = require('firebase-admin');
const fs = require('fs');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();

async function importUsers() {
  const users = JSON.parse(fs.readFileSync('./transformed/users.json'));

  console.log(`Importing ${users.length} users...`);

  for (const user of users) {
    try {
      await db.collection('users').doc(user.id.toString()).set({
        ...user,
        createdAt: admin.firestore.Timestamp.fromDate(new Date(user.createdAt)),
        updatedAt: admin.firestore.Timestamp.fromDate(new Date(user.updatedAt))
      });

      console.log(`Imported user: ${user.username}`);
    } catch (error) {
      console.error(`Failed to import ${user.username}:`, error);
    }
  }
}

(async () => {
  try {
    await importUsers();
    console.log('User import finished.');
    process.exit(0);
  } catch (err) {
    console.error("Import failed:", err);
    process.exit(1);
  }
})();
