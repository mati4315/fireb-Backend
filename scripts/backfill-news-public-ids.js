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
const BATCH_LIMIT = 450;

const normalizeNewsPublicIdScalar = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? String(normalized) : '';
  }

  if (typeof value === 'string') {
    const raw = value.trim().replace(/^id:?/i, '');
    if (!/^\d+$/.test(raw)) return '';
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return '';
    const normalized = Math.floor(parsed);
    return normalized > 0 ? String(normalized) : '';
  }

  return '';
};

const normalizeNewsPublicId = (value) => {
  const queue = [value];

  while (queue.length > 0) {
    const candidate = queue.shift();
    const normalized = normalizeNewsPublicIdScalar(candidate);
    if (normalized) return normalized;

    if (Array.isArray(candidate)) {
      queue.push(...candidate);
      continue;
    }

    if (candidate && typeof candidate === 'object') {
      const record = candidate;
      queue.push(
        record.publicId,
        record.postId,
        record.postID,
        record.id,
        record.value,
        record.rendered
      );
    }
  }

  return '';
};

const extractNewsPublicId = (data) => {
  const candidates = [
    data?.publicId,
    data?.postId,
    data?.postID,
    data?.id,
    data?.wpPostId,
    data?.wordpressId,
    data?.custom_fields?.postId,
    data?.custom_fields?.postID,
    data?.custom_fields?.id,
    data?.custom_fields?.wpPostId,
    data?.custom_fields,
    data
  ];

  for (const candidate of candidates) {
    const normalized = normalizeNewsPublicId(candidate);
    if (normalized) return normalized;
  }

  return '';
};

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  let scanned = 0;
  let updatedDocs = 0;
  let mappedIndexes = 0;
  let missingPublicId = 0;
  let conflicts = 0;
  let lastDoc = null;
  let batch = db.batch();
  let batchOps = 0;
  const pageSize = 250;

  const commitBatch = async () => {
    if (dryRun || batchOps === 0) return;
    await batch.commit();
    batch = db.batch();
    batchOps = 0;
  };

  console.log(
    dryRun
      ? 'Backfill news public IDs (dry-run)...'
      : 'Backfill news public IDs...'
  );

  while (true) {
    let q = db
      .collection('content')
      .where('module', '==', 'news')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(pageSize);

    if (lastDoc) q = q.startAfter(lastDoc.id);

    const snapshot = await q.get();
    if (snapshot.empty) break;

    for (const contentDoc of snapshot.docs) {
      scanned += 1;
      const data = contentDoc.data() || {};
      const publicId = extractNewsPublicId(data);
      if (!publicId) {
        missingPublicId += 1;
        continue;
      }

      const postIdAsNumber = Number(publicId);
      const updatePayload = {};
      if (data.publicId !== publicId) updatePayload.publicId = publicId;
      if (data.postId !== postIdAsNumber) updatePayload.postId = postIdAsNumber;

      if (Object.keys(updatePayload).length > 0) {
        updatedDocs += 1;
        if (!dryRun) {
          batch.set(contentDoc.ref, updatePayload, { merge: true });
          batchOps += 1;
        }
      }

      const publicKey = `news__${publicId}`;
      const publicRef = db.collection('_content_public_ids').doc(publicKey);
      const existing = await publicRef.get();
      if (existing.exists) {
        const mapped = String(existing.data()?.contentId || '').trim();
        if (mapped && mapped !== contentDoc.id) {
          conflicts += 1;
          console.warn(
            `Conflict for publicId ${publicId}: already mapped to ${mapped}, skipping ${contentDoc.id}`
          );
          continue;
        }
      }

      mappedIndexes += 1;
      if (!dryRun) {
        batch.set(
          publicRef,
          {
            contentId: contentDoc.id,
            module: 'news',
            publicId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        batchOps += 1;
      }

      if (batchOps >= BATCH_LIMIT) {
        await commitBatch();
      }
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
  }

  await commitBatch();

  console.log(`Scanned: ${scanned}`);
  console.log(`Docs updated: ${updatedDocs}`);
  console.log(`Indexes mapped: ${mappedIndexes}`);
  console.log(`Missing publicId: ${missingPublicId}`);
  console.log(`Conflicts: ${conflicts}`);
  console.log(dryRun ? 'Dry run completed.' : 'Backfill completed.');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Backfill news public IDs failed:', error);
    process.exit(1);
  });
