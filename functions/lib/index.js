"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onAdEventCreated = exports.completeExpiredSurveys = exports.submitSurveyVote = exports.onOfficialNewsReceived = exports.onContentDeleted = exports.onContentCreated = exports.onUserUpdated = exports.onFollowRemoved = exports.onFollowAdded = exports.onLikeRemoved = exports.onLikeAdded = void 0;
const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
const MAX_SURVEY_OPTIONS_SELECTED = 10;
const SURVEY_COMPLETE_BATCH_SIZE = 200;
const normalizeOptionIds = (value) => {
    if (!Array.isArray(value))
        return [];
    const deduped = new Set();
    for (const item of value) {
        if (typeof item !== 'string')
            continue;
        const cleaned = item.trim();
        if (!cleaned)
            continue;
        deduped.add(cleaned);
    }
    return Array.from(deduped);
};
const normalizeSurveyOptions = (value) => {
    var _a;
    if (!Array.isArray(value))
        return [];
    const normalized = [];
    for (const rawOption of value) {
        if (!rawOption || typeof rawOption !== 'object')
            continue;
        const optionData = rawOption;
        const id = typeof optionData.id === 'string' ? optionData.id.trim() : '';
        const text = typeof optionData.text === 'string' ? optionData.text.trim() : '';
        const voteCountRaw = Number((_a = optionData.voteCount) !== null && _a !== void 0 ? _a : 0);
        if (!id || !text)
            continue;
        normalized.push({
            id,
            text,
            voteCount: Number.isFinite(voteCountRaw)
                ? Math.max(0, Math.floor(voteCountRaw))
                : 0,
            active: optionData.active !== false
        });
    }
    return normalized;
};
const isExpired = (value) => {
    if (!value)
        return false;
    if (value instanceof admin.firestore.Timestamp) {
        return value.toMillis() <= Date.now();
    }
    if (value instanceof Date) {
        return value.getTime() <= Date.now();
    }
    return false;
};
// 1. Likes
exports.onLikeAdded = functions.firestore
    .document('content/{contentId}/likes/{userId}')
    .onCreate(async (snap, context) => {
    const { contentId } = context.params;
    try {
        await db.collection('content').doc(contentId).update({
            'stats.likesCount': admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ Like +1 for ${contentId}`);
    }
    catch (error) {
        console.error(`❌ Like increment failed: ${contentId}`, error);
    }
});
exports.onLikeRemoved = functions.firestore
    .document('content/{contentId}/likes/{userId}')
    .onDelete(async (snap, context) => {
    const { contentId } = context.params;
    try {
        await db.collection('content').doc(contentId).update({
            'stats.likesCount': admin.firestore.FieldValue.increment(-1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
    catch (error) {
        console.error(`❌ Like decrement failed`, error);
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
// 3. User Updates (Propagación desnormalizada)
exports.onUserUpdated = functions.firestore
    .document('users/{userId}')
    .onUpdate(async (change, context) => {
    const { userId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();
    try {
        const nameChanged = beforeData.nombre !== afterData.nombre;
        const pictureChanged = beforeData.profilePictureUrl !== afterData.profilePictureUrl;
        if (!nameChanged && !pictureChanged)
            return;
        let postsQuery = db.collection('content').where('userId', '==', userId);
        let snapshot = await postsQuery.limit(100).get();
        let batch = db.batch();
        let batchCount = 0;
        while (!snapshot.empty) {
            for (const doc of snapshot.docs) {
                const updateData = {};
                if (nameChanged)
                    updateData.userName = afterData.nombre;
                if (pictureChanged)
                    updateData.userProfilePicUrl = afterData.profilePictureUrl;
                batch.update(doc.ref, updateData);
                batchCount++;
                if (batchCount >= 500) {
                    await batch.commit();
                    batch = db.batch();
                    batchCount = 0;
                }
            }
            const lastDoc = snapshot.docs[snapshot.docs.length - 1];
            snapshot = await postsQuery.startAfter(lastDoc).limit(100).get();
        }
        if (batchCount > 0) {
            await batch.commit();
        }
        console.log(`✅ User profile updated for ${userId}: posts updated`);
    }
    catch (error) {
        console.error(`❌ User update propagation failed:`, error);
    }
});
// 4. Content Tracking
exports.onContentCreated = functions.firestore
    .document('content/{contentId}')
    .onCreate(async (snap, context) => {
    const contentData = snap.data();
    if (!contentData)
        return;
    const isCommunityPost = contentData.module === 'community' || contentData.type === 'post';
    if (!isCommunityPost || !contentData.userId)
        return;
    try {
        await db.collection('users').doc(contentData.userId).update({
            'stats.postsCount': admin.firestore.FieldValue.increment(1)
        });
    }
    catch (error) {
        console.error(`❌ Content created increment failed:`, error);
    }
});
exports.onContentDeleted = functions.firestore
    .document('content/{contentId}')
    .onUpdate(async (change, context) => {
    const { contentId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();
    const isCommunityPost = afterData.module === 'community' || afterData.type === 'post';
    if (!isCommunityPost || !afterData.userId)
        return;
    try {
        const wasAlive = beforeData.deletedAt == null;
        const isNowDeleted = afterData.deletedAt != null;
        if (wasAlive && isNowDeleted) {
            const userId = afterData.userId;
            await db.collection('users').doc(userId).update({
                'stats.postsCount': admin.firestore.FieldValue.increment(-1),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`✅ Content soft-deleted: ${contentId}, postsCount decremented`);
        }
        else if (!wasAlive && !isNowDeleted) {
            const userId = afterData.userId;
            await db.collection('users').doc(userId).update({
                'stats.postsCount': admin.firestore.FieldValue.increment(1),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`✅ Content restored: ${contentId}, postsCount incremented`);
        }
    }
    catch (error) {
        console.error(`❌ Content deletion handling failed:`, error);
    }
});
// 5. Integración Oficial de Noticias desde WordPress via Realtime Database
exports.onOfficialNewsReceived = functions.database
    .ref('/news/{newsId}')
    .onWrite(async (change, context) => {
    var _a, _b, _c;
    const { newsId } = context.params;
    const afterData = change.after.val();
    // Si data es null, significa que fue borrada de RTDB (no borramos de Firestore por seguridad)
    if (!afterData) {
        console.log(`ℹ️ News ${newsId} was deleted from RTDB. Ignoring in Firestore. (Idempotency)`);
        return null;
    }
    try {
        // Parsear la fecha createdAt si es string (ej: "2024-01-15 10:30:00")
        // Si no hay fecha o es inválida, se usará el Timestamp del servidor.
        let createdAtTs = admin.firestore.FieldValue.serverTimestamp();
        let updatedAtTs = admin.firestore.FieldValue.serverTimestamp();
        if (afterData.createdAt) {
            const parsedCreate = new Date(afterData.createdAt);
            if (!isNaN(parsedCreate.getTime()))
                createdAtTs = admin.firestore.Timestamp.fromDate(parsedCreate);
        }
        if (afterData.updatedAt) {
            const parsedUpdate = new Date(afterData.updatedAt);
            if (!isNaN(parsedUpdate.getTime()))
                updatedAtTs = admin.firestore.Timestamp.fromDate(parsedUpdate);
        }
        // Payload purificado e idempotente
        const firestorePayload = {
            type: 'news',
            source: 'wordpress',
            module: 'news',
            externalId: newsId,
            externalSource: 'wordpress_plugin',
            titulo: afterData.titulo || 'Sin Título',
            descripcion: afterData.descripcion || '',
            images: Array.isArray(afterData.images) ? afterData.images : [],
            userId: afterData.userId || 'wp_official',
            userName: afterData.userName || 'Redacción CdeluAR',
            userProfilePicUrl: afterData.userProfilePicUrl || '',
            stats: {
                likesCount: ((_a = afterData.stats) === null || _a === void 0 ? void 0 : _a.likesCount) || 0,
                commentsCount: ((_b = afterData.stats) === null || _b === void 0 ? void 0 : _b.commentsCount) || 0,
                viewsCount: ((_c = afterData.stats) === null || _c === void 0 ? void 0 : _c.viewsCount) || 0
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
        console.log(`✅ Noticia sincronizada en Firestore: ${newsId}`);
        return null;
    }
    catch (error) {
        console.error(`❌ Falló la sincronización de RTDB a Firestore para ${newsId}:`, error);
        return null;
    }
});
// 6. Surveys vote callable (single vote per user/survey)
exports.submitSurveyVote = functions.https.onCall(async (data, context) => {
    var _a;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para votar.');
    }
    const surveyId = typeof (data === null || data === void 0 ? void 0 : data.surveyId) === 'string' ? data.surveyId.trim() : '';
    const optionIds = normalizeOptionIds(data === null || data === void 0 ? void 0 : data.optionIds);
    const idempotencyKeyRaw = typeof (data === null || data === void 0 ? void 0 : data.idempotencyKey) === 'string'
        ? data.idempotencyKey.trim()
        : '';
    const idempotencyKey = idempotencyKeyRaw ? idempotencyKeyRaw.slice(0, 120) : null;
    if (!surveyId) {
        throw new functions.https.HttpsError('invalid-argument', 'surveyId es obligatorio.');
    }
    if (optionIds.length === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'Debes seleccionar al menos una opcion.');
    }
    if (optionIds.length > MAX_SURVEY_OPTIONS_SELECTED) {
        throw new functions.https.HttpsError('invalid-argument', 'Cantidad de opciones seleccionadas invalida.');
    }
    const surveyRef = db.collection('surveys').doc(surveyId);
    const voteRef = db.collection('survey_votes').doc(`${surveyId}_${userId}`);
    const modulesConfigRef = db.collection('_config').doc('modules');
    return db.runTransaction(async (tx) => {
        var _a, _b, _c, _d;
        const [modulesConfigSnap, surveySnap, existingVoteSnap] = await Promise.all([
            tx.get(modulesConfigRef),
            tx.get(surveyRef),
            tx.get(voteRef)
        ]);
        const surveysEnabled = Boolean((_c = (_b = (_a = modulesConfigSnap.data()) === null || _a === void 0 ? void 0 : _a.surveys) === null || _b === void 0 ? void 0 : _b.enabled) !== null && _c !== void 0 ? _c : true);
        if (!surveysEnabled) {
            throw new functions.https.HttpsError('failed-precondition', 'El modulo de encuestas esta deshabilitado.');
        }
        if (!surveySnap.exists) {
            throw new functions.https.HttpsError('not-found', 'La encuesta no existe.');
        }
        const surveyData = surveySnap.data() || {};
        const surveyStatus = (surveyData.status || 'inactive');
        if (surveyStatus !== 'active') {
            throw new functions.https.HttpsError('failed-precondition', 'La encuesta no esta activa.');
        }
        if (isExpired(surveyData.expiresAt)) {
            throw new functions.https.HttpsError('failed-precondition', 'La encuesta ya expiro.');
        }
        const isMultipleChoice = Boolean(surveyData.isMultipleChoice);
        const maxVotesRaw = Number((_d = surveyData.maxVotesPerUser) !== null && _d !== void 0 ? _d : 1);
        const maxVotesPerUser = Number.isFinite(maxVotesRaw)
            ? Math.max(1, Math.floor(maxVotesRaw))
            : 1;
        if (!isMultipleChoice && optionIds.length !== 1) {
            throw new functions.https.HttpsError('invalid-argument', 'Esta encuesta permite solo una opcion.');
        }
        if (optionIds.length > maxVotesPerUser) {
            throw new functions.https.HttpsError('invalid-argument', 'Superaste el maximo de opciones permitidas.');
        }
        const surveyOptions = normalizeSurveyOptions(surveyData.options);
        if (surveyOptions.length < 2) {
            throw new functions.https.HttpsError('failed-precondition', 'La encuesta no tiene opciones validas para votar.');
        }
        const availableOptionIds = new Set();
        for (const option of surveyOptions) {
            if (option.active) {
                availableOptionIds.add(option.id);
            }
        }
        for (const selectedOptionId of optionIds) {
            if (!availableOptionIds.has(selectedOptionId)) {
                throw new functions.https.HttpsError('invalid-argument', 'Seleccionaste una opcion invalida.');
            }
        }
        if (existingVoteSnap.exists) {
            const existingVote = existingVoteSnap.data() || {};
            return {
                status: 'already_voted',
                surveyId,
                optionIds: normalizeOptionIds(existingVote.optionIds)
            };
        }
        const optionSelectionCounts = new Map();
        for (const optionId of optionIds) {
            const previousCount = optionSelectionCounts.get(optionId) || 0;
            optionSelectionCounts.set(optionId, previousCount + 1);
        }
        const nextOptions = surveyOptions.map((option) => {
            const incrementBy = optionSelectionCounts.get(option.id) || 0;
            if (incrementBy <= 0)
                return option;
            return Object.assign(Object.assign({}, option), { voteCount: option.voteCount + incrementBy });
        });
        const votePayload = {
            surveyId,
            userId,
            optionIds,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (idempotencyKey) {
            votePayload.idempotencyKey = idempotencyKey;
        }
        tx.set(voteRef, votePayload);
        tx.update(surveyRef, {
            options: nextOptions,
            totalVotes: admin.firestore.FieldValue.increment(optionIds.length),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return {
            status: 'ok',
            surveyId,
            optionIds
        };
    });
});
// 7. Auto-complete expired surveys
exports.completeExpiredSurveys = functions.pubsub
    .schedule('every 1 minutes')
    .onRun(async () => {
    let completedCount = 0;
    while (true) {
        const snapshot = await db.collection('surveys')
            .where('status', '==', 'active')
            .where('expiresAt', '<=', admin.firestore.Timestamp.now())
            .orderBy('expiresAt', 'asc')
            .limit(SURVEY_COMPLETE_BATCH_SIZE)
            .get();
        if (snapshot.empty)
            break;
        const batch = db.batch();
        for (const surveyDoc of snapshot.docs) {
            batch.update(surveyDoc.ref, {
                status: 'completed',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        await batch.commit();
        completedCount += snapshot.size;
        if (snapshot.size < SURVEY_COMPLETE_BATCH_SIZE)
            break;
    }
    console.log(`Expired surveys completed: ${completedCount}`);
    return null;
});
// 8. Ads metrics aggregation
exports.onAdEventCreated = functions.firestore
    .document('ad_events/{eventId}')
    .onCreate(async (snap) => {
    var _a;
    const eventData = snap.data();
    if (!eventData)
        return null;
    const adId = eventData.adId;
    const eventType = eventData.eventType;
    const countRaw = Number((_a = eventData.count) !== null && _a !== void 0 ? _a : 1);
    const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(Math.floor(countRaw), 20)) : 1;
    if (!adId || (eventType !== 'impression' && eventType !== 'click')) {
        console.log('Ignoring invalid ad event payload', { adId, eventType });
        return null;
    }
    const adRef = db.collection('ads').doc(adId);
    try {
        await db.runTransaction(async (tx) => {
            const adSnap = await tx.get(adRef);
            if (!adSnap.exists) {
                console.log(`Ad ${adId} does not exist. Event ignored.`);
                return;
            }
            const adData = adSnap.data() || {};
            const stats = adData.stats || {};
            const currentImpressions = Number(stats.impressionsTotal || 0);
            const currentClicks = Number(stats.clicksTotal || 0);
            const impressionIncrement = eventType === 'impression' ? count : 0;
            const clickIncrement = eventType === 'click' ? count : 0;
            const nextImpressions = currentImpressions + impressionIncrement;
            const nextClicks = currentClicks + clickIncrement;
            const ctr = nextImpressions > 0
                ? Number(((nextClicks / nextImpressions) * 100).toFixed(2))
                : 0;
            tx.set(adRef, {
                stats: {
                    impressionsTotal: admin.firestore.FieldValue.increment(impressionIncrement),
                    clicksTotal: admin.firestore.FieldValue.increment(clickIncrement),
                    ctr,
                    lastEventAt: admin.firestore.FieldValue.serverTimestamp()
                },
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });
        return null;
    }
    catch (error) {
        console.error(`Failed to aggregate ad event for ad ${adId}`, error);
        return null;
    }
});
//# sourceMappingURL=index.js.map