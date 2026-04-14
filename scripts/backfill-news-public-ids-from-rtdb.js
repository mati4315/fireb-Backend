const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);
const projectId = process.env.FIREBASE_PROJECT_ID;

if (!projectId) {
  throw new Error('Missing FIREBASE_PROJECT_ID in .env');
}

const databaseURL =
  process.env.FIREBASE_DATABASE_URL ||
  `https://${projectId}-default-rtdb.firebaseio.com`;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId,
    databaseURL
  });
}

const db = admin.firestore();
const rtdb = admin.database();
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

const extractNewsPublicId = (payload) => {
  const candidates = [
    payload?.publicId,
    payload?.postId,
    payload?.postID,
    payload?.id,
    payload?.wpPostId,
    payload?.wordpressId,
    payload?.custom_fields?.postId,
    payload?.custom_fields?.postID,
    payload?.custom_fields?.id,
    payload?.custom_fields?.wpPostId,
    payload?.custom_fields,
    payload
  ];

  for (const candidate of candidates) {
    const normalized = normalizeNewsPublicId(candidate);
    if (normalized) return normalized;
  }

  return '';
};

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const rootSnapshot = await rtdb.ref('/news').once('value');
  const newsMap = rootSnapshot.val() || {};
  const entries = Object.entries(newsMap);

  let processed = 0;
  let updatedDocs = 0;
  let mappedIndexes = 0;
  let missingPostId = 0;
  let missingContentDoc = 0;
  let conflicts = 0;
  let batch = db.batch();
  let batchOps = 0;

  const commitBatch = async () => {
    if (dryRun || batchOps === 0) return;
    await batch.commit();
    batch = db.batch();
    batchOps = 0;
  };

  console.log(
    dryRun
      ? 'Backfill news public IDs from RTDB (dry-run)...'
      : 'Backfill news public IDs from RTDB...'
  );
  console.log(`RTDB records: ${entries.length}`);

  for (const [newsId, payload] of entries) {
    processed += 1;
    const publicId = extractNewsPublicId(payload);
    if (!publicId) {
      missingPostId += 1;
      continue;
    }

    const contentRef = db.collection('content').doc(String(newsId));
    const contentSnap = await contentRef.get();
    if (!contentSnap.exists) {
      missingContentDoc += 1;
      continue;
    }

    const contentData = contentSnap.data() || {};
    const postIdAsNumber = Number(publicId);
    const contentUpdate = {};
    if (contentData.publicId !== publicId) contentUpdate.publicId = publicId;
    if (contentData.postId !== postIdAsNumber) contentUpdate.postId = postIdAsNumber;

    if (Object.keys(contentUpdate).length > 0) {
      updatedDocs += 1;
      if (!dryRun) {
        batch.set(contentRef, contentUpdate, { merge: true });
        batchOps += 1;
      }
    }

    const publicKey = `news__${publicId}`;
    const publicRef = db.collection('_content_public_ids').doc(publicKey);
    const publicSnap = await publicRef.get();
    if (publicSnap.exists) {
      const mappedId = String(publicSnap.data()?.contentId || '').trim();
      if (mappedId && mappedId !== String(newsId)) {
        conflicts += 1;
        console.warn(
          `Conflict for publicId ${publicId}: already mapped to ${mappedId}, skipping ${newsId}`
        );
        continue;
      }
    }

    mappedIndexes += 1;
    if (!dryRun) {
      batch.set(
        publicRef,
        {
          contentId: String(newsId),
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

  await commitBatch();

  console.log(`Processed RTDB records: ${processed}`);
  console.log(`Docs updated: ${updatedDocs}`);
  console.log(`Indexes mapped: ${mappedIndexes}`);
  console.log(`Missing postId in RTDB payload: ${missingPostId}`);
  console.log(`Missing content docs in Firestore: ${missingContentDoc}`);
  console.log(`Conflicts: ${conflicts}`);
  console.log(dryRun ? 'Dry run completed.' : 'Backfill completed.');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Backfill from RTDB failed:', error);
    process.exit(1);
  });
