const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require(path.join(__dirname, 'firebase-sa-key.json'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function check() {
  console.log('Checking Firestore collection "content" ...');
  const snapshot = await db.collection('content')
    .where('module', '==', 'community')
    .limit(10)
    .get();
  
  if (snapshot.empty) {
    console.log('No community posts found in Firestore.');
  } else {
    snapshot.forEach(doc => {
      const data = doc.data();
      console.log(`Document ID: ${doc.id}`);
      console.log(`Author: ${data.userName}`);
      console.log(`IngestedAt: ${data.ingestedAt?.toDate()?.toISOString() || 'N/A'}`);
      console.log(`id_unico: ${data.id_unico}`);
      console.log('---');
    });
  }
  process.exit(0);
}

check().catch(err => {
  console.error(err);
  process.exit(1);
});
