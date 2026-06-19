"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onAdEventCreated = exports.purgeOldNotifications = exports.completeExpiredSurveys = exports.submitSurveyVote = exports.drawLotteryWinner = exports.enterLottery = exports.uploadCommunityImageToHosting = exports.onCommunityPostImageFinalized = exports.onCommunityPostsReceived = exports.onOfficialNewsReceived = exports.onContentDeleted = exports.onContentCreated = exports.onContentSlugSync = exports.onUserUpdated = exports.syncPublicUserProfile = exports.grantLotteryUserExtraTickets = exports.listLotteriesForAdmin = exports.getLotteryUserTicketExtras = exports.getUsersSocialConnections = exports.updateUserManagement = exports.markAllNotificationsRead = exports.markNotificationRead = exports.sendTestPushToAllUsers = exports.unregisterNotificationDevice = exports.registerNotificationDevice = exports.updateHomeFeedPreference = exports.updateNotificationPreferences = exports.updateMyProfile = exports.onFollowRemoved = exports.onFollowAdded = exports.onReplyUpdated = exports.onReplyCreated = exports.onCommentUpdated = exports.onCommentCreated = exports.refreshSecretRankings = exports.refreshSecretRankingsCallable = exports.moderateSecretCallable = exports.getSecretModerationQueueCallable = exports.reportSecretCallable = exports.createSecretCommentCallable = exports.voteSecretCallable = exports.createSecretCallable = exports.toggleContentLike = exports.onLikeRemoved = exports.onLikeAdded = void 0;
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const contentUtils_1 = require("./contentUtils");
const notificationUtils_1 = require("./notificationUtils");
const secretUtils_1 = require("./secretUtils");
const lotteryUtils_1 = require("./lotteryUtils");
const userUtils_1 = require("./userUtils");
const moduleUtils_1 = require("./moduleUtils");
const hostingUtils_1 = require("./hostingUtils");
const commentUtils_1 = require("./commentUtils");
const contentRuntimeUtils_1 = require("./contentRuntimeUtils");
const contentImageRuntimeUtils_1 = require("./contentImageRuntimeUtils");
const contentSyncRuntimeUtils_1 = require("./contentSyncRuntimeUtils");
const surveyRuntimeUtils_1 = require("./surveyRuntimeUtils");
const adRuntimeUtils_1 = require("./adRuntimeUtils");
const lotteryAdminRuntimeUtils_1 = require("./lotteryAdminRuntimeUtils");
const userAdminRuntimeUtils_1 = require("./userAdminRuntimeUtils");
const lotteryRuntimeUtils_1 = require("./lotteryRuntimeUtils");
const notificationRuntimeUtils_1 = require("./notificationRuntimeUtils");
const notificationRuntimeUtils_2 = require("./notificationRuntimeUtils");
admin.initializeApp();
const db = admin.firestore();
const LIKE_WRITER_CALLABLE = 'callable_toggle_v1';
const COMMUNITY_THUMBNAIL_BUCKET = process.env.COMMUNITY_IMAGES_BUCKET || 'cdeluar-ddefc-storage';
const CONTENT_SLUG_MAX_LENGTH = 96;
const NOTIFICATION_PAGE_SIZE = 300;
const NOTIFICATION_RETENTION_DAYS = 30;
const NOTIFICATION_DEVICE_ID_MAX_LENGTH = 120;
// 1. Likes
exports.onLikeAdded = functions.firestore
    .document('content/{contentId}/likes/{userId}')
    .onCreate(async (snap, context) => {
    const { contentId, userId: actorUserId } = context.params;
    const likeData = snap.data() || {};
    try {
        const contentRef = db.collection('content').doc(contentId);
        const contentSnap = await contentRef.get();
        if (!contentSnap.exists)
            return;
        const contentData = contentSnap.data() || {};
        if (contentData.deletedAt != null)
            return;
        if (likeData.writer !== LIKE_WRITER_CALLABLE) {
            await contentRef.update({
                'stats.likesCount': admin.firestore.FieldValue.increment(1),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        const recipientUserId = (0, userUtils_1.sanitizeBoundedString)(contentData.userId, 128);
        if (!recipientUserId)
            return;
        const actor = await (0, notificationRuntimeUtils_1.loadNotificationActorIdentity)(db, actorUserId);
        const contentTarget = (0, notificationRuntimeUtils_1.buildContentTargetFromDoc)(contentId, contentData);
        await (0, notificationRuntimeUtils_1.writeNotificationEvent)(db, {
            type: 'like',
            recipientUserId,
            actor,
            notificationId: `like_${actorUserId}_${contentId}`,
            contentTarget,
            targetPath: contentTarget.targetPath
        });
        console.log(`âœ… Like +1 for ${contentId}`);
    }
    catch (error) {
        console.error(`âŒ Like increment failed: ${contentId}`, error);
    }
});
exports.onLikeRemoved = functions.firestore
    .document('content/{contentId}/likes/{userId}')
    .onDelete(async (snap, context) => {
    const { contentId } = context.params;
    const likeData = snap.data() || {};
    if (likeData.writer === LIKE_WRITER_CALLABLE)
        return;
    try {
        await db.collection('content').doc(contentId).update({
            'stats.likesCount': admin.firestore.FieldValue.increment(-1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
    catch (error) {
        console.error(`âŒ Like decrement failed`, error);
    }
});
exports.toggleContentLike = functions.https.onCall(async (data, context) => {
    var _a;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para dar me gusta.');
    }
    const contentId = typeof (data === null || data === void 0 ? void 0 : data.contentId) === 'string' ? data.contentId.trim() : '';
    if (!contentId) {
        throw new functions.https.HttpsError('invalid-argument', 'contentId es obligatorio.');
    }
    const contentRef = db.collection('content').doc(contentId);
    const likeRef = contentRef.collection('likes').doc(userId);
    const modulesConfigRef = db.collection('_config').doc('modules');
    return db.runTransaction(async (tx) => {
        const [modulesConfigSnap, contentSnap, likeSnap] = await Promise.all([
            tx.get(modulesConfigRef),
            tx.get(contentRef),
            tx.get(likeRef)
        ]);
        if (!contentSnap.exists) {
            throw new functions.https.HttpsError('not-found', 'El contenido no existe.');
        }
        const contentData = contentSnap.data() || {};
        if (contentData.deletedAt != null) {
            throw new functions.https.HttpsError('failed-precondition', 'No puedes dar me gusta a contenido eliminado.');
        }
        const moduleName = (0, contentUtils_1.inferContentModule)(contentData);
        const isEnabled = (0, moduleUtils_1.isLikeModuleEnabledForContent)(modulesConfigSnap.data(), moduleName);
        if (!isEnabled) {
            throw new functions.https.HttpsError('failed-precondition', 'Los me gusta estan deshabilitados para este modulo.');
        }
        if (likeSnap.exists) {
            const existingLike = likeSnap.data() || {};
            tx.delete(likeRef);
            // Legacy likes (sin writer callable) mantienen compatibilidad via trigger.
            if (existingLike.writer === LIKE_WRITER_CALLABLE) {
                tx.set(contentRef, {
                    stats: {
                        likesCount: admin.firestore.FieldValue.increment(-1)
                    },
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            }
            return {
                status: 'ok',
                liked: false,
                contentId
            };
        }
        tx.set(likeRef, {
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            writer: LIKE_WRITER_CALLABLE
        });
        tx.set(contentRef, {
            stats: {
                likesCount: admin.firestore.FieldValue.increment(1)
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return {
            status: 'ok',
            liked: true,
            contentId
        };
    });
});
// 2. Secrets
exports.createSecretCallable = functions.https.onCall(async (data, context) => {
    const textRaw = (0, secretUtils_1.sanitizeSecretText)(data === null || data === void 0 ? void 0 : data.text, secretUtils_1.SECRET_TEXT_MAX_ABSOLUTE);
    const sex = (0, secretUtils_1.normalizeSecretSex)(data === null || data === void 0 ? void 0 : data.sex);
    const age = (0, secretUtils_1.normalizeSecretAge)(data === null || data === void 0 ? void 0 : data.age);
    const category = (0, secretUtils_1.normalizeSecretCategory)(data === null || data === void 0 ? void 0 : data.category);
    const zone = (0, secretUtils_1.normalizeSecretZone)(data === null || data === void 0 ? void 0 : data.zone);
    const fingerprintHash = (0, secretUtils_1.buildSecretFingerprintHash)(data, context);
    const nowMs = Date.now();
    const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);
    const oneDayMs = 24 * 60 * 60 * 1000;
    const modulesConfigRef = db.collection('_config').doc('modules');
    const secretSettingsRef = db.collection('_config').doc('secret_settings');
    const secretCounterRef = db.collection('_counters').doc('secret_ids');
    const rateLimitRef = db.collection('secret_rate_limits').doc(fingerprintHash);
    const fingerprintRef = db.collection('secret_fingerprints').doc(fingerprintHash);
    return db.runTransaction(async (tx) => {
        var _a, _b;
        const [modulesConfigSnap, secretSettingsSnap, secretCounterSnap, rateLimitSnap, fingerprintSnap] = await Promise.all([
            tx.get(modulesConfigRef),
            tx.get(secretSettingsRef),
            tx.get(secretCounterRef),
            tx.get(rateLimitRef),
            tx.get(fingerprintRef)
        ]);
        if (!(0, moduleUtils_1.isSecretsModuleEnabled)(modulesConfigSnap.data())) {
            throw new functions.https.HttpsError('failed-precondition', 'El modulo de secretos esta deshabilitado.');
        }
        const runtimeSettings = (0, secretUtils_1.resolveSecretRuntimeSettings)(secretSettingsSnap.data());
        const text = (0, secretUtils_1.sanitizeSecretText)(textRaw, runtimeSettings.maxTextLength);
        if (text.length < runtimeSettings.minTextLength) {
            throw new functions.https.HttpsError('invalid-argument', `El secreto debe tener al menos ${runtimeSettings.minTextLength} caracteres.`);
        }
        if (!(0, secretUtils_1.hasMeaningfulSecretText)(text)) {
            throw new functions.https.HttpsError('invalid-argument', 'Escribe un texto real, no solo emojis o simbolos.');
        }
        const rateLimitData = rateLimitSnap.data() || {};
        let burstWindowStartMs = (0, secretUtils_1.timestampToMillisOrZero)(rateLimitData.burstWindowStart);
        let burstCount = Number(rateLimitData.burstCount || 0);
        // Reiniciar ráfaga si ya pasó el tiempo
        if (!burstWindowStartMs || nowMs - burstWindowStartMs >= runtimeSettings.createCooldownMs) {
            burstWindowStartMs = nowMs;
            burstCount = 0;
        }
        if (burstCount >= 3) {
            const elapsed = nowMs - burstWindowStartMs;
            const remainingMin = Math.max(1, Math.ceil((runtimeSettings.createCooldownMs - elapsed) / (60 * 1000)));
            throw new functions.https.HttpsError('failed-precondition', `Has publicado demasiados secretos rapido. Espera ${remainingMin} min para publicar otro.`);
        }
        let dailyWindowStartMs = (0, secretUtils_1.timestampToMillisOrZero)(rateLimitData.dailyWindowStart);
        let dailyCount = Number(rateLimitData.dailyCount || 0);
        if (!dailyWindowStartMs || nowMs - dailyWindowStartMs >= oneDayMs) {
            dailyWindowStartMs = nowMs;
            dailyCount = 0;
        }
        if (dailyCount >= runtimeSettings.dailyLimit) {
            throw new functions.https.HttpsError('resource-exhausted', 'Alcanzaste el limite diario de secretos anonimos.');
        }
        const counterData = secretCounterSnap.data() || {};
        const lastIssuedId = Math.max(secretUtils_1.SECRET_NUMERIC_ID_START - 1, Math.floor(Number(counterData.lastIssuedId || 0)));
        let nextSecretNumericId = lastIssuedId + 1;
        let secretRef = db.collection('content').doc(String(nextSecretNumericId));
        let secretSnap = await tx.get(secretRef);
        while (secretSnap.exists) {
            nextSecretNumericId += 1;
            secretRef = db.collection('content').doc(String(nextSecretNumericId));
            secretSnap = await tx.get(secretRef);
        }
        tx.set(secretCounterRef, {
            lastIssuedId: nextSecretNumericId,
            startFrom: secretUtils_1.SECRET_NUMERIC_ID_START,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        const secretId = String(nextSecretNumericId);
        const alias = (0, secretUtils_1.createSecretAlias)(fingerprintHash, secretId);
        const initialRank = (0, secretUtils_1.computeSecretRank)(0, 0, 0, nowMs);
        tx.set(secretRef, {
            module: 'secrets',
            type: 'secret',
            source: 'anonymous',
            isOficial: false,
            titulo: '',
            descripcion: text,
            category: category || null,
            zone: zone || null,
            sex,
            age,
            anonAlias: alias,
            stats: {
                upVotesCount: 0,
                downVotesCount: 0,
                commentsCount: 0,
                reportsCount: 0,
                viewsCount: 0,
                totalVotesCount: 0
            },
            rank: {
                score: initialRank.score,
                hotScore: initialRank.hotScore,
                controversyScore: initialRank.controversyScore,
                trend: initialRank.trend
            },
            moderation: {
                status: 'active',
                reason: null,
                reviewedBy: null,
                reviewedAt: null
            },
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            deletedAt: null
        });
        const nextRateLimit = {
            lastSecretAt: nowTs,
            dailyCount: dailyCount + 1,
            dailyWindowStart: admin.firestore.Timestamp.fromMillis(dailyWindowStartMs),
            burstWindowStart: admin.firestore.Timestamp.fromMillis(burstWindowStartMs),
            burstCount: burstCount + 1,
            expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + secretUtils_1.SECRET_FINGERPRINT_TTL_MS),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        const preservedLastCommentAt = rateLimitData.lastCommentAt;
        if (preservedLastCommentAt instanceof admin.firestore.Timestamp) {
            nextRateLimit.lastCommentAt = preservedLastCommentAt;
        }
        tx.set(rateLimitRef, nextRateLimit, { merge: true });
        const existingFirstSeenAt = (((_a = fingerprintSnap.data()) === null || _a === void 0 ? void 0 : _a.firstSeenAt) instanceof admin.firestore.Timestamp)
            ? (_b = fingerprintSnap.data()) === null || _b === void 0 ? void 0 : _b.firstSeenAt
            : nowTs;
        tx.set(fingerprintRef, {
            firstSeenAt: existingFirstSeenAt,
            lastSeenAt: nowTs,
            expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + secretUtils_1.SECRET_FINGERPRINT_TTL_MS),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return {
            status: 'ok',
            secretId,
            anonAlias: alias
        };
    });
});
exports.voteSecretCallable = functions.https.onCall(async (data, context) => {
    const secretId = typeof (data === null || data === void 0 ? void 0 : data.secretId) === 'string' ? data.secretId.trim() : '';
    const voteRaw = Number(data === null || data === void 0 ? void 0 : data.vote);
    const vote = voteRaw === -1 ? -1 : 1;
    if (!secretId) {
        throw new functions.https.HttpsError('invalid-argument', 'secretId es obligatorio.');
    }
    if (voteRaw !== 1 && voteRaw !== -1) {
        throw new functions.https.HttpsError('invalid-argument', 'vote debe ser 1 o -1.');
    }
    const fingerprintHash = (0, secretUtils_1.buildSecretFingerprintHash)(data, context);
    const nowMs = Date.now();
    const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);
    const modulesConfigRef = db.collection('_config').doc('modules');
    const secretRef = db.collection('content').doc(secretId);
    const voteRef = secretRef.collection('secret_votes').doc(fingerprintHash);
    const fingerprintRef = db.collection('secret_fingerprints').doc(fingerprintHash);
    return db.runTransaction(async (tx) => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const [modulesConfigSnap, secretSnap, voteSnap, fingerprintSnap] = await Promise.all([
            tx.get(modulesConfigRef),
            tx.get(secretRef),
            tx.get(voteRef),
            tx.get(fingerprintRef)
        ]);
        if (!(0, moduleUtils_1.isSecretsModuleEnabled)(modulesConfigSnap.data())) {
            throw new functions.https.HttpsError('failed-precondition', 'El modulo de secretos esta deshabilitado.');
        }
        if (!secretSnap.exists) {
            throw new functions.https.HttpsError('not-found', 'El secreto no existe.');
        }
        const secretData = secretSnap.data() || {};
        if (secretData.module !== 'secrets' || secretData.deletedAt != null) {
            throw new functions.https.HttpsError('failed-precondition', 'El secreto no esta disponible.');
        }
        const moderationStatus = (0, userUtils_1.sanitizeBoundedString)((_a = secretData === null || secretData === void 0 ? void 0 : secretData.moderation) === null || _a === void 0 ? void 0 : _a.status, 40) || 'active';
        if (moderationStatus !== 'active') {
            throw new functions.https.HttpsError('failed-precondition', 'Este secreto no acepta interacciones por moderacion.');
        }
        const previousVote = voteSnap.exists
            ? Number(((_b = voteSnap.data()) === null || _b === void 0 ? void 0 : _b.vote) || 0)
            : 0;
        if (previousVote === vote) {
            return {
                status: 'ok',
                secretId,
                unchanged: true,
                vote
            };
        }
        let upVotesCount = Math.max(0, Math.floor(Number(((_c = secretData === null || secretData === void 0 ? void 0 : secretData.stats) === null || _c === void 0 ? void 0 : _c.upVotesCount) || 0)));
        let downVotesCount = Math.max(0, Math.floor(Number(((_d = secretData === null || secretData === void 0 ? void 0 : secretData.stats) === null || _d === void 0 ? void 0 : _d.downVotesCount) || 0)));
        const commentsCount = Math.max(0, Math.floor(Number(((_e = secretData === null || secretData === void 0 ? void 0 : secretData.stats) === null || _e === void 0 ? void 0 : _e.commentsCount) || 0)));
        if (previousVote === 1)
            upVotesCount = Math.max(0, upVotesCount - 1);
        if (previousVote === -1)
            downVotesCount = Math.max(0, downVotesCount - 1);
        if (vote === 1)
            upVotesCount += 1;
        if (vote === -1)
            downVotesCount += 1;
        const createdAtMs = (0, secretUtils_1.timestampToMillisOrZero)(secretData.createdAt) || nowMs;
        const rank = (0, secretUtils_1.computeSecretRank)(upVotesCount, downVotesCount, commentsCount, createdAtMs);
        const existingVoteCreatedAt = (_f = voteSnap.data()) === null || _f === void 0 ? void 0 : _f.createdAt;
        tx.set(voteRef, {
            vote,
            createdAt: existingVoteCreatedAt instanceof admin.firestore.Timestamp
                ? existingVoteCreatedAt
                : admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        tx.update(secretRef, {
            'stats.upVotesCount': upVotesCount,
            'stats.downVotesCount': downVotesCount,
            'stats.totalVotesCount': upVotesCount + downVotesCount,
            'rank.score': rank.score,
            'rank.hotScore': rank.hotScore,
            'rank.controversyScore': rank.controversyScore,
            'rank.trend': rank.trend,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        const existingFirstSeenAt = (((_g = fingerprintSnap.data()) === null || _g === void 0 ? void 0 : _g.firstSeenAt) instanceof admin.firestore.Timestamp)
            ? (_h = fingerprintSnap.data()) === null || _h === void 0 ? void 0 : _h.firstSeenAt
            : nowTs;
        tx.set(fingerprintRef, {
            firstSeenAt: existingFirstSeenAt,
            lastSeenAt: nowTs,
            expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + secretUtils_1.SECRET_FINGERPRINT_TTL_MS),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return {
            status: 'ok',
            secretId,
            vote,
            upVotesCount,
            downVotesCount,
            score: rank.score,
            trend: rank.trend
        };
    });
});
exports.createSecretCommentCallable = functions.https.onCall(async (data, context) => {
    const secretId = typeof (data === null || data === void 0 ? void 0 : data.secretId) === 'string' ? data.secretId.trim() : '';
    if (!secretId) {
        throw new functions.https.HttpsError('invalid-argument', 'secretId es obligatorio.');
    }
    const text = (0, secretUtils_1.sanitizeSecretText)(data === null || data === void 0 ? void 0 : data.text, secretUtils_1.SECRET_COMMENT_MAX_LENGTH);
    if (text.length < secretUtils_1.SECRET_COMMENT_MIN_LENGTH) {
        throw new functions.https.HttpsError('invalid-argument', `El comentario debe tener al menos ${secretUtils_1.SECRET_COMMENT_MIN_LENGTH} caracteres.`);
    }
    if (!(0, secretUtils_1.hasMeaningfulSecretText)(text)) {
        throw new functions.https.HttpsError('invalid-argument', 'Escribe un comentario valido.');
    }
    const fingerprintHash = (0, secretUtils_1.buildSecretFingerprintHash)(data, context);
    const nowMs = Date.now();
    const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);
    const modulesConfigRef = db.collection('_config').doc('modules');
    const secretSettingsRef = db.collection('_config').doc('secret_settings');
    const secretRef = db.collection('content').doc(secretId);
    const rateLimitRef = db.collection('secret_rate_limits').doc(fingerprintHash);
    const fingerprintRef = db.collection('secret_fingerprints').doc(fingerprintHash);
    return db.runTransaction(async (tx) => {
        var _a, _b, _c, _d, _e, _f;
        const [modulesConfigSnap, secretSettingsSnap, secretSnap, rateLimitSnap, fingerprintSnap] = await Promise.all([
            tx.get(modulesConfigRef),
            tx.get(secretSettingsRef),
            tx.get(secretRef),
            tx.get(rateLimitRef),
            tx.get(fingerprintRef)
        ]);
        if (!(0, moduleUtils_1.isSecretsModuleEnabled)(modulesConfigSnap.data())) {
            throw new functions.https.HttpsError('failed-precondition', 'El modulo de secretos esta deshabilitado.');
        }
        if (!secretSnap.exists) {
            throw new functions.https.HttpsError('not-found', 'El secreto no existe.');
        }
        const secretData = secretSnap.data() || {};
        if (secretData.module !== 'secrets' || secretData.deletedAt != null) {
            throw new functions.https.HttpsError('failed-precondition', 'El secreto no esta disponible.');
        }
        const moderationStatus = (0, userUtils_1.sanitizeBoundedString)((_a = secretData === null || secretData === void 0 ? void 0 : secretData.moderation) === null || _a === void 0 ? void 0 : _a.status, 40) || 'active';
        if (moderationStatus !== 'active') {
            throw new functions.https.HttpsError('failed-precondition', 'Este secreto no permite comentarios.');
        }
        const runtimeSettings = (0, secretUtils_1.resolveSecretRuntimeSettings)(secretSettingsSnap.data());
        const rateLimitData = rateLimitSnap.data() || {};
        const lastCommentAtMs = (0, secretUtils_1.timestampToMillisOrZero)(rateLimitData.lastCommentAt);
        if (lastCommentAtMs > 0) {
            const elapsed = nowMs - lastCommentAtMs;
            if (elapsed < runtimeSettings.commentCooldownMs) {
                const remaining = Math.max(1, Math.ceil((runtimeSettings.commentCooldownMs - elapsed) / 1000));
                throw new functions.https.HttpsError('failed-precondition', `Espera ${remaining}s antes de comentar de nuevo.`);
            }
        }
        const commentRef = secretRef.collection('secret_comments').doc();
        const alias = (0, secretUtils_1.createSecretAlias)(fingerprintHash, `${secretId}:${commentRef.id}`);
        const upVotesCount = Math.max(0, Math.floor(Number(((_b = secretData === null || secretData === void 0 ? void 0 : secretData.stats) === null || _b === void 0 ? void 0 : _b.upVotesCount) || 0)));
        const downVotesCount = Math.max(0, Math.floor(Number(((_c = secretData === null || secretData === void 0 ? void 0 : secretData.stats) === null || _c === void 0 ? void 0 : _c.downVotesCount) || 0)));
        const commentsCount = Math.max(0, Math.floor(Number(((_d = secretData === null || secretData === void 0 ? void 0 : secretData.stats) === null || _d === void 0 ? void 0 : _d.commentsCount) || 0))) + 1;
        const createdAtMs = (0, secretUtils_1.timestampToMillisOrZero)(secretData.createdAt) || nowMs;
        const rank = (0, secretUtils_1.computeSecretRank)(upVotesCount, downVotesCount, commentsCount, createdAtMs);
        tx.set(commentRef, {
            text,
            anonAlias: alias,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            deletedAt: null,
            score: 0,
            reportsCount: 0
        });
        tx.update(secretRef, {
            'stats.commentsCount': commentsCount,
            'rank.score': rank.score,
            'rank.hotScore': rank.hotScore,
            'rank.controversyScore': rank.controversyScore,
            'rank.trend': rank.trend,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        const nextRateLimit = {
            lastCommentAt: nowTs,
            expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + secretUtils_1.SECRET_FINGERPRINT_TTL_MS),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        const preservedLastSecretAt = rateLimitData.lastSecretAt;
        const preservedDailyCount = Number(rateLimitData.dailyCount || 0);
        const preservedDailyWindowStart = rateLimitData.dailyWindowStart;
        if (preservedLastSecretAt instanceof admin.firestore.Timestamp) {
            nextRateLimit.lastSecretAt = preservedLastSecretAt;
        }
        if (preservedDailyCount > 0) {
            nextRateLimit.dailyCount = preservedDailyCount;
        }
        if (preservedDailyWindowStart instanceof admin.firestore.Timestamp) {
            nextRateLimit.dailyWindowStart = preservedDailyWindowStart;
        }
        tx.set(rateLimitRef, nextRateLimit, { merge: true });
        const existingFirstSeenAt = (((_e = fingerprintSnap.data()) === null || _e === void 0 ? void 0 : _e.firstSeenAt) instanceof admin.firestore.Timestamp)
            ? (_f = fingerprintSnap.data()) === null || _f === void 0 ? void 0 : _f.firstSeenAt
            : nowTs;
        tx.set(fingerprintRef, {
            firstSeenAt: existingFirstSeenAt,
            lastSeenAt: nowTs,
            expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + secretUtils_1.SECRET_FINGERPRINT_TTL_MS),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return {
            status: 'ok',
            secretId,
            commentId: commentRef.id,
            anonAlias: alias
        };
    });
});
exports.reportSecretCallable = functions.https.onCall(async (data, context) => {
    const secretId = typeof (data === null || data === void 0 ? void 0 : data.secretId) === 'string' ? data.secretId.trim() : '';
    if (!secretId) {
        throw new functions.https.HttpsError('invalid-argument', 'secretId es obligatorio.');
    }
    const reason = (0, secretUtils_1.normalizeSecretReportReason)(data === null || data === void 0 ? void 0 : data.reason);
    const fingerprintHash = (0, secretUtils_1.buildSecretFingerprintHash)(data, context);
    const nowMs = Date.now();
    const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);
    const modulesConfigRef = db.collection('_config').doc('modules');
    const secretSettingsRef = db.collection('_config').doc('secret_settings');
    const secretRef = db.collection('content').doc(secretId);
    const reportRef = secretRef.collection('secret_reports').doc(fingerprintHash);
    const fingerprintRef = db.collection('secret_fingerprints').doc(fingerprintHash);
    return db.runTransaction(async (tx) => {
        var _a, _b, _c, _d, _e, _f;
        const [modulesConfigSnap, secretSettingsSnap, secretSnap, reportSnap, fingerprintSnap] = await Promise.all([
            tx.get(modulesConfigRef),
            tx.get(secretSettingsRef),
            tx.get(secretRef),
            tx.get(reportRef),
            tx.get(fingerprintRef)
        ]);
        if (!(0, moduleUtils_1.isSecretsModuleEnabled)(modulesConfigSnap.data())) {
            throw new functions.https.HttpsError('failed-precondition', 'El modulo de secretos esta deshabilitado.');
        }
        if (!secretSnap.exists) {
            throw new functions.https.HttpsError('not-found', 'El secreto no existe.');
        }
        const secretData = secretSnap.data() || {};
        if (secretData.module !== 'secrets' || secretData.deletedAt != null) {
            throw new functions.https.HttpsError('failed-precondition', 'El secreto no esta disponible.');
        }
        if (reportSnap.exists) {
            return {
                status: 'already_reported',
                secretId
            };
        }
        const runtimeSettings = (0, secretUtils_1.resolveSecretRuntimeSettings)(secretSettingsSnap.data());
        const reportsCount = Math.max(0, Math.floor(Number(((_a = secretData === null || secretData === void 0 ? void 0 : secretData.stats) === null || _a === void 0 ? void 0 : _a.reportsCount) || 0))) + 1;
        const currentStatus = (0, userUtils_1.sanitizeBoundedString)((_b = secretData === null || secretData === void 0 ? void 0 : secretData.moderation) === null || _b === void 0 ? void 0 : _b.status, 40) || 'active';
        const currentReason = (_d = (_c = secretData === null || secretData === void 0 ? void 0 : secretData.moderation) === null || _c === void 0 ? void 0 : _c.reason) !== null && _d !== void 0 ? _d : null;
        let nextStatus = currentStatus;
        let nextReason = currentReason;
        if (currentStatus === 'active' && reportsCount >= runtimeSettings.autoHideReportsThreshold) {
            nextStatus = 'hidden_auto';
            nextReason = 'report_threshold';
        }
        tx.set(reportRef, {
            reason,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        tx.update(secretRef, {
            'stats.reportsCount': reportsCount,
            'moderation.status': nextStatus,
            'moderation.reason': nextReason,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        const existingFirstSeenAt = (((_e = fingerprintSnap.data()) === null || _e === void 0 ? void 0 : _e.firstSeenAt) instanceof admin.firestore.Timestamp)
            ? (_f = fingerprintSnap.data()) === null || _f === void 0 ? void 0 : _f.firstSeenAt
            : nowTs;
        tx.set(fingerprintRef, {
            firstSeenAt: existingFirstSeenAt,
            lastSeenAt: nowTs,
            expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + secretUtils_1.SECRET_FINGERPRINT_TTL_MS),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return {
            status: 'ok',
            secretId,
            reportsCount,
            moderationStatus: nextStatus
        };
    });
});
exports.getSecretModerationQueueCallable = functions.https.onCall(async (data, context) => {
    await (0, userUtils_1.assertAdminUser)(db, context.auth);
    const statusFilter = (0, secretUtils_1.normalizeSecretModerationStatusFilter)(data === null || data === void 0 ? void 0 : data.status);
    const limitValue = (0, lotteryUtils_1.clampInteger)(data === null || data === void 0 ? void 0 : data.limit, 10, 200, 80);
    let moderationQuery = db
        .collection('content')
        .where('module', '==', 'secrets')
        .where('deletedAt', '==', null);
    if (statusFilter !== 'all') {
        moderationQuery = moderationQuery.where('moderation.status', '==', statusFilter);
    }
    moderationQuery = moderationQuery.orderBy('createdAt', 'desc').limit(limitValue);
    const snapshot = await moderationQuery.get();
    const items = snapshot.docs.map((docSnap) => {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const data = docSnap.data() || {};
        return {
            secretId: docSnap.id,
            textPreview: (0, secretUtils_1.sanitizeSecretText)(data.descripcion, 280),
            category: (0, userUtils_1.sanitizeBoundedString)(data.category, 40),
            zone: (0, userUtils_1.sanitizeBoundedString)(data.zone, 60),
            createdAtMs: (0, secretUtils_1.timestampToMillisOrZero)(data.createdAt),
            updatedAtMs: (0, secretUtils_1.timestampToMillisOrZero)(data.updatedAt),
            moderation: {
                status: (0, userUtils_1.sanitizeBoundedString)((_a = data === null || data === void 0 ? void 0 : data.moderation) === null || _a === void 0 ? void 0 : _a.status, 40) || 'active',
                reason: (0, userUtils_1.sanitizeBoundedString)((_b = data === null || data === void 0 ? void 0 : data.moderation) === null || _b === void 0 ? void 0 : _b.reason, 180),
                reviewedBy: (0, userUtils_1.sanitizeBoundedString)((_c = data === null || data === void 0 ? void 0 : data.moderation) === null || _c === void 0 ? void 0 : _c.reviewedBy, 128),
                reviewedAtMs: (0, secretUtils_1.timestampToMillisOrZero)((_d = data === null || data === void 0 ? void 0 : data.moderation) === null || _d === void 0 ? void 0 : _d.reviewedAt)
            },
            stats: {
                upVotesCount: Math.max(0, Math.floor(Number(((_e = data === null || data === void 0 ? void 0 : data.stats) === null || _e === void 0 ? void 0 : _e.upVotesCount) || 0))),
                downVotesCount: Math.max(0, Math.floor(Number(((_f = data === null || data === void 0 ? void 0 : data.stats) === null || _f === void 0 ? void 0 : _f.downVotesCount) || 0))),
                commentsCount: Math.max(0, Math.floor(Number(((_g = data === null || data === void 0 ? void 0 : data.stats) === null || _g === void 0 ? void 0 : _g.commentsCount) || 0))),
                reportsCount: Math.max(0, Math.floor(Number(((_h = data === null || data === void 0 ? void 0 : data.stats) === null || _h === void 0 ? void 0 : _h.reportsCount) || 0))),
                totalVotesCount: Math.max(0, Math.floor(Number(((_j = data === null || data === void 0 ? void 0 : data.stats) === null || _j === void 0 ? void 0 : _j.totalVotesCount) || 0)))
            }
        };
    });
    return {
        status: 'ok',
        filter: statusFilter,
        count: items.length,
        items,
        fetchedAtMs: Date.now()
    };
});
exports.moderateSecretCallable = functions.https.onCall(async (data, context) => {
    var _a;
    await (0, userUtils_1.assertAdminUser)(db, context.auth);
    const secretId = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.secretId, 128);
    if (!secretId) {
        throw new functions.https.HttpsError('invalid-argument', 'secretId es obligatorio.');
    }
    const action = (0, secretUtils_1.normalizeSecretModerationAction)(data === null || data === void 0 ? void 0 : data.action);
    const reasonInput = (0, secretUtils_1.sanitizeSecretText)(data === null || data === void 0 ? void 0 : data.reason, 180);
    const reviewerUid = ((_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid) || 'admin';
    const secretRef = db.collection('content').doc(secretId);
    return db.runTransaction(async (tx) => {
        const secretSnap = await tx.get(secretRef);
        if (!secretSnap.exists) {
            throw new functions.https.HttpsError('not-found', 'El secreto no existe.');
        }
        const secretData = secretSnap.data() || {};
        if (secretData.module !== 'secrets' || secretData.deletedAt != null) {
            throw new functions.https.HttpsError('failed-precondition', 'El secreto no esta disponible para moderacion.');
        }
        let moderationStatus = 'active';
        let moderationReason = null;
        if (action === 'hide') {
            moderationStatus = 'hidden_admin';
            moderationReason = reasonInput || 'hidden_by_admin';
        }
        else if (action === 'block') {
            moderationStatus = 'blocked';
            moderationReason = reasonInput || 'blocked_by_admin';
        }
        else {
            moderationStatus = 'active';
            moderationReason = null;
        }
        tx.update(secretRef, {
            'moderation.status': moderationStatus,
            'moderation.reason': moderationReason,
            'moderation.reviewedBy': reviewerUid,
            'moderation.reviewedAt': admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return {
            status: 'ok',
            secretId,
            moderationStatus,
            action
        };
    });
});
exports.refreshSecretRankingsCallable = functions.https.onCall(async (_data, context) => {
    var _a;
    await (0, userUtils_1.assertStaffUser)(db, context.auth);
    const rankings = await (0, secretUtils_1.refreshSecretRankingsInternal)();
    const lists = (rankings.lists || {});
    return {
        status: 'ok',
        generatedAtMs: Number(rankings.generatedAtMs || Date.now()),
        sourceSampleSize: Number(((_a = rankings.source) === null || _a === void 0 ? void 0 : _a.sampleSize) || 0),
        counts: {
            topDay: Array.isArray(lists.topDay) ? lists.topDay.length : 0,
            mostCommented: Array.isArray(lists.mostCommented) ? lists.mostCommented.length : 0,
            mostVoted: Array.isArray(lists.mostVoted) ? lists.mostVoted.length : 0,
            mostPolemic: Array.isArray(lists.mostPolemic) ? lists.mostPolemic.length : 0
        }
    };
});
exports.refreshSecretRankings = functions.pubsub
    .schedule('every 5 minutes')
    .onRun(async () => {
    var _a;
    const rankings = await (0, secretUtils_1.refreshSecretRankingsInternal)();
    const sampleSize = Number(((_a = rankings.source) === null || _a === void 0 ? void 0 : _a.sampleSize) || 0);
    console.log(`Secret rankings refreshed. sampleSize=${sampleSize}`);
    return null;
});
// 2. Comments
exports.onCommentCreated = functions.firestore
    .document('content/{contentId}/comments/{commentId}')
    .onCreate(async (snap, context) => {
    const { contentId, commentId } = context.params;
    const commentData = snap.data();
    if (!commentData || !commentData.userId || commentData.deletedAt != null)
        return;
    try {
        const contentRef = db.collection('content').doc(contentId);
        await contentRef.set({
            stats: {
                commentsCount: admin.firestore.FieldValue.increment(1)
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        const contentSnap = await contentRef.get();
        if (!contentSnap.exists)
            return;
        const contentData = contentSnap.data() || {};
        if (contentData.deletedAt != null)
            return;
        const recipientUserId = (0, userUtils_1.sanitizeBoundedString)(contentData.userId, 128);
        const actorUserId = (0, userUtils_1.sanitizeBoundedString)(commentData.userId, 128);
        if (!recipientUserId || !actorUserId)
            return;
        const actor = await (0, notificationRuntimeUtils_1.loadNotificationActorIdentity)(db, actorUserId);
        const contentTarget = (0, notificationRuntimeUtils_1.buildContentTargetFromDoc)(contentId, contentData);
        await (0, notificationRuntimeUtils_1.writeNotificationEvent)(db, {
            type: 'comment',
            recipientUserId,
            actor,
            commentId,
            contentTarget,
            targetPath: contentTarget.targetPath
        });
        console.log(`Comment +1 for ${contentId}`);
    }
    catch (error) {
        console.error(`Comment increment failed`, error);
    }
});
exports.onCommentUpdated = functions.firestore
    .document('content/{contentId}/comments/{commentId}')
    .onUpdate(async (change, context) => {
    const { contentId, commentId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();
    if (!beforeData || !afterData)
        return;
    const wasAlive = beforeData.deletedAt == null;
    const isAlive = afterData.deletedAt == null;
    if (wasAlive === isAlive)
        return;
    const delta = isAlive ? 1 : -1;
    try {
        await db.collection('content').doc(contentId).set({
            stats: {
                commentsCount: admin.firestore.FieldValue.increment(delta)
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`Comment ${commentId} visibility changed (delta ${delta})`);
    }
    catch (error) {
        console.error(`Comment visibility update failed`, error);
    }
});
exports.onReplyCreated = functions.firestore
    .document('content/{contentId}/comments/{commentId}/replies/{replyId}')
    .onCreate(async (snap, context) => {
    const { contentId, commentId, replyId } = context.params;
    const replyData = snap.data();
    if (!replyData || !replyData.userId || replyData.deletedAt != null)
        return;
    try {
        const commentRef = (0, commentUtils_1.buildCommentRef)(db, contentId, commentId);
        await commentRef.set({
            stats: {
                repliesCount: admin.firestore.FieldValue.increment(1)
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        const [commentSnap, contentSnap] = await Promise.all([
            commentRef.get(),
            db.collection('content').doc(contentId).get()
        ]);
        if (!commentSnap.exists)
            return;
        const parentCommentData = commentSnap.data() || {};
        if (parentCommentData.deletedAt != null)
            return;
        const recipientUserId = (0, userUtils_1.sanitizeBoundedString)(parentCommentData.userId, 128);
        const actorUserId = (0, userUtils_1.sanitizeBoundedString)(replyData.userId, 128);
        if (!recipientUserId || !actorUserId)
            return;
        const actor = await (0, notificationRuntimeUtils_1.loadNotificationActorIdentity)(db, actorUserId);
        const fallbackModule = replyData.module === 'news'
            ? 'news'
            : 'community';
        const contentTarget = contentSnap.exists
            ? (0, notificationRuntimeUtils_1.buildContentTargetFromDoc)(contentId, contentSnap.data() || {})
            : {
                contentId,
                contentModule: fallbackModule,
                contentPublicRef: contentId,
                contentSlug: (0, contentUtils_1.normalizeContentSlug)(contentId),
                targetPath: `/c/${encodeURIComponent(contentId)}/${encodeURIComponent((0, contentUtils_1.normalizeContentSlug)(contentId))}`
            };
        await (0, notificationRuntimeUtils_1.writeNotificationEvent)(db, {
            type: 'reply',
            recipientUserId,
            actor,
            commentId,
            replyId,
            contentTarget,
            targetPath: contentTarget.targetPath
        });
        console.log(`Reply +1 for comment ${commentId}`);
    }
    catch (error) {
        console.error(`Reply increment failed`, error);
    }
});
exports.onReplyUpdated = functions.firestore
    .document('content/{contentId}/comments/{commentId}/replies/{replyId}')
    .onUpdate(async (change, context) => {
    const { contentId, commentId, replyId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();
    if (!beforeData || !afterData)
        return;
    const wasAlive = beforeData.deletedAt == null;
    const isAlive = afterData.deletedAt == null;
    if (wasAlive === isAlive)
        return;
    const delta = isAlive ? 1 : -1;
    try {
        await (0, commentUtils_1.buildCommentRef)(db, contentId, commentId).set({
            stats: {
                repliesCount: admin.firestore.FieldValue.increment(delta)
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`Reply ${replyId} visibility changed (delta ${delta})`);
    }
    catch (error) {
        console.error(`Reply visibility update failed`, error);
    }
});
// 2. Follows
// Trigger source of truth:
// relationships/{userId}/followers/{followerId}
// -> followerId follows userId
exports.onFollowAdded = functions.firestore
    .document('relationships/{userId}/followers/{followerId}')
    .onCreate(async (snap, context) => {
    const { userId, followerId } = context.params;
    try {
        const batch = db.batch();
        batch.update(db.collection('users').doc(userId), {
            'stats.followersCount': admin.firestore.FieldValue.increment(1)
        });
        batch.update(db.collection('users').doc(followerId), {
            'stats.followingCount': admin.firestore.FieldValue.increment(1)
        });
        await batch.commit();
        const actor = await (0, notificationRuntimeUtils_1.loadNotificationActorIdentity)(db, followerId);
        const targetPath = (0, notificationUtils_1.buildProfileTargetPath)(actor.actorUsername, actor.userId);
        await (0, notificationRuntimeUtils_1.writeNotificationEvent)(db, {
            type: 'follow',
            recipientUserId: userId,
            actor,
            targetPath
        });
        console.log(`Follow +1: ${followerId} -> ${userId}`);
    }
    catch (error) {
        console.error(`Follow increment failed`, error);
    }
});
exports.onFollowRemoved = functions.firestore
    .document('relationships/{userId}/followers/{followerId}')
    .onDelete(async (snap, context) => {
    const { userId, followerId } = context.params;
    try {
        const batch = db.batch();
        batch.update(db.collection('users').doc(userId), {
            'stats.followersCount': admin.firestore.FieldValue.increment(-1)
        });
        batch.update(db.collection('users').doc(followerId), {
            'stats.followingCount': admin.firestore.FieldValue.increment(-1)
        });
        await batch.commit();
        console.log(`Follow -1: ${followerId} -> ${userId}`);
    }
    catch (error) {
        console.error(`Unfollow decrement failed`, error);
    }
});
exports.updateMyProfile = functions.https.onCall(async (data, context) => {
    var _a, _b;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para actualizar tu perfil.');
    }
    const authToken = (((_b = context.auth) === null || _b === void 0 ? void 0 : _b.token) || {});
    const emailFromToken = typeof authToken.email === 'string' ? authToken.email : '';
    const { username, usernameLower } = (0, userUtils_1.normalizeUsernameStrict)(data === null || data === void 0 ? void 0 : data.username);
    const nombre = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.nombre, 120);
    if (!nombre) {
        throw new functions.https.HttpsError('invalid-argument', 'nombre es obligatorio.');
    }
    const bio = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.bio, 280);
    const location = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.location, 120);
    const website = (0, hostingUtils_1.sanitizeOptionalUrl)(data === null || data === void 0 ? void 0 : data.website, 'website');
    const profilePictureUrl = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.profilePictureUrl, 1200);
    const userRef = db.collection('users').doc(userId);
    const userPublicRef = db.collection('users_public').doc(userId);
    const usernameRef = db.collection('usernames').doc(usernameLower);
    const result = await db.runTransaction(async (tx) => {
        var _a, _b;
        const userSnap = await tx.get(userRef);
        const currentData = userSnap.exists
            ? (userSnap.data() || {})
            : {};
        const currentIdentity = (0, userUtils_1.normalizeUsernameLoose)(userId, currentData);
        const previousUsernameLower = currentIdentity.usernameLower;
        const previousUsernameRef = db.collection('usernames').doc(previousUsernameLower);
        const usernameSnap = await tx.get(usernameRef);
        if (usernameSnap.exists && ((_a = usernameSnap.data()) === null || _a === void 0 ? void 0 : _a.uid) !== userId) {
            throw new functions.https.HttpsError('already-exists', 'Ese username ya esta en uso.');
        }
        if (previousUsernameLower !== usernameLower) {
            const previousUsernameSnap = await tx.get(previousUsernameRef);
            if (previousUsernameSnap.exists && ((_b = previousUsernameSnap.data()) === null || _b === void 0 ? void 0 : _b.uid) === userId) {
                tx.delete(previousUsernameRef);
            }
        }
        const mergedStats = (0, userUtils_1.ensureUserStats)(currentData.stats);
        const mergedSettings = (0, userUtils_1.ensureUserSettings)(currentData.settings);
        const nextProfile = {
            id: userId,
            email: (0, userUtils_1.sanitizeBoundedString)(currentData.email, 255) || emailFromToken,
            nombre,
            username,
            usernameLower,
            bio,
            location,
            website,
            profilePictureUrl,
            rol: typeof currentData.rol === 'string' ? currentData.rol : 'user',
            isVerified: currentData.isVerified === true,
            stats: mergedStats,
            settings: mergedSettings,
            createdAt: currentData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        tx.set(userRef, nextProfile, { merge: true });
        tx.set(usernameRef, {
            uid: userId,
            username,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        const publicProfile = (0, userUtils_1.buildPublicUserProfile)(userId, nextProfile);
        tx.set(userPublicRef, publicProfile, { merge: true });
        return {
            profile: {
                id: userId,
                email: nextProfile.email,
                nombre,
                username,
                usernameLower,
                bio,
                location,
                website,
                profilePictureUrl,
                rol: nextProfile.rol,
                isVerified: nextProfile.isVerified,
                stats: mergedStats,
                settings: mergedSettings
            },
            publicProfile: {
                userId,
                username,
                usernameLower,
                nombre,
                bio,
                location,
                website,
                profilePictureUrl,
                isVerified: nextProfile.isVerified,
                stats: mergedStats
            }
        };
    });
    return Object.assign({ ok: true }, result);
});
exports.updateNotificationPreferences = functions.https.onCall(async (data, context) => {
    var _a, _b;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para configurar notificaciones.');
    }
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'No se encontro el perfil del usuario.');
    }
    const currentSettings = (0, userUtils_1.ensureUserSettings)((_b = userSnap.data()) === null || _b === void 0 ? void 0 : _b.settings);
    const currentTypes = (0, userUtils_1.ensureNotificationTypeSettings)(currentSettings.notificationTypes);
    const hasNotificationsEnabled = Object.prototype.hasOwnProperty.call(data || {}, 'notificationsEnabled');
    const hasLikes = Object.prototype.hasOwnProperty.call(data || {}, 'likes');
    const hasComments = Object.prototype.hasOwnProperty.call(data || {}, 'comments');
    const hasReplies = Object.prototype.hasOwnProperty.call(data || {}, 'replies');
    const hasFollows = Object.prototype.hasOwnProperty.call(data || {}, 'follows');
    const nextSettings = Object.assign(Object.assign({}, currentSettings), { privateAccount: currentSettings.privateAccount === true, notificationsEnabled: hasNotificationsEnabled
            ? data.notificationsEnabled === true
            : currentSettings.notificationsEnabled !== false, notificationTypes: {
            likes: hasLikes ? data.likes === true : currentTypes.likes,
            comments: hasComments ? data.comments === true : currentTypes.comments,
            replies: hasReplies ? data.replies === true : currentTypes.replies,
            follows: hasFollows ? data.follows === true : currentTypes.follows
        } });
    await userRef.set({
        settings: nextSettings,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    (0, notificationRuntimeUtils_1.invalidateNotificationRecipientCache)(userId);
    return {
        ok: true,
        settings: nextSettings
    };
});
exports.updateHomeFeedPreference = functions.https.onCall(async (data, context) => {
    var _a, _b;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para configurar tu feed.');
    }
    const rawDefaultFeedTab = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.defaultFeedTab, 40).toLowerCase();
    if (!['todo', 'news', 'post', 'surveys', 'lottery'].includes(rawDefaultFeedTab)) {
        throw new functions.https.HttpsError('invalid-argument', 'defaultFeedTab invalido. Valores permitidos: todo, news, post, surveys, lottery.');
    }
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'No se encontro el perfil del usuario.');
    }
    const currentSettings = (0, userUtils_1.ensureUserSettings)((_b = userSnap.data()) === null || _b === void 0 ? void 0 : _b.settings);
    const nextSettings = Object.assign(Object.assign({}, currentSettings), { defaultFeedTab: rawDefaultFeedTab });
    await userRef.set({
        settings: nextSettings,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return {
        ok: true,
        settings: nextSettings
    };
});
exports.registerNotificationDevice = functions.https.onCall(async (data, context) => {
    var _a;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para registrar un dispositivo.');
    }
    const token = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.token, 4096);
    if (!token) {
        throw new functions.https.HttpsError('invalid-argument', 'token es obligatorio.');
    }
    const platformRaw = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.platform, 20).toLowerCase();
    if (platformRaw !== 'web' && platformRaw !== 'android') {
        throw new functions.https.HttpsError('invalid-argument', 'platform debe ser "web" o "android".');
    }
    const platform = platformRaw;
    const deviceId = (0, notificationUtils_1.sanitizeNotificationDeviceId)(data === null || data === void 0 ? void 0 : data.deviceId, token, platform);
    const locale = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.locale, 64);
    const timezone = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.timezone, 80);
    const userAgent = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.userAgent, 255);
    const devicesCollection = db.collection('users').doc(userId).collection('notification_devices');
    const deviceRef = devicesCollection.doc(deviceId);
    await db.runTransaction(async (tx) => {
        const deviceSnap = await tx.get(deviceRef);
        const previous = deviceSnap.data() || {};
        tx.set(deviceRef, {
            token,
            platform,
            enabled: true,
            locale,
            timezone,
            userAgent,
            lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: deviceSnap.exists
                ? (previous.createdAt || admin.firestore.FieldValue.serverTimestamp())
                : admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    });
    const duplicatesSnap = await devicesCollection.where('token', '==', token).get();
    const duplicatesToDelete = duplicatesSnap.docs
        .filter((docSnap) => docSnap.id !== deviceId)
        .map((docSnap) => docSnap.ref);
    if (duplicatesToDelete.length > 0) {
        const batch = db.batch();
        for (const duplicateRef of duplicatesToDelete) {
            batch.delete(duplicateRef);
        }
        await batch.commit();
    }
    await (0, notificationRuntimeUtils_1.subscribeTokenToPushTopics)(token, platform);
    return {
        ok: true,
        deviceId,
        platform
    };
});
exports.unregisterNotificationDevice = functions.https.onCall(async (data, context) => {
    var _a;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para eliminar un dispositivo.');
    }
    const devicesCollection = db.collection('users').doc(userId).collection('notification_devices');
    const deviceId = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.deviceId, NOTIFICATION_DEVICE_ID_MAX_LENGTH);
    const token = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.token, 4096);
    if (!deviceId && !token) {
        throw new functions.https.HttpsError('invalid-argument', 'Debes enviar deviceId o token.');
    }
    const refsToDelete = [];
    const devicesToUnsubscribe = [];
    if (deviceId) {
        const targetRef = devicesCollection.doc(deviceId);
        const targetSnap = await targetRef.get();
        if (targetSnap.exists) {
            const targetData = targetSnap.data() || {};
            const targetToken = (0, userUtils_1.sanitizeBoundedString)(targetData.token, 4096);
            const targetPlatformRaw = (0, userUtils_1.sanitizeBoundedString)(targetData.platform, 20).toLowerCase();
            if (targetToken && (targetPlatformRaw === 'web' || targetPlatformRaw === 'android')) {
                devicesToUnsubscribe.push({
                    token: targetToken,
                    platform: targetPlatformRaw
                });
            }
        }
        refsToDelete.push(targetRef);
    }
    else {
        const tokenMatches = await devicesCollection.where('token', '==', token).get();
        for (const docSnap of tokenMatches.docs) {
            const deviceData = docSnap.data() || {};
            const targetToken = (0, userUtils_1.sanitizeBoundedString)(deviceData.token, 4096);
            const targetPlatformRaw = (0, userUtils_1.sanitizeBoundedString)(deviceData.platform, 20).toLowerCase();
            if (targetToken && (targetPlatformRaw === 'web' || targetPlatformRaw === 'android')) {
                devicesToUnsubscribe.push({
                    token: targetToken,
                    platform: targetPlatformRaw
                });
            }
            refsToDelete.push(docSnap.ref);
        }
    }
    if (refsToDelete.length > 0) {
        const batch = db.batch();
        for (const ref of refsToDelete) {
            batch.delete(ref);
        }
        await batch.commit();
    }
    if (devicesToUnsubscribe.length > 0) {
        await Promise.all(devicesToUnsubscribe.map((entry) => (0, notificationRuntimeUtils_1.unsubscribeTokenFromPushTopics)(entry.token, entry.platform)));
    }
    return {
        ok: true,
        removed: refsToDelete.length
    };
});
exports.sendTestPushToAllUsers = functions.https.onCall(async (data, context) => {
    return (0, notificationRuntimeUtils_2.sendTestPushToAllUsersInternal)(db, data, context);
    /*
    await assertAdminUser(db, context.auth);
  
    const title = sanitizeBoundedString(data?.title, 120) || 'Prueba de notificaciones';
    const body = sanitizeBoundedString(data?.body, 220) || 'Este es un test push para todos los usuarios.';
    const targetPath = safeNotificationPath(data?.targetPath, '/notificaciones');
    const platformRaw = sanitizeBoundedString(data?.platform, 20).toLowerCase();
  
    const topic = platformRaw === 'android'
      ? 'android_users'
      : platformRaw === 'web'
        ? 'web_users'
        : 'all_users';
  
    if (platformRaw && platformRaw !== 'android' && platformRaw !== 'web' && platformRaw !== 'all') {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'platform debe ser "all", "android" o "web".'
      );
    }
  
    const messageId = await admin.messaging().send({
      topic,
      notification: {
        title,
        body
      },
      data: {
        type: 'admin_broadcast_test',
        targetPath,
        sentAt: new Date().toISOString()
      },
      android: {
        priority: 'high',
        notification: {
          channelId: ANDROID_PUSH_CHANNEL_ID,
          sound: 'default'
        }
      },
      webpush: {
        fcmOptions: {
          link: targetPath
        }
      }
    });
  
    return {
      ok: true,
      topic,
      messageId
    };
    */
});
exports.markNotificationRead = functions.https.onCall(async (data, context) => {
    var _a, _b;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para actualizar notificaciones.');
    }
    const notificationId = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.notificationId, 200);
    if (!notificationId) {
        throw new functions.https.HttpsError('invalid-argument', 'notificationId es obligatorio.');
    }
    const notificationRef = db.collection('users').doc(userId).collection('notifications').doc(notificationId);
    const notificationSnap = await notificationRef.get();
    if (!notificationSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'La notificacion no existe.');
    }
    if (((_b = notificationSnap.data()) === null || _b === void 0 ? void 0 : _b.isRead) === true) {
        return {
            ok: true,
            updated: false
        };
    }
    await notificationRef.set({
        isRead: true,
        readAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return {
        ok: true,
        updated: true
    };
});
exports.markAllNotificationsRead = functions.https.onCall(async (_data, context) => {
    var _a;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para actualizar notificaciones.');
    }
    const notificationsCollection = db.collection('users').doc(userId).collection('notifications');
    let updatedCount = 0;
    while (true) {
        const unreadSnap = await notificationsCollection
            .where('isRead', '==', false)
            .limit(NOTIFICATION_PAGE_SIZE)
            .get();
        if (unreadSnap.empty)
            break;
        const batch = db.batch();
        for (const unreadDoc of unreadSnap.docs) {
            batch.set(unreadDoc.ref, {
                isRead: true,
                readAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
        await batch.commit();
        updatedCount += unreadSnap.size;
        if (unreadSnap.size < NOTIFICATION_PAGE_SIZE)
            break;
    }
    return {
        ok: true,
        updatedCount
    };
});
exports.updateUserManagement = functions.https.onCall(async (data, context) => {
    return (0, userAdminRuntimeUtils_1.updateUserManagementInternal)(db, data, context);
});
exports.getUsersSocialConnections = functions.https.onCall(async (data, context) => {
    return (0, userAdminRuntimeUtils_1.getUsersSocialConnectionsInternal)(db, data, context);
});
exports.getLotteryUserTicketExtras = functions.https.onCall(async (data, context) => {
    return (0, lotteryAdminRuntimeUtils_1.getLotteryUserTicketExtrasInternal)(db, data, context);
});
exports.listLotteriesForAdmin = functions.https.onCall(async (_data, context) => {
    return (0, lotteryAdminRuntimeUtils_1.listLotteriesForAdminInternal)(db, context);
});
exports.grantLotteryUserExtraTickets = functions.https.onCall(async (data, context) => {
    return (0, lotteryAdminRuntimeUtils_1.grantLotteryUserExtraTicketsInternal)(db, data, context);
});
exports.syncPublicUserProfile = functions.firestore
    .document('users/{userId}')
    .onWrite(async (change, context) => {
    const { userId } = context.params;
    if (!change.after.exists) {
        const beforeData = change.before.data() || {};
        const previousIdentity = (0, userUtils_1.normalizeUsernameLoose)(userId, beforeData);
        const previousUsernameRef = db.collection('usernames').doc(previousIdentity.usernameLower);
        await db.runTransaction(async (tx) => {
            var _a;
            const previousUsernameSnap = await tx.get(previousUsernameRef);
            if (previousUsernameSnap.exists && ((_a = previousUsernameSnap.data()) === null || _a === void 0 ? void 0 : _a.uid) === userId) {
                tx.delete(previousUsernameRef);
            }
            tx.delete(db.collection('users_public').doc(userId));
        });
        return null;
    }
    const afterData = change.after.data() || {};
    const beforeData = change.before.exists ? (change.before.data() || {}) : {};
    const currentIdentity = (0, userUtils_1.normalizeUsernameLoose)(userId, afterData);
    const previousIdentity = (0, userUtils_1.normalizeUsernameLoose)(userId, beforeData);
    const publicProfile = (0, userUtils_1.buildPublicUserProfile)(userId, afterData);
    const currentUsernameRef = db.collection('usernames').doc(currentIdentity.usernameLower);
    const previousUsernameRef = db.collection('usernames').doc(previousIdentity.usernameLower);
    const usersPublicRef = db.collection('users_public').doc(userId);
    await db.runTransaction(async (tx) => {
        var _a, _b;
        const currentUsernameSnap = await tx.get(currentUsernameRef);
        if (!currentUsernameSnap.exists || ((_a = currentUsernameSnap.data()) === null || _a === void 0 ? void 0 : _a.uid) === userId) {
            tx.set(currentUsernameRef, {
                uid: userId,
                username: currentIdentity.username,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
        else {
            console.warn(`Username collision detected for ${currentIdentity.usernameLower}. Keeping existing owner.`);
        }
        if (previousIdentity.usernameLower !== currentIdentity.usernameLower) {
            const previousUsernameSnap = await tx.get(previousUsernameRef);
            if (previousUsernameSnap.exists && ((_b = previousUsernameSnap.data()) === null || _b === void 0 ? void 0 : _b.uid) === userId) {
                tx.delete(previousUsernameRef);
            }
        }
        tx.set(usersPublicRef, publicProfile, { merge: true });
    });
    return null;
});
// 3. User Updates (PropagaciÃ³n desnormalizada)
exports.onUserUpdated = functions.firestore
    .document('users/{userId}')
    .onUpdate(async (change, context) => {
    const { userId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();
    try {
        const nameChanged = beforeData.nombre !== afterData.nombre;
        const pictureChanged = beforeData.profilePictureUrl !== afterData.profilePictureUrl;
        const usernameChanged = beforeData.username !== afterData.username;
        if (!nameChanged && !pictureChanged && !usernameChanged)
            return;
        const postUpdateData = {};
        const commentsUpdateData = {};
        if (nameChanged) {
            postUpdateData.userName = afterData.nombre || '';
            commentsUpdateData.userName = afterData.nombre || '';
        }
        if (pictureChanged) {
            postUpdateData.userProfilePicUrl = afterData.profilePictureUrl || '';
            commentsUpdateData.userProfilePicUrl = afterData.profilePictureUrl || '';
        }
        if (usernameChanged) {
            const normalizedIdentity = (0, userUtils_1.normalizeUsernameLoose)(userId, afterData);
            postUpdateData.userUsername = normalizedIdentity.usernameLower;
        }
        const [postsUpdated, commentsUpdated, repliesUpdated] = await Promise.all([
            Object.keys(postUpdateData).length > 0
                ? (0, userUtils_1.propagateUserFields)(db, 'content', userId, postUpdateData)
                : Promise.resolve(0),
            Object.keys(commentsUpdateData).length > 0
                ? (0, userUtils_1.propagateUserFields)(db, 'comments', userId, commentsUpdateData)
                : Promise.resolve(0),
            Object.keys(commentsUpdateData).length > 0
                ? (0, userUtils_1.propagateUserFields)(db, 'replies', userId, commentsUpdateData)
                : Promise.resolve(0)
        ]);
        console.log(`User profile updated for ${userId}: posts=${postsUpdated}, comments=${commentsUpdated}, replies=${repliesUpdated}`);
    }
    catch (error) {
        console.error(`âŒ User update propagation failed:`, error);
    }
});
// 4. Content Tracking
exports.onContentSlugSync = functions.firestore
    .document('content/{contentId}')
    .onWrite(async (change, context) => {
    if (!change.after.exists)
        return null;
    const contentRef = change.after.ref;
    const beforeData = change.before.exists ? change.before.data() || {} : {};
    const afterData = change.after.data() || {};
    const beforeSlug = typeof beforeData.slug === 'string' ? beforeData.slug.trim() : '';
    const afterSlug = typeof afterData.slug === 'string' ? afterData.slug.trim() : '';
    const beforeModule = change.before.exists ? (0, contentUtils_1.inferContentModule)(beforeData) : null;
    const afterModule = (0, contentUtils_1.inferContentModule)(afterData);
    const beforePublicId = beforeModule === 'news'
        ? (0, contentUtils_1.extractNewsPublicIdFromPayload)(beforeData)
        : '';
    const afterPublicId = afterModule === 'news'
        ? (0, contentUtils_1.extractNewsPublicIdFromPayload)(afterData)
        : '';
    const shouldSync = !change.before.exists ||
        !afterSlug ||
        beforeSlug !== afterSlug ||
        beforeModule !== afterModule ||
        beforePublicId !== afterPublicId;
    if (!shouldSync)
        return null;
    try {
        await db.runTransaction(async (transaction) => {
            var _a;
            const freshSnapshot = await transaction.get(contentRef);
            if (!freshSnapshot.exists)
                return;
            const freshData = freshSnapshot.data() || {};
            const freshModule = (0, contentUtils_1.inferContentModule)(freshData);
            const freshPublicId = freshModule === 'news'
                ? (0, contentUtils_1.extractNewsPublicIdFromPayload)(freshData)
                : '';
            const existingSlugRaw = typeof freshData.slug === 'string' ? freshData.slug.trim() : '';
            if (existingSlugRaw) {
                const normalizedExistingSlug = (0, contentUtils_1.normalizeContentSlug)(existingSlugRaw);
                const existingSlugKey = (0, contentUtils_1.buildContentSlugKey)(freshModule, normalizedExistingSlug);
                transaction.set(db.collection('_content_slugs').doc(existingSlugKey), {
                    contentId: freshSnapshot.id,
                    module: freshModule,
                    slug: normalizedExistingSlug,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                const normalizedBase = (0, contentUtils_1.buildContentSlugBase)(freshData);
                const syncUpdate = {};
                if (freshData.slug !== normalizedExistingSlug)
                    syncUpdate.slug = normalizedExistingSlug;
                if (freshData.slugBase !== normalizedBase)
                    syncUpdate.slugBase = normalizedBase;
                if (freshData.slugModule !== freshModule)
                    syncUpdate.slugModule = freshModule;
                if (freshModule === 'news' && freshPublicId) {
                    const numericPublicId = Number(freshPublicId);
                    if (freshData.publicId !== freshPublicId)
                        syncUpdate.publicId = freshPublicId;
                    if (freshData.postId !== numericPublicId)
                        syncUpdate.postId = numericPublicId;
                    transaction.set(db.collection('_content_public_ids').doc((0, contentUtils_1.buildContentPublicIdKey)(freshModule, freshPublicId)), {
                        contentId: freshSnapshot.id,
                        module: freshModule,
                        publicId: freshPublicId,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                }
                if (Object.keys(syncUpdate).length > 0) {
                    transaction.set(contentRef, syncUpdate, { merge: true });
                }
                return;
            }
            const slugBase = (0, contentUtils_1.buildContentSlugBase)(freshData);
            let nextSlug = slugBase;
            let attempt = 2;
            while (true) {
                const slugKey = (0, contentUtils_1.buildContentSlugKey)(freshModule, nextSlug);
                const slugRef = db.collection('_content_slugs').doc(slugKey);
                const slugSnapshot = await transaction.get(slugRef);
                if (!slugSnapshot.exists) {
                    transaction.set(contentRef, Object.assign({ slug: nextSlug, slugBase, slugModule: freshModule }, (freshModule === 'news' && freshPublicId
                        ? { publicId: freshPublicId, postId: Number(freshPublicId) }
                        : {})), { merge: true });
                    transaction.set(slugRef, {
                        contentId: freshSnapshot.id,
                        module: freshModule,
                        slug: nextSlug,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                    if (freshModule === 'news' && freshPublicId) {
                        transaction.set(db.collection('_content_public_ids').doc((0, contentUtils_1.buildContentPublicIdKey)(freshModule, freshPublicId)), {
                            contentId: freshSnapshot.id,
                            module: freshModule,
                            publicId: freshPublicId,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        }, { merge: true });
                    }
                    return;
                }
                const mappedId = String(((_a = slugSnapshot.data()) === null || _a === void 0 ? void 0 : _a.contentId) || '').trim();
                if (mappedId === freshSnapshot.id) {
                    transaction.set(contentRef, Object.assign({ slug: nextSlug, slugBase, slugModule: freshModule }, (freshModule === 'news' && freshPublicId
                        ? { publicId: freshPublicId, postId: Number(freshPublicId) }
                        : {})), { merge: true });
                    if (freshModule === 'news' && freshPublicId) {
                        transaction.set(db.collection('_content_public_ids').doc((0, contentUtils_1.buildContentPublicIdKey)(freshModule, freshPublicId)), {
                            contentId: freshSnapshot.id,
                            module: freshModule,
                            publicId: freshPublicId,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        }, { merge: true });
                    }
                    return;
                }
                const suffix = `-${attempt}`;
                const allowedBaseLength = Math.max(1, CONTENT_SLUG_MAX_LENGTH - suffix.length);
                const shortenedBase = slugBase.slice(0, allowedBaseLength).replace(/-+$/g, '') || 'contenido';
                nextSlug = `${shortenedBase}${suffix}`;
                attempt += 1;
            }
        });
    }
    catch (error) {
        console.error(`Slug sync failed for content ${context.params.contentId}:`, error);
    }
    return null;
});
exports.onContentCreated = functions.firestore
    .document('content/{contentId}')
    .onCreate(async (snap, context) => {
    return (0, contentRuntimeUtils_1.onContentCreatedInternal)(db, snap);
    /*
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
      console.error(`âŒ Content created increment failed:`, error);
    }
    */
});
exports.onContentDeleted = functions.firestore
    .document('content/{contentId}')
    .onUpdate(async (change, context) => {
    return (0, contentRuntimeUtils_1.onContentDeletedInternal)(db, change, context);
    /*
    const { contentId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();

    const isCommunityPost =
      afterData.module === 'community' || afterData.type === 'post';
    if (!isCommunityPost || !afterData.userId) return;

    try {
      const wasAlive = beforeData.deletedAt == null;
      const isNowDeleted = afterData.deletedAt != null;

      if (wasAlive && isNowDeleted) {
        try {
          await cleanupCommunityPostHostingMedia(afterData);
          console.log(`🧹 Community media deleted for ${contentId}`);
        } catch (mediaError) {
          console.error(`⚠️ Failed to delete community media for ${contentId}:`, mediaError);
        }

        const userId = afterData.userId;
        await db.collection('users').doc(userId).update({
          'stats.postsCount': admin.firestore.FieldValue.increment(-1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`âœ… Content soft-deleted: ${contentId}, postsCount decremented`);
      } else if (!wasAlive && !isNowDeleted) {
        const userId = afterData.userId;
        await db.collection('users').doc(userId).update({
          'stats.postsCount': admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`âœ… Content restored: ${contentId}, postsCount incremented`);
      }
    } catch (error) {
      console.error(`âŒ Content deletion handling failed:`, error);
    }
    */
});
// 5. IntegraciÃ³n Oficial de Noticias desde WordPress via Realtime Database
exports.onOfficialNewsReceived = functions.database
    .ref('/news/{newsId}')
    .onWrite(async (change, context) => {
    return (0, contentSyncRuntimeUtils_1.onOfficialNewsReceivedInternal)(db, change, context);
    /*
    const { newsId } = context.params;
    const afterData = change.after.val();

    // Si data es null, significa que fue borrada de RTDB (no borramos de Firestore por seguridad)
    if (!afterData) {
      console.log(`â„¹ï¸ News ${newsId} was deleted from RTDB. Ignoring in Firestore. (Idempotency)`);
      return null;
    }

    try {
      // Parsear la fecha createdAt si es string (ej: "2024-01-15 10:30:00")
      // Si no hay fecha o es invÃ¡lida, se usarÃ¡ el Timestamp del servidor.
      const parseDateCandidate = (value: unknown): admin.firestore.Timestamp | null => {
        if (!value) return null;
        if (value instanceof admin.firestore.Timestamp) return value;
        if (value instanceof Date && !isNaN(value.getTime())) {
          return admin.firestore.Timestamp.fromDate(value);
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
          const asMs = value > 1e12 ? value : value * 1000;
          const parsedNumeric = new Date(asMs);
          if (!isNaN(parsedNumeric.getTime())) {
            return admin.firestore.Timestamp.fromDate(parsedNumeric);
          }
          return null;
        }
        if (typeof value !== 'string') return null;

        const raw = value.trim();
        if (!raw) return null;

        const parsedNative = new Date(raw);
        if (!isNaN(parsedNative.getTime())) {
          return admin.firestore.Timestamp.fromDate(parsedNative);
        }

        const isoLike = raw.match(
          /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
        );
        if (isoLike) {
          const [, y, m, d, h, min, s] = isoLike;
          const parsedIsoLike = new Date(
            Number(y),
            Number(m) - 1,
            Number(d),
            Number(h),
            Number(min),
            Number(s || '0')
          );
          if (!isNaN(parsedIsoLike.getTime())) {
            return admin.firestore.Timestamp.fromDate(parsedIsoLike);
          }
        }

        const latamLike = raw.match(
          /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/
        );
        if (latamLike) {
          const [, d, m, y, h, min, s] = latamLike;
          const parsedLatam = new Date(
            Number(y),
            Number(m) - 1,
            Number(d),
            Number(h || '0'),
            Number(min || '0'),
            Number(s || '0')
          );
          if (!isNaN(parsedLatam.getTime())) {
            return admin.firestore.Timestamp.fromDate(parsedLatam);
          }
        }

        return null;
      };

      const contentRef = db.collection('content').doc(newsId);
      const existingSnap = await contentRef.get();
      const existingCreatedAt = existingSnap.exists ? existingSnap.data()?.createdAt : null;

      const createdCandidates: unknown[] = [
        afterData.createdAt,
        afterData.created_at,
        afterData.date,
        afterData.postDate,
        afterData.post_date,
        afterData.custom_fields?.createdAt,
        afterData.custom_fields?.date
      ];
      const updatedCandidates: unknown[] = [
        afterData.updatedAt,
        afterData.updated_at,
        afterData.modified,
        afterData.modifiedAt,
        afterData.custom_fields?.updatedAt,
        afterData.custom_fields?.modified
      ];

      let parsedCreatedAt: admin.firestore.Timestamp | null = null;
      for (const candidate of createdCandidates) {
        parsedCreatedAt = parseDateCandidate(candidate);
        if (parsedCreatedAt) break;
      }

      let parsedUpdatedAt: admin.firestore.Timestamp | null = null;
      for (const candidate of updatedCandidates) {
        parsedUpdatedAt = parseDateCandidate(candidate);
        if (parsedUpdatedAt) break;
      }

      const createdAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp =
        parsedCreatedAt ||
        (existingCreatedAt instanceof admin.firestore.Timestamp
          ? existingCreatedAt
          : admin.firestore.FieldValue.serverTimestamp());
      const updatedAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp =
        parsedUpdatedAt || admin.firestore.FieldValue.serverTimestamp();

      const normalizedPostId = extractNewsPublicIdFromPayload(afterData);
      const postIdNumber = normalizedPostId ? Number(normalizedPostId) : null;
      const normalizeUrlCandidate = (value: unknown): string => {
        if (typeof value !== 'string') return '';
        return value.trim().slice(0, 2400);
      };
      const coverThumbnailUrl = [
        normalizeUrlCandidate(afterData.img_miniatura),
        normalizeUrlCandidate(afterData.imgMiniatura),
        normalizeUrlCandidate(afterData.thumbnail),
        normalizeUrlCandidate(afterData.thumbnailUrl),
        normalizeUrlCandidate(afterData.coverThumbnailUrl),
        normalizeUrlCandidate(afterData.custom_fields?.img_miniatura),
        normalizeUrlCandidate(afterData.custom_fields?.thumbnail),
        normalizeUrlCandidate(afterData.custom_fields?.thumbnailUrl)
      ].find((value) => value.length > 0) || '';

      const rawImages = Array.isArray(afterData.images)
        ? afterData.images
        : [
          afterData.image,
          afterData.imageUrl,
          afterData.coverImage,
          afterData.custom_fields?.image
        ];
      const normalizedImages = Array.from(
        new Set(
          rawImages
            .map((value: unknown) => normalizeUrlCandidate(value))
            .filter((value: string) => value.length > 0)
        )
      );
      if (normalizedImages.length === 0 && coverThumbnailUrl) {
        normalizedImages.push(coverThumbnailUrl);
      }
      const imagesV2 = normalizedImages.map((url, index) => ({
        url,
        thumbUrl: index === 0 && coverThumbnailUrl ? coverThumbnailUrl : url
      }));

      // Payload purificado e idempotente
      const firestorePayload = {
        type: 'news',
        source: 'wordpress',
        module: 'news',
        externalId: newsId,
        externalSource: 'wordpress_plugin',
        postId: postIdNumber,
        publicId: normalizedPostId,

        titulo: afterData.titulo || 'Sin TÃ­tulo',
        descripcion: afterData.descripcion || '',
        images: normalizedImages,
        imagesV2,
        imgMiniatura: coverThumbnailUrl,

        userId: afterData.userId || 'wp_official',
        userName: afterData.userName || 'RedacciÃ³n CdeluAR',
        userProfilePicUrl: afterData.userProfilePicUrl || '',

        stats: {
          likesCount: afterData.stats?.likesCount || 0,
          commentsCount: afterData.stats?.commentsCount || 0,
          viewsCount: afterData.stats?.viewsCount || 0
        },

        createdAt: createdAtTs,
        updatedAt: updatedAtTs,
        deletedAt: null,
        isOficial: true,

        originalUrl: afterData.originalUrl || '',
        category: afterData.category || '',
        tags: Array.isArray(afterData.tags) ? afterData.tags : [],
        custom_fields: afterData.custom_fields || {},

        ingestedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      // Set con merge asegura idempotencia (crea si no existe, actualiza si existe)
      await db.collection('content').doc(newsId).set(firestorePayload, { merge: true });
      if (normalizedPostId) {
        const publicKey = buildContentPublicIdKey('news', normalizedPostId);
        await db
          .collection('_content_public_ids')
          .doc(publicKey)
          .set(
            {
              contentId: newsId,
              module: 'news',
              publicId: normalizedPostId,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            { merge: true }
          );
      }
      if (!normalizedPostId) {
        console.warn(`News ${newsId} synced without postId/publicId`);
      }
      console.log(`✅ Noticia sincronizada en Firestore: ${newsId}`);

      return null;
    } catch (error) {
      console.error(`❌ Falló la sincronización de RTDB a Firestore para ${newsId}:`, error);
      return null;
    }
    */
});
// 5.5 Integración de Publicaciones Scraping a la Comunidad via Realtime Database
exports.onCommunityPostsReceived = functions.database
    .ref('/c/{postId}')
    .onWrite(async (change, context) => {
    return (0, contentSyncRuntimeUtils_1.onCommunityPostsReceivedInternal)(db, change, context);
    /*
    const { postId } = context.params;
    const afterData = change.after.val();

    if (!afterData) {
      console.log(`ℹ️ Community post ${postId} was deleted from RTDB. Ignoring in Firestore.`);
      return null;
    }

    // Skip reserved IDs that would fail in Firestore
    if (postId.startsWith('__') && postId.endsWith('__')) {
      console.log(`⚠️ Skipping reserved test ID: ${postId}`);
      return null;
    }

    try {
      const parseDateCandidate = (value: unknown): admin.firestore.Timestamp | null => {
        if (!value) return null;
        if (value instanceof admin.firestore.Timestamp) return value;
        if (value instanceof Date && !isNaN(value.getTime())) {
          return admin.firestore.Timestamp.fromDate(value);
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
          const asMs = value > 1e12 ? value : value * 1000;
          const parsedNumeric = new Date(asMs);
          if (!isNaN(parsedNumeric.getTime())) {
            return admin.firestore.Timestamp.fromDate(parsedNumeric);
          }
          return null;
        }
        if (typeof value !== 'string') return null;

        const raw = value.trim();
        if (!raw) return null;

        const parsedNative = new Date(raw);
        if (!isNaN(parsedNative.getTime())) {
          return admin.firestore.Timestamp.fromDate(parsedNative);
        }

        const isoLike = raw.match(
          /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
        );
        if (isoLike) {
          const [, y, m, d, h, min, s] = isoLike;
          const parsedIsoLike = new Date(
            Number(y),
            Number(m) - 1,
            Number(d),
            Number(h),
            Number(min),
            Number(s || '0')
          );
          if (!isNaN(parsedIsoLike.getTime())) {
            return admin.firestore.Timestamp.fromDate(parsedIsoLike);
          }
        }

        const latamLike = raw.match(
          /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/
        );
        if (latamLike) {
          const [, d, m, y, h, min, s] = latamLike;
          const parsedLatam = new Date(
            Number(y),
            Number(m) - 1,
            Number(d),
            Number(h || '0'),
            Number(min || '0'),
            Number(s || '0')
          );
          if (!isNaN(parsedLatam.getTime())) {
            return admin.firestore.Timestamp.fromDate(parsedLatam);
          }
        }

        return null;
      };

      const contentRef = db.collection('content').doc(postId);
      const existingSnap = await contentRef.get();
      const existingCreatedAt = existingSnap.exists ? existingSnap.data()?.createdAt : null;

      const parsedCreatedAt = parseDateCandidate(afterData.createdAt);
      const parsedUpdatedAt = parseDateCandidate(afterData.updatedAt);

      const createdAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp =
        parsedCreatedAt || (existingCreatedAt instanceof admin.firestore.Timestamp ? existingCreatedAt : admin.firestore.FieldValue.serverTimestamp());
      const updatedAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp =
        parsedUpdatedAt || admin.firestore.FieldValue.serverTimestamp();

      const normalizeUrlCandidate = (value: unknown): string => {
        if (typeof value !== 'string') return '';
        return value.trim().slice(0, 2400);
      };

      const normalizeImageEntry = (entry: unknown): { url: string; thumbUrl: string | null } | null => {
        if (typeof entry === 'string') {
          const url = normalizeUrlCandidate(entry);
          return url ? { url, thumbUrl: null } : null;
        }

        if (!entry || typeof entry !== 'object') return null;

        const imageEntry = entry as Record<string, unknown>;
        const url = normalizeUrlCandidate(imageEntry.url);
        if (!url) return null;

        const thumbCandidate =
          normalizeUrlCandidate(imageEntry.thumbUrl) ||
          normalizeUrlCandidate(imageEntry.thumbnailUrl) ||
          normalizeUrlCandidate(imageEntry.thumbnail) ||
          normalizeUrlCandidate(imageEntry.imgMiniatura) ||
          normalizeUrlCandidate(imageEntry.img_miniatura) ||
          null;

        return {
          url,
          thumbUrl: thumbCandidate && thumbCandidate !== url ? thumbCandidate : null
        };
      };

      const explicitImagesV2 = Array.isArray(afterData.imagesV2)
        ? afterData.imagesV2
            .map((entry: unknown) => normalizeImageEntry(entry))
            .filter(
              (entry: { url: string; thumbUrl: string | null } | null): entry is {
                url: string;
                thumbUrl: string | null;
              } => Boolean(entry)
            )
        : [];

      const fallbackImageEntries = [
        ...(Array.isArray(afterData.images) ? afterData.images : []),
        afterData.image,
        afterData.imageUrl,
        afterData.coverImage,
        afterData.imgMiniatura,
        afterData.img_miniatura,
        afterData.thumbnail,
        afterData.thumbnailUrl,
        afterData.coverThumbnailUrl,
        afterData.custom_fields?.image,
        afterData.custom_fields?.imgMiniatura,
        afterData.custom_fields?.img_miniatura,
        afterData.custom_fields?.thumbnail,
        afterData.custom_fields?.thumbnailUrl
      ]
        .flatMap((entry: unknown) => {
          if (Array.isArray(entry)) return entry;
          return [entry];
        })
        .map((entry: unknown) => normalizeImageEntry(entry))
        .filter(
          (entry: { url: string; thumbUrl: string | null } | null): entry is {
            url: string;
            thumbUrl: string | null;
          } => Boolean(entry)
        );

      const mergedImages = [...explicitImagesV2, ...fallbackImageEntries];
      const normalizedImages = Array.from(new Set(mergedImages.map((entry) => entry.url))).filter(
        (value: string) => value.length > 0
      );
      const legacyMiniThumb =
        normalizeUrlCandidate(afterData.imgMiniatura) ||
        normalizeUrlCandidate(afterData.img_miniatura) ||
        normalizeUrlCandidate(afterData.thumbnailUrl) ||
        normalizeUrlCandidate(afterData.coverThumbnailUrl) ||
        normalizeUrlCandidate(afterData.custom_fields?.imgMiniatura) ||
        normalizeUrlCandidate(afterData.custom_fields?.img_miniatura) ||
        normalizeUrlCandidate(afterData.custom_fields?.thumbnailUrl) ||
        '';
      const imagesV2 = normalizedImages.map((url, index) => {
        const matched = mergedImages.find((entry: { url: string; thumbUrl: string | null }) => entry.url === url);
        const thumbUrl =
          matched?.thumbUrl ||
          (index === 0 && legacyMiniThumb ? legacyMiniThumb : null) ||
          url;
        return {
          url,
          thumbUrl
        };
      });
      const imgMiniatura = legacyMiniThumb || imagesV2[0]?.thumbUrl || normalizedImages[0] || '';

      const firestorePayload = {
        type: 'post',
        source: 'scraping',
        module: 'community',
        externalId: postId,
        id_unico: afterData.id_unico || postId,

        titulo: afterData.author_name || 'Comunidad',
        descripcion: afterData.content || '',
        images: normalizedImages,
        imagesV2,
        imgMiniatura,

        userId: afterData.author_id || 'community_user',
        userName: afterData.author_name || 'Usuario Comunidad',
        userProfilePicUrl: '',

        group_name: afterData.group_name || '',
        group_url: afterData.group_url || '',
        video_links: Array.isArray(afterData.video_links) ? afterData.video_links : [],

        stats: {
          likesCount: afterData.stats?.likesCount || 0,
          commentsCount: afterData.stats?.commentsCount || 0,
          viewsCount: afterData.stats?.viewsCount || 0
        },

        createdAt: createdAtTs,
        updatedAt: updatedAtTs,
        deletedAt: afterData.deletedAt || null,
        isOficial: false,

        originalUrl: afterData.post_url || '',
        category: afterData.group_name || 'Comunidad',
        tags: Array.isArray(afterData.tags) ? afterData.tags : [],
        custom_fields: afterData.custom_fields || {},

        ingestedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('content').doc(postId).set(firestorePayload, { merge: true });
      console.log(`✅ Publicación de la comunidad sincronizada en Firestore: ${postId}`);

      return null;
    } catch (error) {
      console.error(`❌ Falló la sincronización de comunidad a Firestore para ${postId}:`, error);
      return null;
    }
    */
});
// 6. Community image thumbnails
exports.onCommunityPostImageFinalized = functions.storage
    .bucket(COMMUNITY_THUMBNAIL_BUCKET)
    .object()
    .onFinalize(async (object) => {
    return (0, contentImageRuntimeUtils_1.onCommunityPostImageFinalizedInternal)(object);
});
// 7. Hosting FTP image upload fallback for community posts
exports.uploadCommunityImageToHosting = functions.https.onCall(async (data, context) => {
    return (0, contentImageRuntimeUtils_1.uploadCommunityImageToHostingInternal)(data, context);
});
// 8. Lottery entry callable (number-based entries, supports multiple tickets per user)
exports.enterLottery = functions.https.onCall(async (data, context) => {
    return (0, lotteryRuntimeUtils_1.enterLotteryInternal)(db, data, context);
    /*
    const userId = context.auth?.uid;
    if (!userId) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Debes iniciar sesion para participar en la loteria.'
      );
    }
  
    const lotteryId = typeof data?.lotteryId === 'string' ? data.lotteryId.trim() : '';
    const selectedNumber = parseSelectedLotteryNumber(data?.selectedNumber);
    const idempotencyKeyRaw = typeof data?.idempotencyKey === 'string'
      ? data.idempotencyKey.trim()
      : '';
  
    if (!lotteryId) {
      throw new functions.https.HttpsError('invalid-argument', 'lotteryId es obligatorio.');
    }
    if (selectedNumber == null) {
      throw new functions.https.HttpsError('invalid-argument', 'selectedNumber es obligatorio.');
    }
  
    await ensureLotteryEntriesSchemaV2(lotteryId);
  
    const userDocSnap = await db.collection('users').doc(userId).get();
    const userData = userDocSnap.data() || {};
    const userRecord = await admin.auth().getUser(userId);
    const providerIds = (userRecord.providerData || []).map((provider) => provider.providerId);
    const hasSocialAccount = providerIds.includes('google.com') || providerIds.includes('facebook.com');
    const isVerifiedUser = userData.isVerified === true;
    const token = (context.auth?.token || {}) as Record<string, unknown>;
  
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
    const entryRef = lotteryRef.collection('entries').doc(toLotteryEntryDocId(selectedNumber));
    const extraTicketsRef = db
      .collection(LOTTERY_USER_EXTRA_TICKETS_COLLECTION)
      .doc(toLotteryUserExtraDocId(lotteryId, userId));
    const userEntriesQuery = lotteryRef
      .collection('entries')
      .where('userId', '==', userId)
      .limit(LOTTERY_MAX_MAX_NUMBER + 2);
  
    const entryResult = await db.runTransaction(async (tx) => {
      const [modulesConfigSnap, lotterySnap, entrySnap, userEntriesSnap, extraTicketsSnap] = await Promise.all([
        tx.get(modulesConfigRef),
        tx.get(lotteryRef),
        tx.get(entryRef),
        tx.get(userEntriesQuery),
        tx.get(extraTicketsRef)
      ]);
  
      if (!isLotteryModuleEnabled(modulesConfigSnap.data())) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'module-disabled: El modulo de loteria esta deshabilitado.'
        );
      }
  
      if (!lotterySnap.exists) {
        throw new functions.https.HttpsError('not-found', 'La loteria no existe.');
      }
  
      const lotteryData = lotterySnap.data() || {};
      if (lotteryData.deletedAt != null) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'lottery-inactive: La loteria ya no esta disponible.'
        );
      }
  
      const isFree = lotteryData.isFree !== false;
      if (isFree && !hasSocialAccount && !isVerifiedUser) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'unverified-account: Solo los usuarios con al menos una cuenta social vinculada y verificada (Google o Facebook) pueden participar en las loterías gratuitas.'
        );
      }
  
      const lotteryStatus = (lotteryData.status || 'draft') as LotteryStatus;
      if (lotteryStatus !== 'active') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'lottery-inactive: La loteria no esta activa.'
        );
      }
  
      if (lotteryData.winner) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'lottery-inactive: La loteria ya tiene ganador.'
        );
      }
  
      const nowMs = Date.now();
      const startsAt = lotteryData.startsAt instanceof admin.firestore.Timestamp
        ? lotteryData.startsAt.toMillis()
        : null;
      const endsAt = lotteryData.endsAt instanceof admin.firestore.Timestamp
        ? lotteryData.endsAt.toMillis()
        : null;
  
      if (startsAt != null && startsAt > nowMs) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'lottery-inactive: La loteria aun no inicio.'
        );
      }
      if (endsAt != null && endsAt < nowMs) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'lottery-inactive: La loteria ya finalizo la etapa de participacion.'
        );
      }
  
      const currentParticipantsRaw = Number(lotteryData.participantsCount || 0);
      const currentParticipants = Number.isFinite(currentParticipantsRaw)
        ? Math.max(0, Math.floor(currentParticipantsRaw))
        : 0;
  
      const maxNumber = normalizeLotteryMaxNumber(lotteryData.maxNumber);
      const maxTicketsPerUser = normalizeLotteryMaxTicketsPerUser(lotteryData.maxTicketsPerUser);
      const extraTickets = normalizeLotteryExtraTickets(extraTicketsSnap.data()?.extraTickets);
      const effectiveMaxTicketsPerUser = getLotteryEffectiveMaxTickets(
        maxTicketsPerUser,
        extraTickets,
        maxNumber
      );
      if (selectedNumber < 1 || selectedNumber > maxNumber) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          `out-of-range: Debes seleccionar un numero entre 1 y ${maxNumber}.`
        );
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
        throw new functions.https.HttpsError(
          'already-exists',
          'number-taken: El numero seleccionado ya esta ocupado.'
        );
      }
  
      if (userTicketsCount >= effectiveMaxTicketsPerUser) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          `limit-reached: Alcanzaste el maximo de ${effectiveMaxTicketsPerUser} numeros para esta loteria.`
        );
      }
  
      const entryPayload: Record<string, unknown> = {
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
      tx.set(
        lotteryRef,
        {
          participantsCount: admin.firestore.FieldValue.increment(1),
          maxNumber,
          maxTicketsPerUser,
          entrySchemaVersion: LOTTERY_ENTRY_SCHEMA_VERSION,
          migrationStatus: 'done',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
  
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
      publishLotteryBallToOBS(entryResult.selectedNumber, userName, userProfilePicUrl);
    }
    return entryResult;
    */
});
// 9. Lottery draw callable (staff-only)
exports.drawLotteryWinner = functions.https.onCall(async (data, context) => {
    return (0, lotteryRuntimeUtils_1.drawLotteryWinnerInternal)(db, data, context);
    /*
    await assertStaffUser(db, context.auth);
  
    const lotteryId = typeof data?.lotteryId === 'string' ? data.lotteryId.trim() : '';
    if (!lotteryId) {
      throw new functions.https.HttpsError('invalid-argument', 'lotteryId es obligatorio.');
    }
  
    await ensureLotteryEntriesSchemaV2(lotteryId);
  
    const requesterUid = context.auth?.uid || 'system';
    const modulesConfigRef = db.collection('_config').doc('modules');
    const lotteryRef = db.collection('lotteries').doc(lotteryId);
  
    const result = await db.runTransaction(async (tx) => {
      const [modulesConfigSnap, lotterySnap] = await Promise.all([
        tx.get(modulesConfigRef),
        tx.get(lotteryRef)
      ]);
  
      if (!isLotteryModuleEnabled(modulesConfigSnap.data())) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'El modulo de loteria esta deshabilitado.'
        );
      }
  
      if (!lotterySnap.exists) {
        throw new functions.https.HttpsError('not-found', 'La loteria no existe.');
      }
  
      const lotteryData = lotterySnap.data() || {};
      if (lotteryData.deletedAt != null) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'La loteria ya no esta disponible.'
        );
      }
  
      if (lotteryData.winner) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'La loteria ya tiene ganador.'
        );
      }
  
      const lotteryStatus = (lotteryData.status || 'draft') as LotteryStatus;
      if (lotteryStatus !== 'closed') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'La loteria debe estar cerrada antes de sortear ganador.'
        );
      }
  
      const entriesQuery = lotteryRef
        .collection('entries')
        .orderBy('selectedNumber', 'asc')
        .limit(MAX_LOTTERY_DRAW_ENTRIES);
      const entriesSnap = await tx.get(entriesQuery);
  
      if (entriesSnap.empty) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'No hay participantes para sortear.'
        );
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
      const winnerSelectedNumber = parseSelectedLotteryNumber(winnerData.selectedNumber) || null;
  
      const participantsRaw = Number(lotteryData.participantsCount || 0);
      const participantsCount = Number.isFinite(participantsRaw)
        ? Math.max(0, Math.floor(participantsRaw))
        : entriesSnap.docs.length;
  
      tx.set(
        lotteryRef,
        {
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
        },
        { merge: true }
      );
  
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
  
    // Emitir notificación del sistema y push al ganador fuera de la transacción
    try {
      const winnerUserId = result.winner.userId;
      const lotteryTitle = result.lotteryTitle;
      const winnerSelectedNumber = result.winner.selectedNumber;
  
      let premioMsg = '';
      if (result.hasPremio) {
        if (result.premioType === 'dinero' && result.premioDinero !== null) {
          premioMsg = `un premio de $${result.premioDinero} ARS`;
        } else if (result.premioType === 'otros' && result.premioOtros) {
          premioMsg = `el premio "${result.premioOtros}"`;
        } else {
          premioMsg = 'el premio mayor';
        }
      } else {
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
  
      // Enviar alerta push
      await sendPushToNotificationDevices(db,
        notificationRef,
        winnerUserId,
        'system',
        'Sorteos Bot',
        '/perfil'
      ).catch((err) => console.warn('Error sending winner push notification:', err));
  
    } catch (error) {
      console.error('Error recording winner notification:', error);
    }
  
    return {
      status: result.status,
      lotteryId: result.lotteryId,
      winner: result.winner,
      participantsCount: result.participantsCount
    };
    */
});
// 10. Surveys vote callable (single vote per user/survey)
exports.submitSurveyVote = functions.https.onCall(async (data, context) => {
    return (0, surveyRuntimeUtils_1.submitSurveyVoteInternal)(db, data, context);
});
// 11. Auto-complete expired surveys
exports.completeExpiredSurveys = functions.pubsub
    .schedule('every 1 minutes')
    .onRun(async () => {
    await (0, surveyRuntimeUtils_1.completeExpiredSurveysInternal)(db);
    return null;
});
exports.purgeOldNotifications = functions.pubsub
    .schedule('every day 03:00')
    .timeZone('Etc/UTC')
    .onRun(async () => {
    const removedCount = await (0, notificationRuntimeUtils_1.purgeOldNotificationsInternal)(db, NOTIFICATION_RETENTION_DAYS, NOTIFICATION_PAGE_SIZE);
    console.log(`Old notifications removed: ${removedCount}`);
    return null;
});
// 12. Ads metrics aggregation
exports.onAdEventCreated = functions.firestore
    .document('ad_events/{eventId}')
    .onCreate(async (snap) => {
    await (0, adRuntimeUtils_1.handleAdEventCreatedInternal)(db, snap);
    return null;
});
//# sourceMappingURL=index.js.map