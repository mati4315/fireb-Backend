import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { randomBytes } from 'crypto';
import { assertAdminUser } from './userUtils';
import { cleanupCommunityPostHostingMedia } from './hostingUtils';

const PAGE_SIZE = 300;
const DELETE_CONCURRENCY = 20;
const ROOT_ADMIN_UID = 'Z4f5ogXDQaNhEY4iBf9jgkPnQMP2';
const ROOT_ADMIN_EMAIL = 'matias4315@gmail.com';

const commitDeletes = async (db: FirebaseFirestore.Firestore, refs: FirebaseFirestore.DocumentReference[]) => {
  for (let index = 0; index < refs.length; index += 450) {
    const batch = db.batch();
    refs.slice(index, index + 450).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
};

const recursiveDeleteInChunks = async (db: FirebaseFirestore.Firestore, refs: FirebaseFirestore.DocumentReference[]) => {
  for (let index = 0; index < refs.length; index += DELETE_CONCURRENCY) {
    await Promise.all(refs.slice(index, index + DELETE_CONCURRENCY).map((ref) => db.recursiveDelete(ref)));
  }
};

const decrementCounters = async (
  db: FirebaseFirestore.Firestore,
  counterByPath: Map<string, { ref: FirebaseFirestore.DocumentReference; count: number }>,
  field: string
) => {
  const rows = Array.from(counterByPath.values());
  for (let index = 0; index < rows.length; index += 400) {
    const page = rows.slice(index, index + 400);
    const existing = await Promise.all(page.map(async (row) => ({ row, snap: await row.ref.get() })));
    const batch = db.batch();
    let writes = 0;
    for (const { row, snap } of existing) {
      if (!snap.exists) continue;
      batch.update(row.ref, {
        [field]: admin.firestore.FieldValue.increment(-row.count),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      writes += 1;
    }
    if (writes) await batch.commit();
  }
};

const deleteOwnedCommunityPosts = async (
  db: FirebaseFirestore.Firestore,
  userId: string
): Promise<{ ids: Set<string>; count: number; mediaCleanupFailures: number }> => {
  const ids = new Set<string>();
  let count = 0;
  let mediaCleanupFailures = 0;

  const userContent = db.collection('content').where('userId', '==', userId);
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  while (true) {
    let pageQuery = userContent.orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) pageQuery = pageQuery.startAfter(cursor);
    const page = await pageQuery.get();
    if (page.empty) break;

    // Every content document carrying this UID is owned by the account. This
    // also avoids leaving authored posts behind when a module uses a different
    // `type` or `module` label.
    const ownedPosts = page.docs;
    for (const post of ownedPosts) {
      const data = post.data();
      ids.add(post.id);
      const hasHostedImages = [data.images, data.imagesV2, data.imgMiniatura, data.img_miniatura,
        data.thumbnail, data.thumbnailUrl, data.coverThumbnailUrl, data.custom_fields?.image]
        .some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value));
      if (hasHostedImages) {
        try {
          await cleanupCommunityPostHostingMedia(data);
        } catch (error) {
          mediaCleanupFailures += 1;
          console.error(`No se pudo limpiar el medio de la publicación ${post.id}:`, error);
        }
      }
    }

    await recursiveDeleteInChunks(db, ownedPosts.map((post) => post.ref));
    count += ownedPosts.length;
    cursor = page.docs[page.docs.length - 1];
    if (page.size < PAGE_SIZE) break;
  }

  return { ids, count, mediaCleanupFailures };
};

const deleteAuthoredCommentsAndReplies = async (
  db: FirebaseFirestore.Firestore,
  userId: string,
  deletedPostIds: Set<string>
): Promise<{ comments: number; replies: number }> => {
  let comments = 0;
  let replies = 0;
  const commentCounts = new Map<string, { ref: FirebaseFirestore.DocumentReference; count: number }>();

  while (true) {
    const page = await db.collectionGroup('comments').where('userId', '==', userId).limit(PAGE_SIZE).get();
    const docs = page.docs;
    if (page.empty) break;

    for (const snapshot of docs) {
      const parts = snapshot.ref.path.split('/');
      const isContentComment = parts.length === 4 && parts[0] === 'content' && parts[2] === 'comments';
      const contentId = isContentComment ? parts[1] : '';
      if (isContentComment && snapshot.data().deletedAt == null && !deletedPostIds.has(contentId)) {
        const contentRef = snapshot.ref.parent.parent;
        if (contentRef) {
          const current = commentCounts.get(contentRef.path) || { ref: contentRef, count: 0 };
          current.count += 1;
          commentCounts.set(contentRef.path, current);
        }
      }
    }

    await recursiveDeleteInChunks(db, docs.map((snapshot) => snapshot.ref));
    comments += docs.length;
  }

  await decrementCounters(db, commentCounts, 'stats.commentsCount');

  const replyCounts = new Map<string, { ref: FirebaseFirestore.DocumentReference; count: number }>();
  while (true) {
    const page = await db.collectionGroup('replies').where('userId', '==', userId).limit(PAGE_SIZE).get();
    const docs = page.docs;
    if (page.empty) break;

    for (const snapshot of docs) {
      if (snapshot.data().deletedAt != null) continue;
      const parts = snapshot.ref.path.split('/');
      if (parts.length !== 6 || parts[0] !== 'content' || parts[2] !== 'comments' || parts[4] !== 'replies') continue;
      const commentRef = snapshot.ref.parent.parent;
      if (!commentRef) continue;
      const commentSnap = await commentRef.get();
      if (!commentSnap.exists || commentSnap.data()?.userId === userId) continue;
      const current = replyCounts.get(commentRef.path) || { ref: commentRef, count: 0 };
      current.count += 1;
      replyCounts.set(commentRef.path, current);
    }

    await recursiveDeleteInChunks(db, docs.map((snapshot) => snapshot.ref));
    replies += docs.length;
  }

  await decrementCounters(db, replyCounts, 'stats.repliesCount');
  return { comments, replies };
};

