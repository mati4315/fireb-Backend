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

const CONTENT_PAGE_SIZE = 300;
const LIKE_PAGE_SIZE = 500;
const BATCH_WRITE_LIMIT = 400;

const dryRun = process.argv.includes('--dry-run');
const contentArg = process.argv.find((arg) => arg.startsWith('--content='));
const targetContentId = contentArg ? contentArg.replace('--content=', '').trim() : '';

let activeBatch = db.batch();
let activeBatchCount = 0;

let scannedContent = 0;
let scannedLikes = 0;
let updatedContentCount = 0;
let plannedWrites = 0;
let committedWrites = 0;

const toSafeCount = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
};

const enqueueSetMerge = async (ref, data) => {
  plannedWrites += 1;
  if (dryRun) return;

  activeBatch.set(ref, data, { merge: true });
  activeBatchCount += 1;

  if (activeBatchCount >= BATCH_WRITE_LIMIT) {
    await activeBatch.commit();
    committedWrites += activeBatchCount;
    activeBatch = db.batch();
    activeBatchCount = 0;
  }
};

const flushBatch = async () => {
  if (dryRun || activeBatchCount === 0) return;
  await activeBatch.commit();
  committedWrites += activeBatchCount;
  activeBatch = db.batch();
  activeBatchCount = 0;
};

const countLikesForContent = async (contentRef) => {
  let likesCount = 0;
  let lastLikeDoc = null;

  while (true) {
    let likesQuery = contentRef
      .collection('likes')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(LIKE_PAGE_SIZE);

    if (lastLikeDoc) {
      likesQuery = likesQuery.startAfter(lastLikeDoc.id);
    }

    const likesSnapshot = await likesQuery.get();
    if (likesSnapshot.empty) break;

    scannedLikes += likesSnapshot.size;
    likesCount += likesSnapshot.size;
    lastLikeDoc = likesSnapshot.docs[likesSnapshot.docs.length - 1];

    if (likesSnapshot.size < LIKE_PAGE_SIZE) break;
  }

  return likesCount;
};

const recalculateForContent = async (contentDoc) => {
  scannedContent += 1;

  const contentRef = contentDoc.ref;
  const contentData = contentDoc.data() || {};

  const likesCount = await countLikesForContent(contentRef);
  const currentLikesCount = toSafeCount(contentData?.stats?.likesCount);

  if (likesCount !== currentLikesCount) {
    updatedContentCount += 1;
    await enqueueSetMerge(contentRef, {
      stats: {
        likesCount
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
};

const processSingleContent = async (contentId) => {
  const contentRef = db.collection('content').doc(contentId);
  const contentDoc = await contentRef.get();

  if (!contentDoc.exists) {
    throw new Error(`No existe content/${contentId}`);
  }

  await recalculateForContent(contentDoc);
};

const processAllContent = async () => {
  let lastContentDoc = null;

  while (true) {
    let contentQuery = db
      .collection('content')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(CONTENT_PAGE_SIZE);

    if (lastContentDoc) {
      contentQuery = contentQuery.startAfter(lastContentDoc.id);
    }

    const contentSnapshot = await contentQuery.get();
    if (contentSnapshot.empty) break;

    for (const contentDoc of contentSnapshot.docs) {
      await recalculateForContent(contentDoc);
    }

    lastContentDoc = contentSnapshot.docs[contentSnapshot.docs.length - 1];
  }
};

const run = async () => {
  console.log('Backfill de contadores de likes iniciado...');
  if (dryRun) {
    console.log('Modo dry-run habilitado. No se escribiran cambios.');
  }

  if (targetContentId) {
    console.log(`Procesando solo content/${targetContentId}`);
    await processSingleContent(targetContentId);
  } else {
    console.log('Procesando toda la coleccion content...');
    await processAllContent();
  }

  await flushBatch();

  console.log('Resumen backfill likes:');
  console.log(`- Content escaneados: ${scannedContent}`);
  console.log(`- Likes escaneados: ${scannedLikes}`);
  console.log(`- content.stats.likesCount corregidos: ${updatedContentCount}`);
  console.log(`- Writes planeados: ${plannedWrites}`);
  if (!dryRun) {
    console.log(`- Writes aplicados: ${committedWrites}`);
  }

  console.log(dryRun ? 'Dry-run finalizado.' : 'Backfill finalizado.');
};

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Backfill like counters failed:', error);
    process.exit(1);
  });
