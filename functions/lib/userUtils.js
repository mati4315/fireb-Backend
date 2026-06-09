"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeSurveyOptions = exports.normalizeOptionIds = exports.propagateUserFields = exports.buildPublicUserProfile = exports.ensureUserSettings = exports.ensureUserStats = exports.isNotificationTypeEnabled = exports.ensureNotificationTypeSettings = exports.normalizeUsernameLoose = exports.normalizeUsernameStrict = exports.buildFallbackUsername = exports.normalizeUsernameCandidate = exports.normalizeUserDefaultFeedTab = exports.assertAdminUser = exports.assertSystemAdminUser = exports.assertStaffUser = exports.isAdminRole = exports.isStaffRole = exports.isSystemAdminClaim = exports.isAdminClaim = exports.normalizeRoleAlias = exports.sanitizeBoundedString = exports.NOTIFICATION_TYPE_DEFAULTS = exports.USERNAME_REGEX = exports.USERNAME_MAX_LENGTH = exports.USERNAME_MIN_LENGTH = exports.USER_PROPAGATION_BATCH_WRITE_LIMIT = exports.USER_PROPAGATION_QUERY_PAGE_SIZE = void 0;
const admin = require("firebase-admin");
const functions = require("firebase-functions");
exports.USER_PROPAGATION_QUERY_PAGE_SIZE = 100;
exports.USER_PROPAGATION_BATCH_WRITE_LIMIT = 450;
exports.USERNAME_MIN_LENGTH = 3;
exports.USERNAME_MAX_LENGTH = 30;
exports.USERNAME_REGEX = /^[a-z0-9_]+$/;
const USER_DEFAULT_FEED_TAB_VALUES = new Set([
    'todo',
    'news',
    'post',
    'surveys',
    'lottery'
]);
exports.NOTIFICATION_TYPE_DEFAULTS = {
    likes: true,
    comments: true,
    replies: true,
    follows: true
};
const sanitizeBoundedString = (value, maxLength) => {
    if (typeof value !== 'string')
        return '';
    return value.trim().slice(0, maxLength);
};
exports.sanitizeBoundedString = sanitizeBoundedString;
const normalizeRoleAlias = (value) => {
    return typeof value === 'string'
        ? value.trim().toLowerCase().replace(/[\s_-]+/g, '')
        : '';
};
exports.normalizeRoleAlias = normalizeRoleAlias;
const isAdminClaim = (token) => {
    return token.admin === true ||
        token.superAdmin === true ||
        token.super_admin === true;
};
exports.isAdminClaim = isAdminClaim;
const isSystemAdminClaim = (token) => {
    return token.superAdmin === true ||
        token.super_admin === true;
};
exports.isSystemAdminClaim = isSystemAdminClaim;
const isStaffRole = (role) => {
    const normalized = (0, exports.normalizeRoleAlias)(role);
    return normalized === 'colaborador' ||
        normalized === 'admin' ||
        normalized === 'administrador' ||
        normalized === 'superadmin';
};
exports.isStaffRole = isStaffRole;
const isAdminRole = (role) => {
    const normalized = (0, exports.normalizeRoleAlias)(role);
    return normalized === 'admin' ||
        normalized === 'administrador' ||
        normalized === 'superadmin';
};
exports.isAdminRole = isAdminRole;
const assertStaffUser = async (db, authContext) => {
    var _a;
    const uid = (authContext === null || authContext === void 0 ? void 0 : authContext.uid) || '';
    if (!uid) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para ejecutar esta accion.');
    }
    const token = ((authContext === null || authContext === void 0 ? void 0 : authContext.token) || {});
    const email = typeof token.email === 'string' ? token.email.toLowerCase() : '';
    if (uid === 'Z4f5ogXDQaNhEY4iBf9jgkPnQMP2' ||
        email === 'matias4315@gmail.com' ||
        (0, exports.isAdminClaim)(token)) {
        return;
    }
    const userSnap = await db.collection('users').doc(uid).get();
    const role = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.rol;
    if ((0, exports.isStaffRole)(role))
        return;
    throw new functions.https.HttpsError('permission-denied', 'Solo staff puede ejecutar esta accion.');
};
exports.assertStaffUser = assertStaffUser;
const assertSystemAdminUser = (authContext) => {
    const uid = (authContext === null || authContext === void 0 ? void 0 : authContext.uid) || '';
    if (!uid) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para ejecutar esta accion.');
    }
    const token = ((authContext === null || authContext === void 0 ? void 0 : authContext.token) || {});
    const email = typeof token.email === 'string' ? token.email.toLowerCase() : '';
    if (uid === 'Z4f5ogXDQaNhEY4iBf9jgkPnQMP2' ||
        email === 'matias4315@gmail.com' ||
        (0, exports.isSystemAdminClaim)(token)) {
        return;
    }
    throw new functions.https.HttpsError('permission-denied', 'Solo el administrador del sistema puede ejecutar esta accion.');
};
exports.assertSystemAdminUser = assertSystemAdminUser;
const assertAdminUser = async (db, authContext) => {
    var _a;
    const uid = (authContext === null || authContext === void 0 ? void 0 : authContext.uid) || '';
    if (!uid) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para ejecutar esta accion.');
    }
    const token = ((authContext === null || authContext === void 0 ? void 0 : authContext.token) || {});
    const email = typeof token.email === 'string' ? token.email.toLowerCase() : '';
    if (uid === 'Z4f5ogXDQaNhEY4iBf9jgkPnQMP2' ||
        email === 'matias4315@gmail.com' ||
        (0, exports.isAdminClaim)(token)) {
        return;
    }
    const userSnap = await db.collection('users').doc(uid).get();
    const role = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.rol;
    if ((0, exports.isAdminRole)(role))
        return;
    throw new functions.https.HttpsError('permission-denied', 'Solo administradores pueden ejecutar esta accion.');
};
exports.assertAdminUser = assertAdminUser;
const normalizeUserDefaultFeedTab = (value) => {
    const normalized = (0, exports.sanitizeBoundedString)(value, 40).toLowerCase();
    if (USER_DEFAULT_FEED_TAB_VALUES.has(normalized)) {
        return normalized;
    }
    return 'todo';
};
exports.normalizeUserDefaultFeedTab = normalizeUserDefaultFeedTab;
const normalizeUsernameCandidate = (value) => {
    const raw = (0, exports.sanitizeBoundedString)(value, exports.USERNAME_MAX_LENGTH);
    return raw
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
};
exports.normalizeUsernameCandidate = normalizeUsernameCandidate;
const buildFallbackUsername = (userId) => {
    const compactUid = userId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    const base = `user_${compactUid || 'perfil'}`;
    const trimmed = base.slice(0, exports.USERNAME_MAX_LENGTH);
    return trimmed.length >= exports.USERNAME_MIN_LENGTH
        ? trimmed
        : `${trimmed}${'x'.repeat(exports.USERNAME_MIN_LENGTH - trimmed.length)}`;
};
exports.buildFallbackUsername = buildFallbackUsername;
const normalizeUsernameStrict = (value) => {
    const username = (0, exports.normalizeUsernameCandidate)(value);
    if (username.length < exports.USERNAME_MIN_LENGTH ||
        username.length > exports.USERNAME_MAX_LENGTH ||
        !exports.USERNAME_REGEX.test(username)) {
        throw new functions.https.HttpsError('invalid-argument', `username debe tener entre ${exports.USERNAME_MIN_LENGTH} y ${exports.USERNAME_MAX_LENGTH} caracteres, solo [a-z0-9_].`);
    }
    return { username, usernameLower: username };
};
exports.normalizeUsernameStrict = normalizeUsernameStrict;
const normalizeUsernameLoose = (userId, userData) => {
    const fromLower = typeof (userData === null || userData === void 0 ? void 0 : userData.usernameLower) === 'string'
        ? (0, exports.normalizeUsernameCandidate)(userData.usernameLower)
        : '';
    if (fromLower.length >= exports.USERNAME_MIN_LENGTH &&
        fromLower.length <= exports.USERNAME_MAX_LENGTH &&
        exports.USERNAME_REGEX.test(fromLower)) {
        return { username: fromLower, usernameLower: fromLower };
    }
    const fromUsername = (0, exports.normalizeUsernameCandidate)(userData === null || userData === void 0 ? void 0 : userData.username);
    if (fromUsername.length >= exports.USERNAME_MIN_LENGTH &&
        fromUsername.length <= exports.USERNAME_MAX_LENGTH &&
        exports.USERNAME_REGEX.test(fromUsername)) {
        return { username: fromUsername, usernameLower: fromUsername };
    }
    const fallback = (0, exports.buildFallbackUsername)(userId);
    return { username: fallback, usernameLower: fallback };
};
exports.normalizeUsernameLoose = normalizeUsernameLoose;
const toBoolean = (value, fallback) => typeof value === 'boolean' ? value : fallback;
const ensureNotificationTypeSettings = (value) => {
    const raw = (value && typeof value === 'object'
        ? value
        : {});
    return {
        likes: toBoolean(raw.likes, exports.NOTIFICATION_TYPE_DEFAULTS.likes),
        comments: toBoolean(raw.comments, exports.NOTIFICATION_TYPE_DEFAULTS.comments),
        replies: toBoolean(raw.replies, exports.NOTIFICATION_TYPE_DEFAULTS.replies),
        follows: toBoolean(raw.follows, exports.NOTIFICATION_TYPE_DEFAULTS.follows)
    };
};
exports.ensureNotificationTypeSettings = ensureNotificationTypeSettings;
const isNotificationTypeEnabled = (typeSettings, notificationType) => {
    if (notificationType === 'like')
        return typeSettings.likes;
    if (notificationType === 'comment')
        return typeSettings.comments;
    if (notificationType === 'reply')
        return typeSettings.replies;
    return typeSettings.follows;
};
exports.isNotificationTypeEnabled = isNotificationTypeEnabled;
const readStatValue = (stats, key) => {
    var _a;
    const raw = Number((_a = stats[key]) !== null && _a !== void 0 ? _a : 0);
    if (!Number.isFinite(raw))
        return 0;
    return Math.max(0, Math.floor(raw));
};
const ensureUserStats = (value) => {
    const stats = (value && typeof value === 'object'
        ? value
        : {});
    return {
        postsCount: readStatValue(stats, 'postsCount'),
        followersCount: readStatValue(stats, 'followersCount'),
        followingCount: readStatValue(stats, 'followingCount'),
        likesTotalCount: readStatValue(stats, 'likesTotalCount')
    };
};
exports.ensureUserStats = ensureUserStats;
const ensureUserSettings = (value) => {
    if (!value || typeof value !== 'object') {
        return {
            notificationsEnabled: true,
            privateAccount: false,
            defaultFeedTab: 'todo',
            notificationTypes: Object.assign({}, exports.NOTIFICATION_TYPE_DEFAULTS)
        };
    }
    const settings = value;
    return Object.assign(Object.assign({}, settings), { notificationsEnabled: settings.notificationsEnabled !== false, privateAccount: settings.privateAccount === true, defaultFeedTab: (0, exports.normalizeUserDefaultFeedTab)(settings.defaultFeedTab), notificationTypes: (0, exports.ensureNotificationTypeSettings)(settings.notificationTypes) });
};
exports.ensureUserSettings = ensureUserSettings;
const buildPublicUserProfile = (userId, userData) => {
    const { username, usernameLower } = (0, exports.normalizeUsernameLoose)(userId, userData);
    const stats = (0, exports.ensureUserStats)(userData === null || userData === void 0 ? void 0 : userData.stats);
    return {
        userId,
        username,
        usernameLower,
        nombre: (0, exports.sanitizeBoundedString)(userData === null || userData === void 0 ? void 0 : userData.nombre, 120) || 'Usuario',
        bio: (0, exports.sanitizeBoundedString)(userData === null || userData === void 0 ? void 0 : userData.bio, 280),
        location: (0, exports.sanitizeBoundedString)(userData === null || userData === void 0 ? void 0 : userData.location, 120),
        website: (0, exports.sanitizeBoundedString)(userData === null || userData === void 0 ? void 0 : userData.website, 240),
        profilePictureUrl: (0, exports.sanitizeBoundedString)(userData === null || userData === void 0 ? void 0 : userData.profilePictureUrl, 1200),
        isVerified: (userData === null || userData === void 0 ? void 0 : userData.isVerified) === true,
        rol: typeof (userData === null || userData === void 0 ? void 0 : userData.rol) === 'string' ? userData.rol : 'usuario',
        stats,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
};
exports.buildPublicUserProfile = buildPublicUserProfile;
const propagateUserFields = async (db, target, userId, updateData) => {
    let baseQuery;
    if (target === 'content') {
        baseQuery = db.collection('content').where('userId', '==', userId);
    }
    else {
        baseQuery = db.collectionGroup(target).where('userId', '==', userId);
    }
    let snapshot = await baseQuery.limit(exports.USER_PROPAGATION_QUERY_PAGE_SIZE).get();
    let batch = db.batch();
    let batchCount = 0;
    let totalUpdated = 0;
    while (!snapshot.empty) {
        for (const targetDoc of snapshot.docs) {
            batch.update(targetDoc.ref, updateData);
            batchCount += 1;
            totalUpdated += 1;
            if (batchCount >= exports.USER_PROPAGATION_BATCH_WRITE_LIMIT) {
                await batch.commit();
                batch = db.batch();
                batchCount = 0;
            }
        }
        const lastDoc = snapshot.docs[snapshot.docs.length - 1];
        snapshot = await baseQuery.startAfter(lastDoc).limit(exports.USER_PROPAGATION_QUERY_PAGE_SIZE).get();
    }
    if (batchCount > 0) {
        await batch.commit();
    }
    return totalUpdated;
};
exports.propagateUserFields = propagateUserFields;
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
exports.normalizeOptionIds = normalizeOptionIds;
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
exports.normalizeSurveyOptions = normalizeSurveyOptions;
//# sourceMappingURL=userUtils.js.map