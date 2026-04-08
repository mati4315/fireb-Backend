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

const PAGE_SIZE = 300;
const BATCH_WRITE_LIMIT = 400;

const dryRun = process.argv.includes('--dry-run');
const contentArg = process.argv.find((arg) => arg.startsWith('--content='));
const targetContentId = contentArg ? contentArg.replace('--content=', '').trim() : '';

let activeBatch = db.batch();
let activeBatchCount = 0;

let scannedContent = 0;
let scannedComments = 0;
let scannedReplies = 0;
let updatedContentCount = 0;
let updatedCommentCount = 0;
let plannedWrites = 0;
let committedWrites = 0;

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

const isAlive = (data) => data?.deletedAt == null;

const toSafeCount = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
};

const countAliveReplies = async (commentRef) => {
  let aliveReplies = 0;
  let lastReplyDoc = null;

  while (true) {
    let repliesQuery = commentRef
      .collection('replies')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);

    if (lastReplyDoc) {
      repliesQuery = repliesQuery.startAfter(lastReplyDoc.id);
    }

    const repliesSnapshot = await repliesQuery.get();
    if (repliesSnapshot.empty) break;

    for (const replyDoc of repliesSnapshot.docs) {
      scannedReplies += 1;
      if (isAlive(replyDoc.data())) {
        aliveReplies += 1;
      }
    }

    lastReplyDoc = repliesSnapshot.docs[repliesSnapshot.docs.length - 1];
  }

  return aliveReplies;
};

const recalculateForContent = async (contentDoc) => {
  scannedContent += 1;

  const contentRef = contentDoc.ref;
  const contentData = contentDoc.data() || {};

  let aliveComments = 0;
  let lastCommentDoc = null;

  while (true) {
    let commentsQuery = contentRef
      .collection('comments')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);

    if (lastCommentDoc) {
      commentsQuery = commentsQuery.startAfter(lastCommentDoc.id);
    }

    const commentsSnapshot = await commentsQuery.get();
    if (commentsSnapshot.empty) break;

    for (const commentDoc of commentsSnapshot.docs) {
      scannedComments += 1;
      const commentData = commentDoc.data() || {};

      if (isAlive(commentData)) {
        aliveComments += 1;
      }

      const aliveReplies = await countAliveReplies(commentDoc.ref);
      const currentRepliesCount = toSafeCount(commentData?.stats?.repliesCount);

      if (aliveReplies !== currentRepliesCount) {
        updatedCommentCount += 1;
        await enqueueSetMerge(commentDoc.ref, {
          stats: {
            repliesCount: aliveReplies
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }

    lastCommentDoc = commentsSnapshot.docs[commentsSnapshot.docs.length - 1];
  }

  const currentCommentsCount = toSafeCount(contentData?.stats?.commentsCount);
  if (aliveComments !== currentCommentsCount) {
    updatedContentCount += 1;
    await enqueueSetMerge(contentRef, {
      stats: {
        commentsCount: aliveComments
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
      .limit(PAGE_SIZE);

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
  console.log('Backfill de contadores de comentarios iniciado...');
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

  console.log('Resumen backfill comments:');
  console.log(`- Content escaneados: ${scannedContent}`);
  console.log(`- Comentarios escaneados: ${scannedComments}`);
  console.log(`- Respuestas escaneadas: ${scannedReplies}`);
  console.log(`- content.stats.commentsCount corregidos: ${updatedContentCount}`);
  console.log(`- comment.stats.repliesCount corregidos: ${updatedCommentCount}`);
  console.log(`- Writes planeados: ${plannedWrites}`);
  if (!dryRun) {
    console.log(`- Writes aplicados: ${committedWrites}`);
  }

  console.log(dryRun ? 'Dry-run finalizado.' : 'Backfill finalizado.');
};

run()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('Backfill comment counters failed:', error);
    process.exit(1);
  });