const anonymizeLotteryParticipation = async (
  db: FirebaseFirestore.Firestore,
  userId: string
): Promise<number> => {
  const anonymousId = `deleted_${randomBytes(16).toString('hex')}`;
  const affectedLotteryRefs = new Map<string, FirebaseFirestore.DocumentReference>();
  let count = 0;

  while (true) {
    const page = await db.collectionGroup('entries').where('userId', '==', userId).limit(PAGE_SIZE).get();
    if (page.empty) break;

    const batch = db.batch();
    for (const entry of page.docs) {
      batch.update(entry.ref, {
        userId: anonymousId,
        userName: 'Usuario eliminado',
        userUsername: '',
        userProfilePicUrl: '',
        email: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const lotteryRef = entry.ref.parent.parent;
      if (lotteryRef) affectedLotteryRefs.set(lotteryRef.path, lotteryRef);
    }
    await batch.commit();
    count += page.size;
  }

  const lotteryRefs = Array.from(affectedLotteryRefs.values());
  for (let index = 0; index < lotteryRefs.length; index += 300) {
    const page = lotteryRefs.slice(index, index + 300);
    const snapshots = await Promise.all(page.map((ref) => ref.get()));
    const batch = db.batch();
    let writes = 0;
    snapshots.forEach((snapshot) => {
      if (!snapshot.exists) return;
      const winner = snapshot.data()?.winner;
      if (!winner || winner.userId !== userId) return;
      batch.update(snapshot.ref, {
        winner: {
          ...winner,
          userId: anonymousId,
          userName: 'Usuario eliminado',
          userProfilePicUrl: ''
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      writes += 1;
    });
    if (writes) await batch.commit();
  }

  return count;
};

const removeAccountRelationships = async (db: FirebaseFirestore.Firestore, userId: string) => {
  const relationshipRef = db.collection('relationships').doc(userId);
  const [following, followers] = await Promise.all([
    relationshipRef.collection('following').get(),
    relationshipRef.collection('followers').get()
  ]);
  const reverseRefs = [
    ...following.docs.map((doc) => db.collection('relationships').doc(doc.id).collection('followers').doc(userId)),
    ...followers.docs.map((doc) => db.collection('relationships').doc(doc.id).collection('following').doc(userId))
  ];
  await commitDeletes(db, reverseRefs);
  await db.recursiveDelete(relationshipRef);
};

const deleteUserTicketExtras = async (db: FirebaseFirestore.Firestore, userId: string) => {
  while (true) {
    const page = await db.collection('lottery_user_ticket_extras').where('userId', '==', userId).limit(PAGE_SIZE).get();
    if (page.empty) break;
    await commitDeletes(db, page.docs.map((doc) => doc.ref));
  }
};

export const deleteManagedUserAccountInternal = async (
  db: FirebaseFirestore.Firestore,
  data: unknown,
  context: functions.https.CallableContext
): Promise<Record<string, unknown>> => {
  await assertAdminUser(db, context.auth);
  const requesterUid = context.auth?.uid || '';
  const userId = typeof (data as any)?.userId === 'string' ? (data as any).userId.trim() : '';
  if (!userId || userId.length > 128) {
    throw new functions.https.HttpsError('invalid-argument', 'El ID de usuario no es válido.');
  }
  if (userId === requesterUid) {
    throw new functions.https.HttpsError('failed-precondition', 'No puedes eliminar la cuenta con la que estás administrando.');
  }
  if (userId === ROOT_ADMIN_UID) {
    throw new functions.https.HttpsError('permission-denied', 'La cuenta principal del sistema está protegida.');
  }

  const userRef = db.collection('users').doc(userId);
  const [profileSnap, authRecord] = await Promise.all([
    userRef.get(),
    admin.auth().getUser(userId).catch((error: any) => {
      if (error?.code === 'auth/user-not-found') return null;
      throw error;
    })
  ]);
  const accountEmail = String(authRecord?.email || profileSnap.data()?.email || '').trim().toLowerCase();
  if (accountEmail === ROOT_ADMIN_EMAIL) {
    throw new functions.https.HttpsError('permission-denied', 'La cuenta principal del sistema está protegida.');
  }

  // A tombstone blocks any still-valid ID token from writing after deletion.
  await db.collection('_deletedUsers').doc(userId).set({
    deletedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  const posts = await deleteOwnedCommunityPosts(db, userId);
  const authored = await deleteAuthoredCommentsAndReplies(db, userId, posts.ids);
  const anonymizedLotteryEntries = await anonymizeLotteryParticipation(db, userId);
  await deleteUserTicketExtras(db, userId);
  await removeAccountRelationships(db, userId);

  if (authRecord) {
    await admin.auth().deleteUser(userId);
  }

  const usernameDocs = await db.collection('usernames').where('uid', '==', userId).get();
  await commitDeletes(db, usernameDocs.docs.map((doc) => doc.ref));
  await db.collection('users_public').doc(userId).delete().catch(() => undefined);
  await db.recursiveDelete(userRef);

  return {
    ok: true,
    userId,
    deletedPosts: posts.count,
    deletedComments: authored.comments,
    deletedReplies: authored.replies,
    anonymizedLotteryEntries,
    mediaCleanupFailures: posts.mediaCleanupFailures,
    accountAlreadyMissing: !authRecord
  };
};
