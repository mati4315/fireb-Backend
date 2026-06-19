"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.grantLotteryUserExtraTicketsInternal = exports.listLotteriesForAdminInternal = exports.getLotteryUserTicketExtrasInternal = void 0;
const admin = require("firebase-admin");
const functions = require("firebase-functions");
const lotteryUtils_1 = require("./lotteryUtils");
const userUtils_1 = require("./userUtils");
const getLotteryUserTicketExtrasInternal = async (db, data, context) => {
    var _a;
    const requesterUid = ((_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid) || '';
    if (!requesterUid) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para consultar tickets extra.');
    }
    const requestedUserId = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.userId, 128);
    const targetUserId = requestedUserId || requesterUid;
    if (targetUserId !== requesterUid) {
        await (0, userUtils_1.assertAdminUser)(db, context.auth);
    }
    const snapshot = await db
        .collection(lotteryUtils_1.LOTTERY_USER_EXTRA_TICKETS_COLLECTION)
        .where('userId', '==', targetUserId)
        .limit(400)
        .get();
    const records = {};
    for (const docSnap of snapshot.docs) {
        const row = docSnap.data() || {};
        const lotteryId = (0, userUtils_1.sanitizeBoundedString)(row.lotteryId, 128);
        if (!lotteryId)
            continue;
        const extraTickets = (0, lotteryUtils_1.normalizeLotteryExtraTickets)(row.extraTickets);
        if (extraTickets <= 0)
            continue;
        records[lotteryId] = extraTickets;
    }
    return {
        ok: true,
        userId: targetUserId,
        records
    };
};
exports.getLotteryUserTicketExtrasInternal = getLotteryUserTicketExtrasInternal;
const listLotteriesForAdminInternal = async (db, context) => {
    await (0, userUtils_1.assertAdminUser)(db, context.auth);
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
            title: (0, userUtils_1.sanitizeBoundedString)(row.title, 150) || '(Sin titulo)',
            status: (0, userUtils_1.sanitizeBoundedString)(row.status, 40) || 'draft',
            maxNumber: (0, lotteryUtils_1.normalizeLotteryMaxNumber)(row.maxNumber),
            maxTicketsPerUser: (0, lotteryUtils_1.normalizeLotteryMaxTicketsPerUser)(row.maxTicketsPerUser)
        };
    });
    return {
        ok: true,
        lotteries
    };
};
exports.listLotteriesForAdminInternal = listLotteriesForAdminInternal;
const grantLotteryUserExtraTicketsInternal = async (db, data, context) => {
    var _a, _b;
    await (0, userUtils_1.assertAdminUser)(db, context.auth);
    const adminUid = ((_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid) || 'system';
    const adminEmail = (0, userUtils_1.sanitizeBoundedString)((((_b = context.auth) === null || _b === void 0 ? void 0 : _b.token) || {}).email, 320).toLowerCase();
    const userId = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.userId, 128);
    const lotteryId = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.lotteryId, 128);
    const quantity = Math.max(1, Math.min(Math.floor(Number((data === null || data === void 0 ? void 0 : data.quantity) || 1)), lotteryUtils_1.LOTTERY_MAX_EXTRA_TICKETS_PER_USER));
    if (!userId) {
        throw new functions.https.HttpsError('invalid-argument', 'userId es obligatorio.');
    }
    if (!lotteryId) {
        throw new functions.https.HttpsError('invalid-argument', 'lotteryId es obligatorio.');
    }
    const userRef = db.collection('users').doc(userId);
    const lotteryRef = db.collection('lotteries').doc(lotteryId);
    const extraRef = db
        .collection(lotteryUtils_1.LOTTERY_USER_EXTRA_TICKETS_COLLECTION)
        .doc((0, lotteryUtils_1.toLotteryUserExtraDocId)(lotteryId, userId));
    return db.runTransaction(async (tx) => {
        var _a;
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
            throw new functions.https.HttpsError('failed-precondition', 'No se pueden asignar tickets extra en una loteria eliminada.');
        }
        const currentExtra = (0, lotteryUtils_1.normalizeLotteryExtraTickets)((_a = extraSnap.data()) === null || _a === void 0 ? void 0 : _a.extraTickets);
        const nextExtra = (0, lotteryUtils_1.normalizeLotteryExtraTickets)(currentExtra + quantity);
        if (nextExtra === currentExtra) {
            throw new functions.https.HttpsError('failed-precondition', 'No se puede aumentar mas el cupo de tickets extra para este usuario.');
        }
        const maxNumber = (0, lotteryUtils_1.normalizeLotteryMaxNumber)(lotteryData.maxNumber);
        const baseLimit = (0, lotteryUtils_1.normalizeLotteryMaxTicketsPerUser)(lotteryData.maxTicketsPerUser);
        const effectiveLimit = (0, lotteryUtils_1.getLotteryEffectiveMaxTickets)(baseLimit, nextExtra, maxNumber);
        const lotteryTitle = (0, userUtils_1.sanitizeBoundedString)(lotteryData.title, 150) || 'Loteria';
        const payload = {
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
exports.grantLotteryUserExtraTicketsInternal = grantLotteryUserExtraTicketsInternal;
//# sourceMappingURL=lotteryAdminRuntimeUtils.js.map