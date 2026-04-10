"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onAdEventCreated = exports.completeExpiredSurveys = exports.submitSurveyVote = exports.drawLotteryWinner = exports.enterLottery = exports.uploadCommunityImageToHosting = exports.onCommunityPostImageFinalized = exports.onOfficialNewsReceived = exports.onContentDeleted = exports.onContentCreated = exports.onUserUpdated = exports.syncPublicUserProfile = exports.updateMyProfile = exports.onFollowRemoved = exports.onFollowAdded = exports.onReplyUpdated = exports.onReplyCreated = exports.onCommentUpdated = exports.onCommentCreated = exports.toggleContentLike = exports.onLikeRemoved = exports.onLikeAdded = void 0;
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const stream_1 = require("stream");
const ftp = require("basic-ftp");
const sharp = require("sharp");
admin.initializeApp();
const db = admin.firestore();
const MAX_SURVEY_OPTIONS_SELECTED = 10;
const SURVEY_COMPLETE_BATCH_SIZE = 200;
const COMMUNITY_THUMB_MAX_SIDE = 480;
const MAX_HOSTING_UPLOAD_BYTES = 6 * 1024 * 1024;
const USER_PROPAGATION_QUERY_PAGE_SIZE = 100;
const USER_PROPAGATION_BATCH_WRITE_LIMIT = 450;
const LIKE_WRITER_CALLABLE = 'callable_toggle_v1';
const LOTTERY_DEFAULT_MAX_NUMBER = 100;
const LOTTERY_MIN_MAX_NUMBER = 10;
const LOTTERY_MAX_MAX_NUMBER = 200;
const LOTTERY_DEFAULT_MAX_TICKETS_PER_USER = 1;
const LOTTERY_MIN_TICKETS_PER_USER = 1;
const LOTTERY_MAX_TICKETS_PER_USER = 5;
const LOTTERY_ENTRY_SCHEMA_VERSION = 2;
const LOTTERY_ENTRY_DOC_PREFIX = 'n_';
const LOTTERY_MIGRATION_PAGE_SIZE = 400;
const LOTTERY_MIGRATION_BATCH_SIZE = 400;
const MAX_LOTTERY_DRAW_ENTRIES = 5000;
const COMMUNITY_THUMBNAIL_BUCKET = process.env.COMMUNITY_IMAGES_BUCKET || 'cdeluar-ddefc-storage';
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 30;
const USERNAME_REGEX = /^[a-z0-9_]+$/;
const buildCommentRef = (contentId, commentId) => db.collection('content').doc(contentId).collection('comments').doc(commentId);
const inferContentModule = (contentData) => {
    if ((contentData === null || contentData === void 0 ? void 0 : contentData.module) === 'news' || (contentData === null || contentData === void 0 ? void 0 : contentData.type) === 'news') {
        return 'news';
    }
    return 'community';
};
const isLikeModuleEnabledForContent = (modulesConfig, moduleName) => {
    var _a, _b, _c, _d;
    const likesConfig = (_a = modulesConfig === null || modulesConfig === void 0 ? void 0 : modulesConfig.likes) !== null && _a !== void 0 ? _a : {};
    const likesEnabled = (_b = likesConfig.enabled) !== null && _b !== void 0 ? _b : true;
    const likesNewsEnabled = (_c = likesConfig.newsEnabled) !== null && _c !== void 0 ? _c : true;
    const likesCommunityEnabled = (_d = likesConfig.communityEnabled) !== null && _d !== void 0 ? _d : true;
    if (!likesEnabled)
        return false;
    return moduleName === 'news' ? likesNewsEnabled : likesCommunityEnabled;
};
const isLotteryModuleEnabled = (modulesConfig) => {
    var _a, _b;
    const lotteryConfig = (_a = modulesConfig === null || modulesConfig === void 0 ? void 0 : modulesConfig.lottery) !== null && _a !== void 0 ? _a : {};
    return (_b = lotteryConfig.enabled) !== null && _b !== void 0 ? _b : true;
};
const clampInteger = (value, min, max, fallback) => {
    const raw = Number(value);
    if (!Number.isFinite(raw))
        return fallback;
    const parsed = Math.floor(raw);
    if (!Number.isFinite(parsed))
        return fallback;
    if (parsed < min)
        return min;
    if (parsed > max)
        return max;
    return parsed;
};
const normalizeLotteryMaxNumber = (value) => {
    return clampInteger(value, LOTTERY_MIN_MAX_NUMBER, LOTTERY_MAX_MAX_NUMBER, LOTTERY_DEFAULT_MAX_NUMBER);
};
const normalizeLotteryMaxTicketsPerUser = (value) => {
    return clampInteger(value, LOTTERY_MIN_TICKETS_PER_USER, LOTTERY_MAX_TICKETS_PER_USER, LOTTERY_DEFAULT_MAX_TICKETS_PER_USER);
};
const parseSelectedLotteryNumber = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return null;
    const normalized = Math.floor(parsed);
    if (!Number.isFinite(normalized) || normalized !== parsed)
        return null;
    if (normalized <= 0)
        return null;
    return normalized;
};
const toLotteryEntryDocId = (selectedNumber) => {
    return `${LOTTERY_ENTRY_DOC_PREFIX}${selectedNumber}`;
};
const extractSelectedNumberFromEntryDoc = (entryDoc) => {
    const data = entryDoc.data() || {};
    const selectedRaw = parseSelectedLotteryNumber(data.selectedNumber);
    if (selectedRaw != null)
        return selectedRaw;
    const matches = entryDoc.id.match(/^n_(\d+)$/);
    if (!matches)
        return null;
    return parseSelectedLotteryNumber(matches[1]);
};
const normalizeRoleAlias = (value) => {
    return typeof value === 'string'
        ? value.trim().toLowerCase().replace(/[\s_-]+/g, '')
        : '';
};
const isAdminClaim = (token) => {
    return token.admin === true ||
        token.superAdmin === true ||
        token.super_admin === true;
};
const isStaffRole = (role) => {
    const normalized = normalizeRoleAlias(role);
    return normalized === 'colaborador' ||
        normalized === 'admin' ||
        normalized === 'administrador' ||
        normalized === 'superadmin';
};
const assertStaffUser = async (authContext) => {
    var _a;
    const uid = (authContext === null || authContext === void 0 ? void 0 : authContext.uid) || '';
    if (!uid) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para ejecutar esta accion.');
    }
    const token = ((authContext === null || authContext === void 0 ? void 0 : authContext.token) || {});
    const email = typeof token.email === 'string' ? token.email.toLowerCase() : '';
    if (uid === 'Z4f5ogXDQaNhEY4iBf9jgkPnQMP2' ||
        email === 'matias4315@gmail.com' ||
        isAdminClaim(token)) {
        return;
    }
    const userSnap = await db.collection('users').doc(uid).get();
    const role = (_a = userSnap.data()) === null || _a === void 0 ? void 0 : _a.rol;
    if (isStaffRole(role))
        return;
    throw new functions.https.HttpsError('permission-denied', 'Solo staff puede ejecutar esta accion.');
};
const sanitizeBoundedString = (value, maxLength) => {
    if (typeof value !== 'string')
        return '';
    return value.trim().slice(0, maxLength);
};
const normalizeUsernameCandidate = (value) => {
    const raw = sanitizeBoundedString(value, USERNAME_MAX_LENGTH);
    return raw
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
};
const buildFallbackUsername = (userId) => {
    const compactUid = userId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    const base = `user_${compactUid || 'perfil'}`;
    const trimmed = base.slice(0, USERNAME_MAX_LENGTH);
    return trimmed.length >= USERNAME_MIN_LENGTH
        ? trimmed
        : `${trimmed}${'x'.repeat(USERNAME_MIN_LENGTH - trimmed.length)}`;
};
const normalizeUsernameStrict = (value) => {
    const username = normalizeUsernameCandidate(value);
    if (username.length < USERNAME_MIN_LENGTH ||
        username.length > USERNAME_MAX_LENGTH ||
        !USERNAME_REGEX.test(username)) {
        throw new functions.https.HttpsError('invalid-argument', `username debe tener entre ${USERNAME_MIN_LENGTH} y ${USERNAME_MAX_LENGTH} caracteres, solo [a-z0-9_].`);
    }
    return { username, usernameLower: username };
};
const normalizeUsernameLoose = (userId, userData) => {
    const fromLower = typeof (userData === null || userData === void 0 ? void 0 : userData.usernameLower) === 'string'
        ? normalizeUsernameCandidate(userData.usernameLower)
        : '';
    if (fromLower.length >= USERNAME_MIN_LENGTH &&
        fromLower.length <= USERNAME_MAX_LENGTH &&
        USERNAME_REGEX.test(fromLower)) {
        return { username: fromLower, usernameLower: fromLower };
    }
    const fromUsername = normalizeUsernameCandidate(userData === null || userData === void 0 ? void 0 : userData.username);
    if (fromUsername.length >= USERNAME_MIN_LENGTH &&
        fromUsername.length <= USERNAME_MAX_LENGTH &&
        USERNAME_REGEX.test(fromUsername)) {
        return { username: fromUsername, usernameLower: fromUsername };
    }
    const fallback = buildFallbackUsername(userId);
    return { username: fallback, usernameLower: fallback };
};
const sanitizeOptionalUrl = (value, fieldName) => {
    const raw = sanitizeBoundedString(value, 240);
    if (!raw)
        return '';
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
        const parsed = new URL(withProtocol);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('unsupported-protocol');
        }
        return parsed.toString().slice(0, 240);
    }
    catch (_a) {
        throw new functions.https.HttpsError('invalid-argument', `${fieldName} debe ser una URL valida (http/https).`);
    }
};
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
const ensureUserSettings = (value) => {
    if (!value || typeof value !== 'object') {
        return {
            notificationsEnabled: true,
            privateAccount: false
        };
    }
    const settings = value;
    return Object.assign(Object.assign({}, settings), { notificationsEnabled: settings.notificationsEnabled !== false, privateAccount: settings.privateAccount === true });
};
const buildPublicUserProfile = (userId, userData) => {
    const { username, usernameLower } = normalizeUsernameLoose(userId, userData);
    const stats = ensureUserStats(userData === null || userData === void 0 ? void 0 : userData.stats);
    return {
        userId,
        username,
        usernameLower,
        nombre: sanitizeBoundedString(userData === null || userData === void 0 ? void 0 : userData.nombre, 120) || 'Usuario',
        bio: sanitizeBoundedString(userData === null || userData === void 0 ? void 0 : userData.bio, 280),
        location: sanitizeBoundedString(userData === null || userData === void 0 ? void 0 : userData.location, 120),
        website: sanitizeBoundedString(userData === null || userData === void 0 ? void 0 : userData.website, 240),
        profilePictureUrl: sanitizeBoundedString(userData === null || userData === void 0 ? void 0 : userData.profilePictureUrl, 1200),
        isVerified: (userData === null || userData === void 0 ? void 0 : userData.isVerified) === true,
        stats,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
};
const propagateUserFields = async (target, userId, updateData) => {
    let baseQuery;
    if (target === 'content') {
        baseQuery = db.collection('content').where('userId', '==', userId);
    }
    else {
        baseQuery = db.collectionGroup(target).where('userId', '==', userId);
    }
    let snapshot = await baseQuery.limit(USER_PROPAGATION_QUERY_PAGE_SIZE).get();
    let batch = db.batch();
    let batchCount = 0;
    let totalUpdated = 0;
    while (!snapshot.empty) {
        for (const targetDoc of snapshot.docs) {
            batch.update(targetDoc.ref, updateData);
            batchCount += 1;
            totalUpdated += 1;
            if (batchCount >= USER_PROPAGATION_BATCH_WRITE_LIMIT) {
                await batch.commit();
                batch = db.batch();
                batchCount = 0;
            }
        }
        const lastDoc = snapshot.docs[snapshot.docs.length - 1];
        snapshot = await baseQuery.startAfter(lastDoc).limit(USER_PROPAGATION_QUERY_PAGE_SIZE).get();
    }
    if (batchCount > 0) {
        await batch.commit();
    }
    return totalUpdated;
};
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
const ensureImageMime = (value) => {
    const mime = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!mime.startsWith('image/')) {
        throw new functions.https.HttpsError('invalid-argument', 'Formato de archivo invalido.');
    }
    return mime;
};
const decodeBase64Payload = (value) => {
    if (typeof value !== 'string' || !value.trim()) {
        throw new functions.https.HttpsError('invalid-argument', 'No se recibio imagen.');
    }
    const sanitized = value.replace(/^data:[^;]+;base64,/, '').trim();
    const buffer = Buffer.from(sanitized, 'base64');
    if (buffer.length === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'No se pudo decodificar la imagen.');
    }
    if (buffer.length > MAX_HOSTING_UPLOAD_BYTES) {
        throw new functions.https.HttpsError('invalid-argument', 'La imagen supera el limite permitido.');
    }
    return buffer;
};
const sanitizePathSegment = (value) => {
    const sanitized = value
        .replace(/[^a-zA-Z0-9/_.-]/g, '-')
        .replace(/\.\.+/g, '.')
        .replace(/\/+/g, '/')
        .replace(/^\//, '')
        .replace(/\/$/, '');
    return sanitized;
};
const getHostingFtpConfig = () => {
    const host = process.env.HOSTING_FTP_HOST || '';
    const user = process.env.HOSTING_FTP_USER || '';
    const password = process.env.HOSTING_FTP_PASSWORD || '';
    const basePath = process.env.HOSTING_FTP_BASE_PATH || '/domains/cdelu.ar/public_html/imagenes';
    const publicBaseUrl = process.env.HOSTING_PUBLIC_BASE_URL || 'https://cdelu.ar/imagenes';
    const port = Number(process.env.HOSTING_FTP_PORT || 21);
    if (!host || !user || !password) {
        throw new functions.https.HttpsError('failed-precondition', 'Falta configurar credenciales FTP del hosting.');
    }
    return {
        host,
        user,
        password,
        port: Number.isFinite(port) ? port : 21,
        basePath,
        publicBaseUrl: publicBaseUrl.replace(/\/$/, '')
    };
};
// 1. Likes
exports.onLikeAdded = functions.firestore
    .document('content/{contentId}/likes/{userId}')
    .onCreate(async (snap, context) => {
    const { contentId } = context.params;
    const likeData = snap.data() || {};
    if (likeData.writer === LIKE_WRITER_CALLABLE)
        return;
    try {
        await db.collection('content').doc(contentId).update({
            'stats.likesCount': admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
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
        const moduleName = inferContentModule(contentData);
        const isEnabled = isLikeModuleEnabledForContent(modulesConfigSnap.data(), moduleName);
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
// 2. Comments
exports.onCommentCreated = functions.firestore
    .document('content/{contentId}/comments/{commentId}')
    .onCreate(async (snap, context) => {
    const { contentId } = context.params;
    const commentData = snap.data();
    if (!commentData || !commentData.userId || commentData.deletedAt != null)
        return;
    try {
        await db.collection('content').doc(contentId).set({
            stats: {
                commentsCount: admin.firestore.FieldValue.increment(1)
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
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
    const { contentId, commentId } = context.params;
    const replyData = snap.data();
    if (!replyData || !replyData.userId || replyData.deletedAt != null)
        return;
    try {
        await buildCommentRef(contentId, commentId).set({
            stats: {
                repliesCount: admin.firestore.FieldValue.increment(1)
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
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
        await buildCommentRef(contentId, commentId).set({
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
    const { username, usernameLower } = normalizeUsernameStrict(data === null || data === void 0 ? void 0 : data.username);
    const nombre = sanitizeBoundedString(data === null || data === void 0 ? void 0 : data.nombre, 120);
    if (!nombre) {
        throw new functions.https.HttpsError('invalid-argument', 'nombre es obligatorio.');
    }
    const bio = sanitizeBoundedString(data === null || data === void 0 ? void 0 : data.bio, 280);
    const location = sanitizeBoundedString(data === null || data === void 0 ? void 0 : data.location, 120);
    const website = sanitizeOptionalUrl(data === null || data === void 0 ? void 0 : data.website, 'website');
    const profilePictureUrl = sanitizeBoundedString(data === null || data === void 0 ? void 0 : data.profilePictureUrl, 1200);
    const userRef = db.collection('users').doc(userId);
    const userPublicRef = db.collection('users_public').doc(userId);
    const usernameRef = db.collection('usernames').doc(usernameLower);
    const result = await db.runTransaction(async (tx) => {
        var _a, _b;
        const userSnap = await tx.get(userRef);
        const currentData = userSnap.exists
            ? (userSnap.data() || {})
            : {};
        const currentIdentity = normalizeUsernameLoose(userId, currentData);
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
        const mergedStats = ensureUserStats(currentData.stats);
        const mergedSettings = ensureUserSettings(currentData.settings);
        const nextProfile = {
            id: userId,
            email: sanitizeBoundedString(currentData.email, 255) || emailFromToken,
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
        const publicProfile = buildPublicUserProfile(userId, nextProfile);
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
exports.syncPublicUserProfile = functions.firestore
    .document('users/{userId}')
    .onWrite(async (change, context) => {
    const { userId } = context.params;
    if (!change.after.exists) {
        const beforeData = change.before.data() || {};
        const previousIdentity = normalizeUsernameLoose(userId, beforeData);
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
    const currentIdentity = normalizeUsernameLoose(userId, afterData);
    const previousIdentity = normalizeUsernameLoose(userId, beforeData);
    const publicProfile = buildPublicUserProfile(userId, afterData);
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
            const normalizedIdentity = normalizeUsernameLoose(userId, afterData);
            postUpdateData.userUsername = normalizedIdentity.usernameLower;
        }
        const [postsUpdated, commentsUpdated, repliesUpdated] = await Promise.all([
            Object.keys(postUpdateData).length > 0
                ? propagateUserFields('content', userId, postUpdateData)
                : Promise.resolve(0),
            Object.keys(commentsUpdateData).length > 0
                ? propagateUserFields('comments', userId, commentsUpdateData)
                : Promise.resolve(0),
            Object.keys(commentsUpdateData).length > 0
                ? propagateUserFields('replies', userId, commentsUpdateData)
                : Promise.resolve(0)
        ]);
        console.log(`User profile updated for ${userId}: posts=${postsUpdated}, comments=${commentsUpdated}, replies=${repliesUpdated}`);
    }
    catch (error) {
        console.error(`âŒ User update propagation failed:`, error);
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
        console.error(`âŒ Content created increment failed:`, error);
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
            console.log(`âœ… Content soft-deleted: ${contentId}, postsCount decremented`);
        }
        else if (!wasAlive && !isNowDeleted) {
            const userId = afterData.userId;
            await db.collection('users').doc(userId).update({
                'stats.postsCount': admin.firestore.FieldValue.increment(1),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`âœ… Content restored: ${contentId}, postsCount incremented`);
        }
    }
    catch (error) {
        console.error(`âŒ Content deletion handling failed:`, error);
    }
});
// 5. IntegraciÃ³n Oficial de Noticias desde WordPress via Realtime Database
exports.onOfficialNewsReceived = functions.database
    .ref('/news/{newsId}')
    .onWrite(async (change, context) => {
    var _a, _b, _c;
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
            titulo: afterData.titulo || 'Sin TÃ­tulo',
            descripcion: afterData.descripcion || '',
            images: Array.isArray(afterData.images) ? afterData.images : [],
            userId: afterData.userId || 'wp_official',
            userName: afterData.userName || 'RedacciÃ³n CdeluAR',
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
        console.log(`âœ… Noticia sincronizada en Firestore: ${newsId}`);
        return null;
    }
    catch (error) {
        console.error(`âŒ FallÃ³ la sincronizaciÃ³n de RTDB a Firestore para ${newsId}:`, error);
        return null;
    }
});
// 6. Community image thumbnails
exports.onCommunityPostImageFinalized = functions.storage
    .bucket(COMMUNITY_THUMBNAIL_BUCKET)
    .object()
    .onFinalize(async (object) => {
    const filePath = object.name;
    const contentType = object.contentType || '';
    const bucketName = object.bucket;
    const metadata = object.metadata || {};
    if (!filePath || !bucketName)
        return null;
    if (!filePath.startsWith('posts/'))
        return null;
    if (!contentType.startsWith('image/'))
        return null;
    if (filePath.includes('/thumbs/'))
        return null;
    if (metadata.generatedBy === 'community-thumbnail')
        return null;
    const ext = path.posix.extname(filePath).toLowerCase();
    const baseName = path.posix.basename(filePath, ext);
    if (baseName.endsWith('_t') || baseName.endsWith('-thumb'))
        return null;
    const directory = path.posix.dirname(filePath);
    const thumbPath = `${directory}/thumbs/${baseName}.webp`;
    const bucket = admin.storage().bucket(bucketName);
    const thumbFile = bucket.file(thumbPath);
    const [alreadyExists] = await thumbFile.exists();
    if (alreadyExists)
        return null;
    const sourceTempFile = path.join(os.tmpdir(), `${Date.now()}-${path.basename(filePath)}`);
    const thumbTempFile = path.join(os.tmpdir(), `${Date.now()}-${baseName}.webp`);
    try {
        await bucket.file(filePath).download({ destination: sourceTempFile });
        await sharp(sourceTempFile)
            .rotate()
            .resize(COMMUNITY_THUMB_MAX_SIDE, COMMUNITY_THUMB_MAX_SIDE, {
            fit: 'inside',
            withoutEnlargement: true
        })
            .webp({ quality: 78, effort: 4 })
            .toFile(thumbTempFile);
        await bucket.upload(thumbTempFile, {
            destination: thumbPath,
            metadata: {
                contentType: 'image/webp',
                cacheControl: 'public,max-age=604800',
                metadata: {
                    generatedBy: 'community-thumbnail',
                    sourcePath: filePath
                }
            }
        });
    }
    catch (error) {
        console.error('Thumbnail generation failed', { filePath, error });
    }
    finally {
        await Promise.all([
            fs.unlink(sourceTempFile).catch(() => undefined),
            fs.unlink(thumbTempFile).catch(() => undefined)
        ]);
    }
    return null;
});
// 7. Hosting FTP image upload fallback for community posts
exports.uploadCommunityImageToHosting = functions.https.onCall(async (data, context) => {
    var _a;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para subir imagenes.');
    }
    const relativePathRaw = typeof (data === null || data === void 0 ? void 0 : data.path) === 'string' ? data.path.trim() : '';
    const contentType = ensureImageMime(data === null || data === void 0 ? void 0 : data.contentType);
    const base64Data = decodeBase64Payload(data === null || data === void 0 ? void 0 : data.base64Data);
    if (!relativePathRaw) {
        throw new functions.https.HttpsError('invalid-argument', 'Ruta de imagen invalida.');
    }
    const relativePath = sanitizePathSegment(relativePathRaw).replace(/^imagenes\//, '');
    const allowedPrefix = `posts/${userId}/`;
    const allowedAvatarPrefix = `avatars/${userId}/`;
    if (!relativePath.startsWith(allowedPrefix) && !relativePath.startsWith(allowedAvatarPrefix)) {
        throw new functions.https.HttpsError('permission-denied', 'Ruta de subida no permitida.');
    }
    const ext = path.posix.extname(relativePath).toLowerCase();
    const safeExt = ext && ext.length <= 6 ? ext : '.webp';
    const fileNameBase = path.posix.basename(relativePath, ext || undefined)
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .slice(0, 80) || `${Date.now()}`;
    const targetRelativePath = `${path.posix.dirname(relativePath)}/${fileNameBase}${safeExt}`.replace(/\/+/g, '/');
    const ftpConfig = getHostingFtpConfig();
    const remoteFilePath = `${ftpConfig.basePath}/${targetRelativePath}`.replace(/\/+/g, '/');
    const remoteDir = path.posix.dirname(remoteFilePath);
    const publicUrl = `${ftpConfig.publicBaseUrl}/${targetRelativePath}`;
    const ftpClient = new ftp.Client(30000);
    ftpClient.ftp.verbose = false;
    try {
        await ftpClient.access({
            host: ftpConfig.host,
            user: ftpConfig.user,
            password: ftpConfig.password,
            port: ftpConfig.port,
            secure: false
        });
        await ftpClient.ensureDir(remoteDir);
        await ftpClient.uploadFrom(stream_1.Readable.from(base64Data), remoteFilePath);
    }
    catch (error) {
        console.error('FTP hosting upload failed', { userId, relativePath: targetRelativePath, error });
        throw new functions.https.HttpsError('internal', 'No se pudo subir la imagen al hosting.');
    }
    finally {
        ftpClient.close();
    }
    return {
        url: publicUrl,
        path: targetRelativePath,
        sizeBytes: base64Data.length,
        contentType
    };
});
const listAllLotteryEntries = async (lotteryRef) => {
    const docs = [];
    let lastDocId = null;
    while (true) {
        let pageQuery = lotteryRef
            .collection('entries')
            .orderBy(admin.firestore.FieldPath.documentId())
            .limit(LOTTERY_MIGRATION_PAGE_SIZE);
        if (lastDocId) {
            pageQuery = pageQuery.startAfter(lastDocId);
        }
        const pageSnap = await pageQuery.get();
        if (pageSnap.empty)
            break;
        docs.push(...pageSnap.docs);
        if (pageSnap.size < LOTTERY_MIGRATION_PAGE_SIZE)
            break;
        lastDocId = pageSnap.docs[pageSnap.docs.length - 1].id;
    }
    return docs;
};
const ensureLotteryEntriesSchemaV2 = async (lotteryId) => {
    const lotteryRef = db.collection('lotteries').doc(lotteryId);
    let maxNumber = LOTTERY_DEFAULT_MAX_NUMBER;
    let maxTicketsPerUser = LOTTERY_DEFAULT_MAX_TICKETS_PER_USER;
    let mustRunMigration = false;
    let needsDefaultsPatch = false;
    await db.runTransaction(async (tx) => {
        const lotterySnap = await tx.get(lotteryRef);
        if (!lotterySnap.exists) {
            throw new functions.https.HttpsError('not-found', 'La loteria no existe.');
        }
        const lotteryData = lotterySnap.data() || {};
        maxNumber = normalizeLotteryMaxNumber(lotteryData.maxNumber);
        maxTicketsPerUser = normalizeLotteryMaxTicketsPerUser(lotteryData.maxTicketsPerUser);
        const schemaRaw = Number(lotteryData.entrySchemaVersion || 0);
        const schemaVersion = Number.isFinite(schemaRaw) ? Math.floor(schemaRaw) : 0;
        const migrationStatusRaw = typeof lotteryData.migrationStatus === 'string'
            ? lotteryData.migrationStatus
            : '';
        const migrationStatus = migrationStatusRaw;
        const isAlreadyV2 = schemaVersion >= LOTTERY_ENTRY_SCHEMA_VERSION;
        if (isAlreadyV2 && migrationStatus !== 'failed') {
            const hasValidDefaults = lotteryData.maxNumber === maxNumber &&
                lotteryData.maxTicketsPerUser === maxTicketsPerUser &&
                migrationStatus === 'done';
            needsDefaultsPatch = !hasValidDefaults;
            return;
        }
        if (migrationStatus === 'running') {
            throw new functions.https.HttpsError('failed-precondition', 'migration-in-progress: La loteria esta migrando entradas, intenta nuevamente en unos segundos.');
        }
        mustRunMigration = true;
        tx.set(lotteryRef, {
            migrationStatus: 'running',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    });
    if (!mustRunMigration) {
        if (needsDefaultsPatch) {
            await lotteryRef.set({
                maxNumber,
                maxTicketsPerUser,
                migrationStatus: 'done',
                entrySchemaVersion: LOTTERY_ENTRY_SCHEMA_VERSION,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
        return;
    }
    try {
        const allEntries = await listAllLotteryEntries(lotteryRef);
        const usedNumbers = new Set();
        const nextAvailableNumber = (() => {
            let cursor = 1;
            return () => {
                while (cursor <= maxNumber) {
                    const candidate = cursor;
                    cursor += 1;
                    if (!usedNumbers.has(candidate)) {
                        usedNumbers.add(candidate);
                        return candidate;
                    }
                }
                return null;
            };
        })();
        const plannedEntries = [];
        const deferredEntries = [];
        for (const entryDoc of allEntries) {
            const parsedSelected = extractSelectedNumberFromEntryDoc(entryDoc);
            const isSelectable = parsedSelected != null && parsedSelected >= 1 && parsedSelected <= maxNumber;
            if (!isSelectable || usedNumbers.has(parsedSelected)) {
                deferredEntries.push(entryDoc);
                continue;
            }
            usedNumbers.add(parsedSelected);
            plannedEntries.push({
                source: entryDoc,
                selectedNumber: parsedSelected,
                targetId: toLotteryEntryDocId(parsedSelected)
            });
        }
        for (const entryDoc of deferredEntries) {
            const assigned = nextAvailableNumber();
            if (assigned == null) {
                throw new functions.https.HttpsError('failed-precondition', 'No hay suficientes numeros disponibles para migrar las entradas legacy. Aumenta maxNumber.');
            }
            plannedEntries.push({
                source: entryDoc,
                selectedNumber: assigned,
                targetId: toLotteryEntryDocId(assigned)
            });
        }
        let batch = db.batch();
        let writes = 0;
        const flush = async () => {
            if (writes === 0)
                return;
            await batch.commit();
            batch = db.batch();
            writes = 0;
        };
        for (const planned of plannedEntries) {
            const sourceData = planned.source.data() || {};
            const userIdRaw = typeof sourceData.userId === 'string' ? sourceData.userId.trim() : '';
            const fallbackUserId = planned.source.id;
            const userId = userIdRaw || fallbackUserId;
            const userNameRaw = typeof sourceData.userName === 'string' ? sourceData.userName.trim() : '';
            const userName = userNameRaw || 'Usuario';
            const profilePicRaw = typeof sourceData.userProfilePicUrl === 'string'
                ? sourceData.userProfilePicUrl.trim()
                : '';
            const payload = {
                userId,
                userName: userName.slice(0, 120),
                userProfilePicUrl: profilePicRaw,
                lotteryId,
                selectedNumber: planned.selectedNumber,
                createdAt: sourceData.createdAt instanceof admin.firestore.Timestamp
                    ? sourceData.createdAt
                    : admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            };
            const targetRef = lotteryRef.collection('entries').doc(planned.targetId);
            batch.set(targetRef, payload, { merge: true });
            writes += 1;
            if (planned.source.ref.path !== targetRef.path) {
                batch.delete(planned.source.ref);
                writes += 1;
            }
            if (writes >= LOTTERY_MIGRATION_BATCH_SIZE) {
                await flush();
            }
        }
        batch.set(lotteryRef, {
            maxNumber,
            maxTicketsPerUser,
            participantsCount: plannedEntries.length,
            entrySchemaVersion: LOTTERY_ENTRY_SCHEMA_VERSION,
            migrationStatus: 'done',
            migrationError: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        writes += 1;
        await flush();
    }
    catch (error) {
        await lotteryRef.set({
            migrationStatus: 'failed',
            migrationError: typeof (error === null || error === void 0 ? void 0 : error.message) === 'string'
                ? error.message.slice(0, 300)
                : 'migration-failed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        throw error;
    }
};
// 8. Lottery entry callable (number-based entries, supports multiple tickets per user)
exports.enterLottery = functions.https.onCall(async (data, context) => {
    var _a, _b;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para participar en la loteria.');
    }
    const lotteryId = typeof (data === null || data === void 0 ? void 0 : data.lotteryId) === 'string' ? data.lotteryId.trim() : '';
    const selectedNumber = parseSelectedLotteryNumber(data === null || data === void 0 ? void 0 : data.selectedNumber);
    const idempotencyKeyRaw = typeof (data === null || data === void 0 ? void 0 : data.idempotencyKey) === 'string'
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
    const token = (((_b = context.auth) === null || _b === void 0 ? void 0 : _b.token) || {});
    const fallbackEmail = typeof token.email === 'string' ? token.email : '';
    const fallbackName = fallbackEmail ? fallbackEmail.split('@')[0] : 'Usuario';
    const userNameRaw = typeof userData.nombre === 'string' ? userData.nombre : fallbackName;
    const userProfilePicRaw = typeof userData.profilePictureUrl === 'string'
        ? userData.profilePictureUrl
        : '';
    const userName = userNameRaw.trim().slice(0, 120) || 'Usuario';
    const userProfilePicUrl = userProfilePicRaw.trim();
    const modulesConfigRef = db.collection('_config').doc('modules');
    const lotteryRef = db.collection('lotteries').doc(lotteryId);
    const entryRef = lotteryRef.collection('entries').doc(toLotteryEntryDocId(selectedNumber));
    const userEntriesQuery = lotteryRef
        .collection('entries')
        .where('userId', '==', userId)
        .limit(LOTTERY_MAX_TICKETS_PER_USER + 2);
    return db.runTransaction(async (tx) => {
        const [modulesConfigSnap, lotterySnap, entrySnap, userEntriesSnap] = await Promise.all([
            tx.get(modulesConfigRef),
            tx.get(lotteryRef),
            tx.get(entryRef),
            tx.get(userEntriesQuery)
        ]);
        if (!isLotteryModuleEnabled(modulesConfigSnap.data())) {
            throw new functions.https.HttpsError('failed-precondition', 'module-disabled: El modulo de loteria esta deshabilitado.');
        }
        if (!lotterySnap.exists) {
            throw new functions.https.HttpsError('not-found', 'La loteria no existe.');
        }
        const lotteryData = lotterySnap.data() || {};
        if (lotteryData.deletedAt != null) {
            throw new functions.https.HttpsError('failed-precondition', 'lottery-inactive: La loteria ya no esta disponible.');
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
        const maxNumber = normalizeLotteryMaxNumber(lotteryData.maxNumber);
        const maxTicketsPerUser = normalizeLotteryMaxTicketsPerUser(lotteryData.maxTicketsPerUser);
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
                    userTicketsCount: Math.max(1, userTicketsCount)
                };
            }
            throw new functions.https.HttpsError('already-exists', 'number-taken: El numero seleccionado ya esta ocupado.');
        }
        if (userTicketsCount >= maxTicketsPerUser) {
            throw new functions.https.HttpsError('failed-precondition', `limit-reached: Alcanzaste el maximo de ${maxTicketsPerUser} numeros para esta loteria.`);
        }
        const entryPayload = {
            userId,
            userName,
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
            entrySchemaVersion: LOTTERY_ENTRY_SCHEMA_VERSION,
            migrationStatus: 'done',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return {
            status: 'ok',
            lotteryId,
            selectedNumber,
            participantsCount: currentParticipants + 1,
            userTicketsCount: userTicketsCount + 1
        };
    });
});
// 9. Lottery draw callable (staff-only)
exports.drawLotteryWinner = functions.https.onCall(async (data, context) => {
    var _a;
    await assertStaffUser(context.auth);
    const lotteryId = typeof (data === null || data === void 0 ? void 0 : data.lotteryId) === 'string' ? data.lotteryId.trim() : '';
    if (!lotteryId) {
        throw new functions.https.HttpsError('invalid-argument', 'lotteryId es obligatorio.');
    }
    await ensureLotteryEntriesSchemaV2(lotteryId);
    const requesterUid = ((_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid) || 'system';
    const modulesConfigRef = db.collection('_config').doc('modules');
    const lotteryRef = db.collection('lotteries').doc(lotteryId);
    return db.runTransaction(async (tx) => {
        const [modulesConfigSnap, lotterySnap] = await Promise.all([
            tx.get(modulesConfigRef),
            tx.get(lotteryRef)
        ]);
        if (!isLotteryModuleEnabled(modulesConfigSnap.data())) {
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
            .limit(MAX_LOTTERY_DRAW_ENTRIES);
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
        const winnerSelectedNumber = parseSelectedLotteryNumber(winnerData.selectedNumber) || null;
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
            participantsCount
        };
    });
});
// 10. Surveys vote callable (single vote per user/survey)
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
            ? (isMultipleChoice ? Math.max(2, Math.floor(maxVotesRaw)) : 1)
            : (isMultipleChoice ? 2 : 1);
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
// 11. Auto-complete expired surveys
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
// 12. Ads metrics aggregation
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