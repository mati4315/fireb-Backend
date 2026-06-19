import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { cleanupCommunityPostHostingMedia } from './hostingUtils';

export const onContentCreatedInternal = async (
  db: FirebaseFirestore.Firestore,
  snap: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>
): Promise<void> => {
  const contentData = snap.data();
  if (!contentData) return;

  const isCommunityPost =
    contentData.module === 'community' || contentData.type === 'post';
  if (!isCommunityPost || !contentData.userId) return;

  try {
    await db.collection('users').doc(contentData.userId).update({
      'stats.postsCount': admin.firestore.FieldValue.increment(1)
    });
  } catch (error) {
    console.error(`Error incrementing postsCount for content create:`, error);
  }
};

export const onContentDeletedInternal = async (
  db: FirebaseFirestore.Firestore,
  change: functions.Change<FirebaseFirestore.DocumentSnapshot<FirebaseFirestore.DocumentData>>,
  context: functions.EventContext
): Promise<void> => {
  const { contentId } = context.params as { contentId: string };
  const beforeData = change.before.data();
  const afterData = change.after.data();

  const isCommunityPost =
    afterData?.module === 'community' || afterData?.type === 'post';
  if (!isCommunityPost || !afterData?.userId) return;

  try {
    const wasAlive = beforeData?.deletedAt == null;
    const isNowDeleted = afterData.deletedAt != null;

    if (wasAlive && isNowDeleted) {
      try {
        await cleanupCommunityPostHostingMedia(afterData);
        console.log(`Community media deleted for ${contentId}`);
      } catch (mediaError) {
        console.error(`Failed to delete community media for ${contentId}:`, mediaError);
      }

      const userId = afterData.userId;
      await db.collection('users').doc(userId).update({
        'stats.postsCount': admin.firestore.FieldValue.increment(-1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`Content soft-deleted: ${contentId}, postsCount decremented`);
    } else if (!wasAlive && !isNowDeleted) {
      const userId = afterData.userId;
      await db.collection('users').doc(userId).update({
        'stats.postsCount': admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`Content restored: ${contentId}, postsCount incremented`);
    }
  } catch (error) {
    console.error(`Content deletion handling failed:`, error);
  }
};
