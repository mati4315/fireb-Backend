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

function inferModule(data) {
  if (data.module === 'news' || data.type === 'news' || data.source === 'wordpress' || data.isOficial === true) {
    return 'news';
  }
  return 'community';
}

function inferType(data, module) {
  if (data.type === 'news' || module === 'news') return 'news';
  return 'post';
}

function inferSource(data, module) {
  if (data.source) return data.source;
  return module === 'news' ? 'wordpress' : 'user';
}

async function run() {
  console.log('Backfilling content module/type/source fields...');

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('Dry run mode enabled. No writes will be performed.');
  }

  const pageSize = 400;
  let lastDoc = null;
  let scanned = 0;
  let patched = 0;

  while (true) {
    let q = db.collection('content').orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc.id);

    const snap = await q.get();
    if (snap.empty) break;

    let batch = db.batch();
    let batchCount = 0;

    for (const doc of snap.docs) {
      scanned++;
      const data = doc.data();
      const update = {};

      const module = inferModule(data);
      const type = inferType(data, module);
      const source = inferSource(data, module);

      if (!data.module) update.module = module;
      if (!data.type) update.type = type;
      if (!data.source) update.source = source;
      if (!Object.prototype.hasOwnProperty.call(data, 'isOficial')) {
        update.isOficial = module === 'news';
      }
      if (!Object.prototype.hasOwnProperty.call(data, 'deletedAt')) {
        update.deletedAt = null;
      }

      if (Object.keys(update).length > 0) {
        patched++;
        if (!dryRun) {
          batch.update(doc.ref, update);
          batchCount++;
        }
      }

      if (batchCount === 400) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    }

    if (!dryRun && batchCount > 0) {
      await batch.commit();
    }

    lastDoc = snap.docs[snap.docs.length - 1];
  }

  console.log(`Scanned: ${scanned}`);
  console.log(`Patched: ${patched}`);
  console.log(dryRun ? 'Dry run finished.' : 'Backfill finished.');
}

run().then(() => process.exit(0)).catch((error) => {
  console.error('Backfill failed:', error);
  process.exit(1);
});
