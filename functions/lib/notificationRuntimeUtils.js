"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeNotificationEvent = exports.unsubscribeTokenFromPushTopics = exports.subscribeTokenToPushTopics = exports.sendPushToNotificationDevices = exports.getNotificationRecipientData = exports.invalidateNotificationRecipientCache = exports.getModulesConfigData = exports.loadNotificationActorIdentity = exports.buildContentTargetFromDoc = void 0;
const admin = require("firebase-admin");
const notificationUtils_1 = require("./notificationUtils");
const userUtils_1 = require("./userUtils");
const contentUtils_1 = require("./contentUtils");
const NOTIFICATION_ACTOR_CACHE_TTL_MS = 60000;
const MODULES_CONFIG_CACHE_TTL_MS = 30000;
const NOTIFICATION_RECIPIENT_CACHE_TTL_MS = 20000;
const PERMANENT_FCM_TOKEN_ERROR_CODES = new Set([
    'messaging/invalid-registration-token',
    'messaging/registration-token-not-registered'
]);
const notificationActorCache = new Map();
const modulesConfigCache = new Map();
const notificationRecipientCache = new Map();
const buildContentTargetFromDoc = (contentId, contentData) => {
    const contentModule = (0, contentUtils_1.inferContentModule)(contentData);
    const contentSlug = (0, contentUtils_1.normalizeContentSlug)((contentData === null || contentData === void 0 ? void 0 : contentData.slug) || (contentData === null || contentData === void 0 ? void 0 : contentData.titulo) || contentId);
    const contentPublicRef = contentModule === 'news'
        ? ((0, contentUtils_1.extractNewsPublicIdFromPayload)(contentData) || contentId)
        : contentId;
    const targetPath = contentModule === 'news'
        ? `/noticia/${encodeURIComponent(contentPublicRef)}/${encodeURIComponent(contentSlug)}`
        : `/c/${encodeURIComponent(contentId)}/${encodeURIComponent(contentSlug)}`;
    return {
        contentId,
        contentModule,
        contentPublicRef,
        contentSlug,
        targetPath
    };
};
exports.buildContentTargetFromDoc = buildContentTargetFromDoc;
const loadNotificationActorIdentity = async (db, actorUserId) => {
    const now = Date.now();
    const cached = notificationActorCache.get(actorUserId);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }
    const userPublicSnap = await db.collection('users_public').doc(actorUserId).get();
    const sourceData = userPublicSnap.exists
        ? (userPublicSnap.data() || {})
        : (await db.collection('users').doc(actorUserId).get()).data() || {};
    const { usernameLower } = (0, userUtils_1.normalizeUsernameLoose)(actorUserId, sourceData);
    const actorName = (0, userUtils_1.sanitizeBoundedString)(sourceData === null || sourceData === void 0 ? void 0 : sourceData.nombre, 120) || 'Usuario';
    const actorProfilePictureUrl = (0, userUtils_1.sanitizeBoundedString)(sourceData === null || sourceData === void 0 ? void 0 : sourceData.profilePictureUrl, 1200);
    const value = {
        userId: actorUserId,
        actorName,
        actorUsername: usernameLower,
        actorProfilePictureUrl
    };
    notificationActorCache.set(actorUserId, {
        expiresAt: now + NOTIFICATION_ACTOR_CACHE_TTL_MS,
        value
    });
    return value;
};
exports.loadNotificationActorIdentity = loadNotificationActorIdentity;
const getModulesConfigData = async (db) => {
    const now = Date.now();
    const cacheKey = 'modules';
    const cached = modulesConfigCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }
    const snap = await db.collection('_config').doc('modules').get();
    const value = snap.data();
    modulesConfigCache.set(cacheKey, {
        expiresAt: now + MODULES_CONFIG_CACHE_TTL_MS,
        value
    });
    return value;
};
exports.getModulesConfigData = getModulesConfigData;
const invalidateNotificationRecipientCache = (userId) => {
    notificationRecipientCache.delete(userId);
};
exports.invalidateNotificationRecipientCache = invalidateNotificationRecipientCache;
const getNotificationRecipientData = async (db, userId) => {
    var _a;
    const now = Date.now();
    const cached = notificationRecipientCache.get(userId);
    if (cached && cached.expiresAt > now) {
        return cached;
    }
    const snap = await db.collection('users').doc(userId).get();
    const entry = {
        expiresAt: now + NOTIFICATION_RECIPIENT_CACHE_TTL_MS,
        exists: snap.exists,
        settings: snap.exists ? (((_a = snap.data()) === null || _a === void 0 ? void 0 : _a.settings) || null) : null
    };
    notificationRecipientCache.set(userId, entry);
    return entry;
};
exports.getNotificationRecipientData = getNotificationRecipientData;
const sendPushToNotificationDevices = async (db, notificationRef, recipientUserId, notificationType, actorName, targetPath) => {
    var _a;
    const devicesSnap = await db.collection('users')
        .doc(recipientUserId)
        .collection('notification_devices')
        .where('enabled', '==', true)
        .get();
    if (devicesSnap.empty)
        return;
    const tokenToDeviceRefs = new Map();
    const uniqueTokens = [];
    for (const deviceDoc of devicesSnap.docs) {
        const token = (0, userUtils_1.sanitizeBoundedString)((_a = deviceDoc.data()) === null || _a === void 0 ? void 0 : _a.token, 4096);
        if (!token)
            continue;
        const existing = tokenToDeviceRefs.get(token) || [];
        existing.push(deviceDoc.ref);
        tokenToDeviceRefs.set(token, existing);
        if (existing.length === 1)
            uniqueTokens.push(token);
    }
    if (uniqueTokens.length === 0)
        return;
    let title = '';
    let body = '';
    if (notificationType === 'system') {
        const snap = await notificationRef.get();
        const docData = snap.data() || {};
        title = 'Sorteo Ganado! ðŸ†';
        body = typeof docData.systemMessage === 'string' && docData.systemMessage ? docData.systemMessage : 'Felicidades! Has ganado un sorteo.';
    }
    else {
        const pushText = (0, notificationUtils_1.buildPushTextForNotification)(notificationType, actorName);
        title = pushText.title;
        body = pushText.body;
    }
    const sendResult = await admin.messaging().sendEachForMulticast({
        tokens: uniqueTokens,
        notification: {
            title,
            body
        },
        data: {
            notificationId: notificationRef.id,
            type: notificationType,
            targetPath
        },
        android: {
            priority: 'high',
            notification: {
                channelId: notificationUtils_1.ANDROID_PUSH_CHANNEL_ID,
                sound: 'default',
                clickAction: 'FLUTTER_NOTIFICATION_CLICK'
            }
        },
        webpush: {
            fcmOptions: {
                link: targetPath
            }
        }
    });
    const refsToDelete = [];
    sendResult.responses.forEach((response, index) => {
        var _a;
        if (response.success)
            return;
        const code = String(((_a = response.error) === null || _a === void 0 ? void 0 : _a.code) || '');
        if (!PERMANENT_FCM_TOKEN_ERROR_CODES.has(code))
            return;
        const token = uniqueTokens[index];
        const linkedRefs = tokenToDeviceRefs.get(token) || [];
        refsToDelete.push(...linkedRefs);
    });
    if (refsToDelete.length === 0)
        return;
    const batch = db.batch();
    for (const ref of refsToDelete) {
        batch.delete(ref);
    }
    await batch.commit();
};
exports.sendPushToNotificationDevices = sendPushToNotificationDevices;
const subscribeTokenToPushTopics = async (token, platform) => {
    const topics = (0, notificationUtils_1.getNotificationTopicsForPlatform)(platform);
    await Promise.all(topics.map(async (topic) => {
        try {
            await admin.messaging().subscribeToTopic([token], topic);
        }
        catch (error) {
            console.warn(`No se pudo suscribir token a topic ${topic}:`, error);
        }
    }));
};
exports.subscribeTokenToPushTopics = subscribeTokenToPushTopics;
const unsubscribeTokenFromPushTopics = async (token, platform) => {
    const topics = (0, notificationUtils_1.getNotificationTopicsForPlatform)(platform);
    await Promise.all(topics.map(async (topic) => {
        try {
            await admin.messaging().unsubscribeFromTopic([token], topic);
        }
        catch (error) {
            console.warn(`No se pudo desuscribir token de topic ${topic}:`, error);
        }
    }));
};
exports.unsubscribeTokenFromPushTopics = unsubscribeTokenFromPushTopics;
const writeNotificationEvent = async (db, input) => {
    var _a, _b, _c, _d, _e, _f;
    if (input.recipientUserId === input.actor.userId)
        return;
    const [modulesConfigData, recipientData] = await Promise.all([
        (0, exports.getModulesConfigData)(db),
        (0, exports.getNotificationRecipientData)(db, input.recipientUserId)
    ]);
    if (!((_b = (_a = modulesConfigData === null || modulesConfigData === void 0 ? void 0 : modulesConfigData.notifications) === null || _a === void 0 ? void 0 : _a.enabled) !== null && _b !== void 0 ? _b : true))
        return;
    if (!recipientData.exists)
        return;
    const recipientSettings = (0, userUtils_1.ensureUserSettings)(recipientData.settings);
    const notificationsEnabled = recipientSettings.notificationsEnabled !== false;
    if (!notificationsEnabled)
        return;
    const typeSettings = (0, userUtils_1.ensureNotificationTypeSettings)(recipientSettings.notificationTypes);
    if (!(0, userUtils_1.isNotificationTypeEnabled)(typeSettings, input.type))
        return;
    const notificationsCollection = db.collection('users')
        .doc(input.recipientUserId)
        .collection('notifications');
    const notificationRef = input.notificationId
        ? notificationsCollection.doc(input.notificationId)
        : notificationsCollection.doc();
    if (input.notificationId) {
        await db.runTransaction(async (tx) => {
            var _a, _b, _c, _d, _e;
            const existingSnap = await tx.get(notificationRef);
            const existingData = existingSnap.data() || {};
            const currentCountRaw = Number((_a = existingData.eventCount) !== null && _a !== void 0 ? _a : 1);
            const currentCount = Number.isFinite(currentCountRaw) ? Math.max(1, Math.floor(currentCountRaw)) : 1;
            tx.set(notificationRef, {
                type: input.type,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actor.userId,
                actorName: input.actor.actorName,
                actorUsername: input.actor.actorUsername,
                actorProfilePictureUrl: input.actor.actorProfilePictureUrl,
                contentId: ((_b = input.contentTarget) === null || _b === void 0 ? void 0 : _b.contentId) || '',
                contentModule: ((_c = input.contentTarget) === null || _c === void 0 ? void 0 : _c.contentModule) || '',
                contentPublicRef: ((_d = input.contentTarget) === null || _d === void 0 ? void 0 : _d.contentPublicRef) || '',
                contentSlug: ((_e = input.contentTarget) === null || _e === void 0 ? void 0 : _e.contentSlug) || '',
                commentId: input.commentId || '',
                replyId: input.replyId || '',
                targetPath: (0, notificationUtils_1.safeNotificationPath)(input.targetPath, '/notificaciones'),
                isRead: false,
                readAt: null,
                eventCount: existingSnap.exists ? currentCount + 1 : 1,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                lastEventAt: admin.firestore.FieldValue.serverTimestamp(),
                createdAt: existingSnap.exists
                    ? (existingData.createdAt || admin.firestore.FieldValue.serverTimestamp())
                    : admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });
    }
    else {
        await notificationRef.set({
            type: input.type,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actor.userId,
            actorName: input.actor.actorName,
            actorUsername: input.actor.actorUsername,
            actorProfilePictureUrl: input.actor.actorProfilePictureUrl,
            contentId: ((_c = input.contentTarget) === null || _c === void 0 ? void 0 : _c.contentId) || '',
            contentModule: ((_d = input.contentTarget) === null || _d === void 0 ? void 0 : _d.contentModule) || '',
            contentPublicRef: ((_e = input.contentTarget) === null || _e === void 0 ? void 0 : _e.contentPublicRef) || '',
            contentSlug: ((_f = input.contentTarget) === null || _f === void 0 ? void 0 : _f.contentSlug) || '',
            commentId: input.commentId || '',
            replyId: input.replyId || '',
            targetPath: (0, notificationUtils_1.safeNotificationPath)(input.targetPath, '/notificaciones'),
            isRead: false,
            readAt: null,
            eventCount: 1,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastEventAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
    await (0, exports.sendPushToNotificationDevices)(db, notificationRef, input.recipientUserId, input.type, input.actor.actorName, (0, notificationUtils_1.safeNotificationPath)(input.targetPath, '/notificaciones'));
};
exports.writeNotificationEvent = writeNotificationEvent;
//# sourceMappingURL=notificationRuntimeUtils.js.map