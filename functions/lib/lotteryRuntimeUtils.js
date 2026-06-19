"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.drawLotteryWinnerInternal = exports.enterLotteryInternal = void 0;
const admin = require("firebase-admin");
const functions = require("firebase-functions");
const lotteryUtils_1 = require("./lotteryUtils");
const userUtils_1 = require("./userUtils");
const moduleUtils_1 = require("./moduleUtils");
const notificationRuntimeUtils_1 = require("./notificationRuntimeUtils");
const enterLotteryInternal = async (db, data, context) => {
    var _a, _b;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para participar en la loteria.');
    }
    const lotteryId = typeof (data === null || data === void 0 ? void 0 : data.lotteryId) === 'string' ? data.lotteryId.trim() : '';
    const selectedNumber = (0, lotteryUtils_1.parseSelectedLotteryNumber)(data === null || data === void 0 ? void 0 : data.selectedNumber);
    const idempotencyKeyRaw = typeof (data === null || data === void 0 ? void 0 : data.idempotencyKey) === 'string'
        ? data.idempotencyKey.trim()
        : '';
    if (!lotteryId) {
        throw new functions.https.HttpsError('invalid-argument', 'lotteryId es obligatorio.');
    }
    if (selectedNumber == null) {
        throw new functions.https.HttpsError('invalid-argument', 'selectedNumber es obligatorio.');
    }
    await (0, lotteryUtils_1.ensureLotteryEntriesSchemaV2)(lotteryId);
    const userDocSnap = await db.collection('users').doc(userId).get();
    const userData = userDocSnap.data() || {};
    const userRecord = await admin.auth().getUser(userId);
    const providerIds = (userRecord.providerData || []).map((provider) => provider.providerId);
    const hasSocialAccount = providerIds.includes('google.com') || providerIds.includes('facebook.com');
    const isVerifiedUser = userData.isVerified === true;
    const token = (((_b = context.auth) === null || _b === void 0 ? void 0 : _b.token) || {});
    const fallbackEmail = typeof token.email === 'string' ? token.email : '';
    const fallbackName = fallbackEmail ? fallbackEmail.split('@')[0] : 'Usuario';
    const userNameRaw = typeof userData.nombre === 'string' ? userData.nombre : fallbackName;
    const userProfilePicRaw = typeof userData.profilePictureUrl === 'string'
        ? userData.profilePictureUrl
        : '';
    const userUsernameRaw = typeof userData.username === 'string' ? userData.username : '';
    const userName = userNameRaw.trim().slice(0, 120) || 'Usuario';
    const userUsername = userUsernameRaw.trim().slice(0, 30);
    const userProfilePicUrl = userProfilePicRaw.trim();
    const modulesConfigRef = db.collection('_config').doc('modules');
    const lotteryRef = db.collection('lotteries').doc(lotteryId);
    const entryRef = lotteryRef.collection('entries').doc((0, lotteryUtils_1.toLotteryEntryDocId)(selectedNumber));
    const extraTicketsRef = db
        .collection(lotteryUtils_1.LOTTERY_USER_EXTRA_TICKETS_COLLECTION)
        .doc((0, lotteryUtils_1.toLotteryUserExtraDocId)(lotteryId, userId));
    const userEntriesQuery = lotteryRef
        .collection('entries')
        .where('userId', '==', userId)
        .limit(lotteryUtils_1.LOTTERY_MAX_MAX_NUMBER + 2);
    const entryResult = await db.runTransaction(async (tx) => {
        var _a;
        const [modulesConfigSnap, lotterySnap, entrySnap, userEntriesSnap, extraTicketsSnap] = await Promise.all([
            tx.get(modulesConfigRef),
            tx.get(lotteryRef),
            tx.get(entryRef),
            tx.get(userEntriesQuery),
            tx.get(extraTicketsRef)
        ]);
        if (!(0, moduleUtils_1.isLotteryModuleEnabled)(modulesConfigSnap.data())) {
            throw new functions.https.HttpsError('failed-precondition', 'module-disabled: El modulo de loteria esta deshabilitado.');
        }
        if (!lotterySnap.exists) {
            throw new functions.https.HttpsError('not-found', 'La loteria no existe.');
        }
        const lotteryData = lotterySnap.data() || {};
        if (lotteryData.deletedAt != null) {
            throw new functions.https.HttpsError('failed-precondition', 'lottery-inactive: La loteria ya no esta disponible.');
        }
        const isFree = lotteryData.isFree !== false;
        if (isFree && !hasSocialAccount && !isVerifiedUser) {
            throw new functions.https.HttpsError('failed-precondition', 'unverified-account: Solo los usuarios con al menos una cuenta social vinculada y verificada (Google o Facebook) pueden participar en las loterias gratuitas.');
        }
        const lotteryStatus = (lotteryData.status || 'draft');
        if (lotteryStatus !== 'active') {
            throw new functions.https.HttpsError('failed-precondition', 'lottery-inactive: La loteria no esta activa.');
        }
        if (lotteryData.winner) {
            throw new functions.https.HttpsError('failed-precondition', 'lottery-inactive: La loteria ya tiene ganador.');
        }
        const nowMs = Date.now();
        const startsAt = lotteryData.startsAt instanceof admin.firestore.Timestamp
            ? lotteryData.startsAt.toMillis()
            : null;
        const endsAt = lotteryData.endsAt instanceof admin.firestore.Timestamp
            ? lotteryData.endsAt.toMillis()
            : null;
        if (startsAt != null && startsAt > nowMs) {
            throw new functions.https.HttpsError('failed-precondition', 'lottery-inactive: La loteria aun no inicio.');
        }
        if (endsAt != null && endsAt < nowMs) {
            throw new functions.https.HttpsError('failed-precondition', 'lottery-inactive: La loteria ya finalizo la etapa de participacion.');
        }
        const currentParticipantsRaw = Number(lotteryData.participantsCount || 0);
        const currentParticipants = Number.isFinite(currentParticipantsRaw)
            ? Math.max(0, Math.floor(currentParticipantsRaw))
            : 0;
        const maxNumber = (0, lotteryUtils_1.normalizeLotteryMaxNumber)(lotteryData.maxNumber);
        const maxTicketsPerUser = (0, lotteryUtils_1.normalizeLotteryMaxTicketsPerUser)(lotteryData.maxTicketsPerUser);
        const extraTickets = (0, lotteryUtils_1.normalizeLotteryExtraTickets)((_a = extraTicketsSnap.data()) === null || _a === void 0 ? void 0 : _a.extraTickets);
        const effectiveMaxTicketsPerUser = (0, lotteryUtils_1.getLotteryEffectiveMaxTickets)(maxTicketsPerUser, extraTickets, maxNumber);
        if (selectedNumber < 1 || selectedNumber > maxNumber) {
            throw new functions.https.HttpsError('failed-precondition', `out-of-range: Debes seleccionar un numero entre 1 y ${maxNumber}.`);
        }
        const userTicketsCount = userEntriesSnap.size;
        if (entrySnap.exists) {
            const existingEntry = entrySnap.data() || {};
            const entryOwner = typeof existingEntry.userId === 'string' ? existingEntry.userId : '';
            if (entryOwner === userId) {
                return {
                    status: 'already_selected',
                    lotteryId,
                    selectedNumber,
                    participantsCount: currentParticipants,
                    userTicketsCount: Math.max(1, userTicketsCount),
                    effectiveMaxTicketsPerUser
                };
            }
            throw new functions.https.HttpsError('already-exists', 'number-taken: El numero seleccionado ya esta ocupado.');
        }
        if (userTicketsCount >= effectiveMaxTicketsPerUser) {
            throw new functions.https.HttpsError('failed-precondition', `limit-reached: Alcanzaste el maximo de ${effectiveMaxTicketsPerUser} numeros para esta loteria.`);
        }
        const entryPayload = {
            userId,
            userName,
            userUsername,
            userProfilePicUrl,
            lotteryId,
            selectedNumber,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (idempotencyKeyRaw) {
            entryPayload.idempotencyKey = idempotencyKeyRaw.slice(0, 120);
        }
        tx.set(entryRef, entryPayload);
        tx.set(lotteryRef, {
            participantsCount: admin.firestore.FieldValue.increment(1),
            maxNumber,
            maxTicketsPerUser,
            entrySchemaVersion: lotteryUtils_1.LOTTERY_ENTRY_SCHEMA_VERSION,
            migrationStatus: 'done',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return {
            status: 'ok',
            lotteryId,
            selectedNumber,
            participantsCount: currentParticipants + 1,
            userTicketsCount: userTicketsCount + 1,
            effectiveMaxTicketsPerUser
        };
    });
    if (entryResult.status === 'ok') {
        (0, lotteryUtils_1.publishLotteryBallToOBS)(entryResult.selectedNumber, userName, userProfilePicUrl);
    }
    return entryResult;
};
exports.enterLotteryInternal = enterLotteryInternal;
const drawLotteryWinnerInternal = async (db, data, context) => {
    var _a;
    await (0, userUtils_1.assertStaffUser)(db, context.auth);
    const lotteryId = typeof (data === null || data === void 0 ? void 0 : data.lotteryId) === 'string' ? data.lotteryId.trim() : '';
    if (!lotteryId) {
        throw new functions.https.HttpsError('invalid-argument', 'lotteryId es obligatorio.');
    }
    await (0, lotteryUtils_1.ensureLotteryEntriesSchemaV2)(lotteryId);
    const requesterUid = ((_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid) || 'system';
    const modulesConfigRef = db.collection('_config').doc('modules');
    const lotteryRef = db.collection('lotteries').doc(lotteryId);
    const result = await db.runTransaction(async (tx) => {
        const [modulesConfigSnap, lotterySnap] = await Promise.all([
            tx.get(modulesConfigRef),
            tx.get(lotteryRef)
        ]);
        if (!(0, moduleUtils_1.isLotteryModuleEnabled)(modulesConfigSnap.data())) {
            throw new functions.https.HttpsError('failed-precondition', 'El modulo de loteria esta deshabilitado.');
        }
        if (!lotterySnap.exists) {
            throw new functions.https.HttpsError('not-found', 'La loteria no existe.');
        }
        const lotteryData = lotterySnap.data() || {};
        if (lotteryData.deletedAt != null) {
            throw new functions.https.HttpsError('failed-precondition', 'La loteria ya no esta disponible.');
        }
        if (lotteryData.winner) {
            throw new functions.https.HttpsError('failed-precondition', 'La loteria ya tiene ganador.');
        }
        const lotteryStatus = (lotteryData.status || 'draft');
        if (lotteryStatus !== 'closed') {
            throw new functions.https.HttpsError('failed-precondition', 'La loteria debe estar cerrada antes de sortear ganador.');
        }
        const entriesQuery = lotteryRef
            .collection('entries')
            .orderBy('selectedNumber', 'asc')
            .limit(lotteryUtils_1.MAX_LOTTERY_DRAW_ENTRIES);
        const entriesSnap = await tx.get(entriesQuery);
        if (entriesSnap.empty) {
            throw new functions.https.HttpsError('failed-precondition', 'No hay participantes para sortear.');
        }
        const randomIndex = Math.floor(Math.random() * entriesSnap.docs.length);
        const winnerDoc = entriesSnap.docs[randomIndex];
        const winnerData = winnerDoc.data() || {};
        const winnerUserId = typeof winnerData.userId === 'string' ? winnerData.userId : winnerDoc.id;
        const winnerUserName = typeof winnerData.userName === 'string'
            ? winnerData.userName
            : 'Usuario';
        const winnerProfilePic = typeof winnerData.userProfilePicUrl === 'string'
            ? winnerData.userProfilePicUrl
            : '';
        const winnerSelectedNumber = (0, lotteryUtils_1.parseSelectedLotteryNumber)(winnerData.selectedNumber) || null;
        const participantsRaw = Number(lotteryData.participantsCount || 0);
        const participantsCount = Number.isFinite(participantsRaw)
            ? Math.max(0, Math.floor(participantsRaw))
            : entriesSnap.docs.length;
        tx.set(lotteryRef, {
            status: 'completed',
            winner: {
                userId: winnerUserId,
                userName: winnerUserName,
                userProfilePicUrl: winnerProfilePic,
                selectedNumber: winnerSelectedNumber,
                selectedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            updatedBy: requesterUid,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return {
            status: 'ok',
            lotteryId,
            winner: {
                userId: winnerUserId,
                userName: winnerUserName,
                userProfilePicUrl: winnerProfilePic,
                selectedNumber: winnerSelectedNumber
            },
            participantsCount,
            lotteryTitle: lotteryData.title || lotteryData.nombre || 'Sorteo',
            hasPremio: lotteryData.hasPremio !== false,
            premioType: lotteryData.premioType || 'dinero',
            premioDinero: typeof lotteryData.premioDinero === 'number' ? lotteryData.premioDinero : null,
            premioOtros: typeof lotteryData.premioOtros === 'string' ? lotteryData.premioOtros : ''
        };
    });
    try {
        const winnerUserId = String(result.winner.userId);
        const lotteryTitle = String(result.lotteryTitle);
        const winnerSelectedNumber = result.winner.selectedNumber;
        let premioMsg = '';
        if (result.hasPremio) {
            if (result.premioType === 'dinero' && result.premioDinero !== null) {
                premioMsg = `un premio de $${result.premioDinero} ARS`;
            }
            else if (result.premioType === 'otros' && result.premioOtros) {
                premioMsg = `el premio "${result.premioOtros}"`;
            }
            else {
                premioMsg = 'el premio mayor';
            }
        }
        else {
            premioMsg = 'el premio mayor';
        }
        const systemMessage = `🏆 ¡Felicidades! Has ganado el sorteo "${lotteryTitle}" con el número #${winnerSelectedNumber}. Tu premio es ${premioMsg}.`;
        const notificationRef = db.collection('users')
            .doc(winnerUserId)
            .collection('notifications')
            .doc();
        await notificationRef.set({
            type: 'system',
            recipientUserId: winnerUserId,
            actorUserId: 'system',
            actorName: 'Sorteos Bot',
            actorUsername: 'system',
            actorProfilePictureUrl: 'https://bot.cdelu.io/images/logo.png',
            contentId: lotteryId,
            contentModule: '',
            contentPublicRef: '',
            contentSlug: '',
            commentId: '',
            replyId: '',
            targetPath: '/perfil',
            isRead: false,
            readAt: null,
            eventCount: 1,
            systemMessage,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastEventAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await (0, notificationRuntimeUtils_1.sendPushToNotificationDevices)(db, notificationRef, winnerUserId, 'system', 'Sorteos Bot', '/perfil').catch((err) => console.warn('Error sending winner push notification:', err));
    }
    catch (error) {
        console.error('Error recording winner notification:', error);
    }
    return {
        status: result.status,
        lotteryId: result.lotteryId,
        winner: result.winner,
        participantsCount: result.participantsCount
    };
};
exports.drawLotteryWinnerInternal = drawLotteryWinnerInternal;
//# sourceMappingURL=lotteryRuntimeUtils.js.map