import * as admin from 'firebase-admin';

export const buildCommentRef = (
  db: admin.firestore.Firestore,
  contentId: string,
  commentId: string
): admin.firestore.DocumentReference<admin.firestore.DocumentData> => {
  return db.collection('content').doc(contentId).collection('comments').doc(commentId);
};
