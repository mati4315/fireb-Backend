"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onContentDeleted = exports.onContentCreated = exports.onUserUpdated = exports.onFollowRemoved = exports.onFollowAdded = exports.onLikeRemoved = exports.onLikeAdded = void 0;
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
exports.onFollowAdded = functions.firestore
    .document('relationships/follows/{userId}/followers/{followerId}')
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
        console.log(`✅ Follow: ${followerId} → ${userId}`);
    }
    catch (error) {
        console.error(`❌ Follow increment failed`, error);
    }
});
exports.onFollowRemoved = functions.firestore
    .document('relationships/follows/{userId}/followers/{followerId}')
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
    }
    catch (error) {
        console.error(`❌ Unfollow decrement failed`, error);
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
//# sourceMappingURL=index.js.map