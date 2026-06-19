import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { normalizeLotteryExtraTickets, normalizeLotteryMaxNumber, normalizeLotteryMaxTicketsPerUser, getLotteryEffectiveMaxTickets, toLotteryUserExtraDocId, LOTTERY_MAX_EXTRA_TICKETS_PER_USER, LOTTERY_USER_EXTRA_TICKETS_COLLECTION } from './lotteryUtils';
import { assertAdminUser, sanitizeBoundedString } from './userUtils';

export const getLotteryUserTicketExtrasInternal = async (
  db: FirebaseFirestore.Firestore,
  data: any,
  context: functions.https.CallableContext
): Promise<{ ok: true; userId: string; records: Record<string, number> }> => {
  const requesterUid = context.auth?.uid || '';
  if (!requesterUid) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para consultar tickets extra.'
    );
  }

  const requestedUserId = sanitizeBoundedString(data?.userId, 128);
  const targetUserId = requestedUserId || requesterUid;
  if (targetUserId !== requesterUid) {
    await assertAdminUser(db, context.auth);
  }

  const snapshot = await db
    .collection(LOTTERY_USER_EXTRA_TICKETS_COLLECTION)
    .where('userId', '==', targetUserId)
    .limit(400)
    .get();

  const records: Record<string, number> = {};
  for (const docSnap of snapshot.docs) {
    const row = docSnap.data() || {};
    const lotteryId = sanitizeBoundedString(row.lotteryId, 128);
    if (!lotteryId) continue;
    const extraTickets = normalizeLotteryExtraTickets(row.extraTickets);
    if (extraTickets <= 0) continue;
    records[lotteryId] = extraTickets;
  }

  return {
    ok: true,
    userId: targetUserId,
    records
  };
};

export const listLotteriesForAdminInternal = async (
  db: FirebaseFirestore.Firestore,
  context: functions.https.CallableContext
): Promise<{ ok: true; lotteries: Array<{ id: string; title: string; status: string; maxNumber: number; maxTicketsPerUser: number }> }> => {
  await assertAdminUser(db, context.auth);

  const snapshot = await db
    .collection('lotteries')
    .where('deletedAt', '==', null)
    .orderBy('createdAt', 'desc')
    .limit(300)
    .get();

  const lotteries = snapshot.docs.map((lotteryDoc) => {
    const row = lotteryDoc.data() || {};
    return {
      id: lotteryDoc.id,
      title: sanitizeBoundedString(row.title, 150) || '(Sin titulo)',
      status: sanitizeBoundedString(row.status, 40) || 'draft',
      maxNumber: normalizeLotteryMaxNumber(row.maxNumber),
      maxTicketsPerUser: normalizeLotteryMaxTicketsPerUser(row.maxTicketsPerUser)
    };
  });

  return {
    ok: true,
    lotteries
  };
};

export const grantLotteryUserExtraTicketsInternal = async (
  db: FirebaseFirestore.Firestore,
  data: any,
  context: functions.https.CallableContext
): Promise<Record<string, unknown>> => {
  await assertAdminUser(db, context.auth);

  const adminUid = context.auth?.uid || 'system';
  const adminEmail = sanitizeBoundedString((context.auth?.token || {}).email, 320).toLowerCase();
  const userId = sanitizeBoundedString(data?.userId, 128);
  const lotteryId = sanitizeBoundedString(data?.lotteryId, 128);
  const quantity = Math.max(1, Math.min(Math.floor(Number(data?.quantity || 1)), LOTTERY_MAX_EXTRA_TICKETS_PER_USER));

  if (!userId) {
    throw new functions.https.HttpsError('invalid-argument', 'userId es obligatorio.');
  }
  if (!lotteryId) {
    throw new functions.https.HttpsError('invalid-argument', 'lotteryId es obligatorio.');
  }

  const userRef = db.collection('users').doc(userId);
  const lotteryRef = db.collection('lotteries').doc(lotteryId);
  const extraRef = db
    .collection(LOTTERY_USER_EXTRA_TICKETS_COLLECTION)
    .doc(toLotteryUserExtraDocId(lotteryId, userId));

  return db.runTransaction(async (tx) => {
    const [userSnap, lotterySnap, extraSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(lotteryRef),
      tx.get(extraRef)
    ]);

    if (!userSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Usuario no encontrado.');
    }
    if (!lotterySnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Loteria no encontrada.');
    }

    const lotteryData = lotterySnap.data() || {};
    if (lotteryData.deletedAt != null) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'No se pueden asignar tickets extra en una loteria eliminada.'
      );
    }

    const currentExtra = normalizeLotteryExtraTickets(extraSnap.data()?.extraTickets);
    const nextExtra = normalizeLotteryExtraTickets(currentExtra + quantity);
    if (nextExtra === currentExtra) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'No se puede aumentar mas el cupo de tickets extra para este usuario.'
      );
    }

    const maxNumber = normalizeLotteryMaxNumber(lotteryData.maxNumber);
    const baseLimit = normalizeLotteryMaxTicketsPerUser(lotteryData.maxTicketsPerUser);
    const effectiveLimit = getLotteryEffectiveMaxTickets(baseLimit, nextExtra, maxNumber);
    const lotteryTitle = sanitizeBoundedString(lotteryData.title, 150) || 'Loteria';

    const payload: Record<string, unknown> = {
      userId,
      lotteryId,
      extraTickets: nextExtra,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: adminUid,
      updatedByEmail: adminEmail
    };
    if (!extraSnap.exists) {
      payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    tx.set(extraRef, payload, { merge: true });

    const notificationRef = db.collection('users').doc(userId).collection('notifications').doc();
    const notificationMessage = `Se te agregaron ${nextExtra - currentExtra} ticket(s) extra en la loteria "${lotteryTitle}".`;
    tx.set(notificationRef, {
      type: 'system',
      recipientUserId: userId,
      actorUserId: adminUid,
      actorName: 'Sistema',
      actorUsername: 'sistema',
      actorProfilePictureUrl: '',
      contentId: lotteryId,
      contentModule: 'community',
      contentPublicRef: '',
      contentSlug: '',
      commentId: '',
      replyId: '',
      targetPath: '/loteria',
      systemMessage: notificationMessage,
      eventCount: 1,
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastEventAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      ok: true,
      userId,
      lotteryId,
      added: nextExtra - currentExtra,
      extraTickets: nextExtra,
      baseLimit,
      effectiveLimit
    };
  });
};
