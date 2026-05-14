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
  const ids = ['10002466734035352', '10000941133174352']; // partials from log
  console.log('Searching for documents with starting IDs...');
  
  for (const idPart of ids) {
    const snapshot = await db.collection('content')
      .where('id_unico', '>=', idPart)
      .where('id_unico', '<', idPart + '\uf8ff')
      .get();
    
    if (snapshot.empty) {
      console.log(`No documents found for part ${idPart}`);
    } else {
      snapshot.forEach(doc => {
        console.log(`Found Document ID: ${doc.id}, IngestedAt: ${doc.data().ingestedAt?.toDate()?.toISOString()}`);
      });
    }
  }
  process.exit(0);
}

check().catch(err => {
  console.error(err);
  process.exit(1);
});
