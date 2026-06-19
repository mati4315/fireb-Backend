"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCommentRef = void 0;
const buildCommentRef = (db, contentId, commentId) => {
    return db.collection('content').doc(contentId).collection('comments').doc(commentId);
};
exports.buildCommentRef = buildCommentRef;
//# sourceMappingURL=commentUtils.js.map