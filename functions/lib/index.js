"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onOfficialNewsReceived = exports.onContentDeleted = exports.onContentCreated = exports.onUserUpdated = exports.onFollowRemoved = exports.onFollowAdded = exports.onLikeRemoved = exports.onLikeAdded = void 0;
const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
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
//# sourceMappingURL=index.js.map