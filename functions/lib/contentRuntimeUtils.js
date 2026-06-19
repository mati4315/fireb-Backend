"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onContentDeletedInternal = exports.onContentCreatedInternal = void 0;
const admin = require("firebase-admin");
const hostingUtils_1 = require("./hostingUtils");
const onContentCreatedInternal = async (db, snap) => {
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
        console.error(`Error incrementing postsCount for content create:`, error);
    }
};
exports.onContentCreatedInternal = onContentCreatedInternal;
const onContentDeletedInternal = async (db, change, context) => {
    const { contentId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();
    const isCommunityPost = (afterData === null || afterData === void 0 ? void 0 : afterData.module) === 'community' || (afterData === null || afterData === void 0 ? void 0 : afterData.type) === 'post';
    if (!isCommunityPost || !(afterData === null || afterData === void 0 ? void 0 : afterData.userId))
        return;
    try {
        const wasAlive = (beforeData === null || beforeData === void 0 ? void 0 : beforeData.deletedAt) == null;
        const isNowDeleted = afterData.deletedAt != null;
        if (wasAlive && isNowDeleted) {
            try {
                await (0, hostingUtils_1.cleanupCommunityPostHostingMedia)(afterData);
                console.log(`Community media deleted for ${contentId}`);
            }
            catch (mediaError) {
                console.error(`Failed to delete community media for ${contentId}:`, mediaError);
            }
            const userId = afterData.userId;
            await db.collection('users').doc(userId).update({
                'stats.postsCount': admin.firestore.FieldValue.increment(-1),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`Content soft-deleted: ${contentId}, postsCount decremented`);
        }
        else if (!wasAlive && !isNowDeleted) {
            const userId = afterData.userId;
            await db.collection('users').doc(userId).update({
                'stats.postsCount': admin.firestore.FieldValue.increment(1),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`Content restored: ${contentId}, postsCount incremented`);
        }
    }
    catch (error) {
        console.error(`Content deletion handling failed:`, error);
    }
};
exports.onContentDeletedInternal = onContentDeletedInternal;
//# sourceMappingURL=contentRuntimeUtils.js.map