"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isExpired = void 0;
const admin = require("firebase-admin");
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
exports.isExpired = isExpired;
//# sourceMappingURL=timeUtils.js.map