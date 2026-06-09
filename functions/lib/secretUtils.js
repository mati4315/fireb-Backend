"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshSecretRankingsInternal = exports.buildSecretRankingsSnapshot = exports.takeUniqueSecretRankingItems = exports.toSecretRankingItem = exports.isSecretActiveForRanking = exports.computeSecretRank = exports.resolveSecretRuntimeSettings = exports.createSecretAlias = exports.buildSecretFingerprintHash = exports.timestampToMillisOrZero = exports.normalizeSecretClientAnonId = exports.normalizeSecretReportReason = exports.normalizeSecretAge = exports.normalizeSecretZone = exports.normalizeSecretSex = exports.normalizeSecretCategory = exports.sanitizeSecretText = exports.hasMeaningfulSecretText = exports.SECRET_RANKINGS_LIST_LIMIT = exports.SECRET_RANKINGS_SAMPLE_LIMIT = exports.SECRET_AUTO_HIDE_REPORT_THRESHOLD = exports.SECRET_FINGERPRINT_TTL_MS = exports.SECRET_DAILY_LIMIT = exports.SECRET_REPORT_REASON_MAX_LENGTH = exports.SECRET_ZONE_MAX_LENGTH = exports.SECRET_COMMENT_MAX_LENGTH = exports.SECRET_COMMENT_MIN_LENGTH = exports.SECRET_NUMERIC_ID_START = exports.SECRET_TEXT_MAX_ABSOLUTE = exports.SECRET_TEXT_MAX_LENGTH = exports.SECRET_TEXT_MIN_LENGTH = void 0;
const admin = require("firebase-admin");
const crypto = require("crypto");
const db = admin.firestore();
exports.SECRET_TEXT_MIN_LENGTH = 12;
exports.SECRET_TEXT_MAX_LENGTH = 280;
exports.SECRET_TEXT_MAX_ABSOLUTE = 500;
exports.SECRET_NUMERIC_ID_START = 8301641;
exports.SECRET_COMMENT_MIN_LENGTH = 2;
exports.SECRET_COMMENT_MAX_LENGTH = 300;
exports.SECRET_ZONE_MAX_LENGTH = 48;
exports.SECRET_REPORT_REASON_MAX_LENGTH = 140;
exports.SECRET_DAILY_LIMIT = 5;
exports.SECRET_FINGERPRINT_TTL_MS = 72 * 60 * 60 * 1000;
exports.SECRET_AUTO_HIDE_REPORT_THRESHOLD = 6;
exports.SECRET_RANKINGS_SAMPLE_LIMIT = 450;
exports.SECRET_RANKINGS_LIST_LIMIT = 12;
const SECRET_CATEGORY_VALUES = new Set([
    'rumores',
    'relaciones',
    'trabajo_negocios',
    'denuncia_light',
    'random_divertido'
]);
const SECRET_SEX_VALUES = new Set([
    'no_responder',
    'hombre',
    'mujer'
]);
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
const collapseWhitespace = (value) => value.replace(/\s+/g, ' ').trim();
const sanitizeBoundedString = (value, maxLength) => {
    if (typeof value !== 'string')
        return '';
    return value.trim().slice(0, maxLength);
};
const hasMeaningfulSecretText = (value) => /[0-9A-Za-z\u00C0-\u024F]/.test(value);
exports.hasMeaningfulSecretText = hasMeaningfulSecretText;
const sanitizeSecretText = (value, maxLength) => {
    const asString = typeof value === 'string' ? value : '';
    return collapseWhitespace(asString).slice(0, maxLength);
};
exports.sanitizeSecretText = sanitizeSecretText;
const normalizeSecretCategory = (value) => {
    const normalized = sanitizeBoundedString(value, 40).toLowerCase();
    if (!normalized)
        return null;
    return SECRET_CATEGORY_VALUES.has(normalized) ? normalized : null;
};
exports.normalizeSecretCategory = normalizeSecretCategory;
const normalizeSecretSex = (value) => {
    const normalized = sanitizeBoundedString(value, 20).toLowerCase();
    if (SECRET_SEX_VALUES.has(normalized)) {
        return normalized;
    }
    return 'no_responder';
};
exports.normalizeSecretSex = normalizeSecretSex;
const normalizeSecretZone = (value) => {
    const sanitized = (0, exports.sanitizeSecretText)(value, exports.SECRET_ZONE_MAX_LENGTH);
    return sanitized || null;
};
exports.normalizeSecretZone = normalizeSecretZone;
const normalizeSecretAge = (value) => {
    if (value == null || value === '')
        return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return null;
    const normalized = Math.floor(parsed);
    if (normalized < 13 || normalized > 99)
        return null;
    return normalized;
};
exports.normalizeSecretAge = normalizeSecretAge;
const normalizeSecretReportReason = (value) => {
    const reason = (0, exports.sanitizeSecretText)(value, exports.SECRET_REPORT_REASON_MAX_LENGTH);
    return reason || 'contenido_inapropiado';
};
exports.normalizeSecretReportReason = normalizeSecretReportReason;
const normalizeSecretClientAnonId = (value) => {
    const raw = sanitizeBoundedString(value, 120);
    return raw.replace(/[^a-zA-Z0-9_-]/g, '');
};
exports.normalizeSecretClientAnonId = normalizeSecretClientAnonId;
const timestampToMillisOrZero = (value) => {
    if (value instanceof admin.firestore.Timestamp)
        return value.toMillis();
    return 0;
};
exports.timestampToMillisOrZero = timestampToMillisOrZero;
const buildSecretFingerprintHash = (data, context) => {
    var _a, _b, _c;
    const rawRequest = context.rawRequest;
    const forwardedForHeader = (_a = rawRequest === null || rawRequest === void 0 ? void 0 : rawRequest.headers) === null || _a === void 0 ? void 0 : _a['x-forwarded-for'];
    const forwardedForValue = Array.isArray(forwardedForHeader)
        ? String(forwardedForHeader[0] || '')
        : String(forwardedForHeader || '');
    const forwardedIp = ((_b = forwardedForValue.split(',')[0]) === null || _b === void 0 ? void 0 : _b.trim()) || '';
    const requestIp = forwardedIp || String((rawRequest === null || rawRequest === void 0 ? void 0 : rawRequest.ip) || '');
    const userAgent = String(((_c = rawRequest === null || rawRequest === void 0 ? void 0 : rawRequest.headers) === null || _c === void 0 ? void 0 : _c['user-agent']) || '');
    const clientAnonId = (0, exports.normalizeSecretClientAnonId)(data === null || data === void 0 ? void 0 : data.clientAnonId);
    const projectTag = String(process.env.GCLOUD_PROJECT || 'cdelu');
    const pepper = String(process.env.SECRETS_FINGERPRINT_PEPPER || 'change_me_secretos_pepper_v1');
    const rawIdentity = [
        requestIp,
        userAgent,
        clientAnonId,
        projectTag
    ].join('|');
    return crypto
        .createHash('sha256')
        .update(`${pepper}|${rawIdentity}`)
        .digest('hex');
};
exports.buildSecretFingerprintHash = buildSecretFingerprintHash;
const createSecretAlias = (fingerprintHash, scope) => {
    const aliasSeed = crypto
        .createHash('sha1')
        .update(`${fingerprintHash}|${scope}`)
        .digest('hex')
        .slice(0, 8);
    const numeric = Number.parseInt(aliasSeed, 16) % 10000;
    return `Anon${String(numeric).padStart(4, '0')}`;
};
exports.createSecretAlias = createSecretAlias;
const resolveSecretRuntimeSettings = (data, fallbackTextLength = exports.SECRET_TEXT_MAX_LENGTH, fallbackDailyLimit = exports.SECRET_DAILY_LIMIT, fallbackAutoHide = exports.SECRET_AUTO_HIDE_REPORT_THRESHOLD) => {
    const maxTextLength = clampInteger(data === null || data === void 0 ? void 0 : data.maxTextLength, 120, 500, fallbackTextLength);
    const minTextLengthRaw = clampInteger(data === null || data === void 0 ? void 0 : data.minTextLength, 1, 80, exports.SECRET_TEXT_MIN_LENGTH);
    const minTextLength = Math.min(minTextLengthRaw, maxTextLength);
    const createCooldownMinutes = clampInteger(data === null || data === void 0 ? void 0 : data.createCooldownMinutes, 1, 240, 30);
    const commentCooldownSeconds = clampInteger(data === null || data === void 0 ? void 0 : data.commentCooldownSeconds, 1, 300, 20);
    const dailyLimit = clampInteger(data === null || data === void 0 ? void 0 : data.dailyLimit, 1, 30, fallbackDailyLimit);
    const autoHideReportsThreshold = clampInteger(data === null || data === void 0 ? void 0 : data.autoHideReportsThreshold, 1, 100, fallbackAutoHide);
    return {
        minTextLength,
        maxTextLength,
        createCooldownMs: createCooldownMinutes * 60 * 1000,
        commentCooldownMs: commentCooldownSeconds * 1000,
        dailyLimit,
        autoHideReportsThreshold
    };
};
exports.resolveSecretRuntimeSettings = resolveSecretRuntimeSettings;
const computeSecretRank = (upVotesCount, downVotesCount, commentsCount, createdAtMs) => {
    const safeUp = Math.max(0, Math.floor(Number(upVotesCount) || 0));
    const safeDown = Math.max(0, Math.floor(Number(downVotesCount) || 0));
    const safeComments = Math.max(0, Math.floor(Number(commentsCount) || 0));
    const totalVotes = safeUp + safeDown;
    const score = safeUp - safeDown;
    const ageHours = Math.max(0, (Date.now() - createdAtMs) / (60 * 60 * 1000));
    const engagementBoost = Math.log10(Math.max(1, totalVotes + safeComments + 1));
    const hotScoreRaw = score * 1.25 + safeComments * 0.8 + engagementBoost * 2.2 - ageHours * 0.06;
    const controversyScoreRaw = totalVotes > 0
        ? (Math.min(safeUp, safeDown) / totalVotes) * Math.log2(totalVotes + 1) * 100
        : 0;
    let trend = 'stable';
    if (score >= 4 || hotScoreRaw >= 3)
        trend = 'up';
    else if (score <= -3)
        trend = 'down';
    return {
        score,
        hotScore: Number(hotScoreRaw.toFixed(4)),
        controversyScore: Number(controversyScoreRaw.toFixed(4)),
        trend
    };
};
exports.computeSecretRank = computeSecretRank;
const isSecretActiveForRanking = (data) => {
    var _a;
    if ((data === null || data === void 0 ? void 0 : data.module) !== 'secrets')
        return false;
    if ((data === null || data === void 0 ? void 0 : data.deletedAt) != null)
        return false;
    const moderationStatus = sanitizeBoundedString((_a = data === null || data === void 0 ? void 0 : data.moderation) === null || _a === void 0 ? void 0 : _a.status, 40) || 'active';
    return moderationStatus === 'active';
};
exports.isSecretActiveForRanking = isSecretActiveForRanking;
const toSecretRankingItem = (secretDoc) => {
    var _a, _b, _c, _d;
    const data = secretDoc.data() || {};
    const createdAtMs = (0, exports.timestampToMillisOrZero)(data.createdAt) || Date.now();
    const upVotesCount = Math.max(0, Math.floor(Number(((_a = data === null || data === void 0 ? void 0 : data.stats) === null || _a === void 0 ? void 0 : _a.upVotesCount) || 0)));
    const downVotesCount = Math.max(0, Math.floor(Number(((_b = data === null || data === void 0 ? void 0 : data.stats) === null || _b === void 0 ? void 0 : _b.downVotesCount) || 0)));
    const commentsCount = Math.max(0, Math.floor(Number(((_c = data === null || data === void 0 ? void 0 : data.stats) === null || _c === void 0 ? void 0 : _c.commentsCount) || 0)));
    const reportsCount = Math.max(0, Math.floor(Number(((_d = data === null || data === void 0 ? void 0 : data.stats) === null || _d === void 0 ? void 0 : _d.reportsCount) || 0)));
    const totalVotesCount = upVotesCount + downVotesCount;
    const rank = (0, exports.computeSecretRank)(upVotesCount, downVotesCount, commentsCount, createdAtMs);
    return {
        secretId: secretDoc.id,
        textPreview: (0, exports.sanitizeSecretText)(data.descripcion, 220),
        category: sanitizeBoundedString(data.category, 40),
        zone: sanitizeBoundedString(data.zone, 60),
        createdAtMs,
        commentsCount,
        upVotesCount,
        downVotesCount,
        totalVotesCount,
        reportsCount,
        trend: rank.trend,
        score: rank.score,
        hotScore: rank.hotScore,
        controversyScore: rank.controversyScore
    };
};
exports.toSecretRankingItem = toSecretRankingItem;
const takeUniqueSecretRankingItems = (items, maxItems = exports.SECRET_RANKINGS_LIST_LIMIT) => {
    const unique = new Set();
    const result = [];
    for (const item of items) {
        if (unique.has(item.secretId))
            continue;
        unique.add(item.secretId);
        result.push(item);
        if (result.length >= maxItems)
            break;
    }
    return result;
};
exports.takeUniqueSecretRankingItems = takeUniqueSecretRankingItems;
const buildSecretRankingsSnapshot = (allItems) => {
    const nowMs = Date.now();
    const dayAgoMs = nowMs - (24 * 60 * 60 * 1000);
    const topDay = (0, exports.takeUniqueSecretRankingItems)(allItems
        .filter((item) => item.createdAtMs >= dayAgoMs)
        .sort((a, b) => b.hotScore - a.hotScore || b.score - a.score || b.createdAtMs - a.createdAtMs));
    const mostCommented = (0, exports.takeUniqueSecretRankingItems)([...allItems].sort((a, b) => b.commentsCount - a.commentsCount || b.hotScore - a.hotScore));
    const mostVoted = (0, exports.takeUniqueSecretRankingItems)([...allItems].sort((a, b) => b.totalVotesCount - a.totalVotesCount || b.hotScore - a.hotScore));
    const mostPolemic = (0, exports.takeUniqueSecretRankingItems)([...allItems]
        .filter((item) => item.totalVotesCount >= 3)
        .sort((a, b) => b.controversyScore - a.controversyScore ||
        b.totalVotesCount - a.totalVotesCount ||
        b.createdAtMs - a.createdAtMs));
    return {
        version: 2,
        generatedAtMs: nowMs,
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
        source: {
            sampleSize: allItems.length,
            listLimit: exports.SECRET_RANKINGS_LIST_LIMIT
        },
        windows: {
            dayStartMs: dayAgoMs
        },
        lists: {
            topDay,
            mostCommented,
            mostVoted,
            mostPolemic
        }
    };
};
exports.buildSecretRankingsSnapshot = buildSecretRankingsSnapshot;
const refreshSecretRankingsInternal = async () => {
    const snapshot = await db.collection('content')
        .where('module', '==', 'secrets')
        .where('deletedAt', '==', null)
        .where('moderation.status', '==', 'active')
        .orderBy('createdAt', 'desc')
        .limit(exports.SECRET_RANKINGS_SAMPLE_LIMIT)
        .get();
    const rankingItems = snapshot.docs
        .filter((docSnap) => (0, exports.isSecretActiveForRanking)(docSnap.data() || {}))
        .map(exports.toSecretRankingItem);
    const rankings = (0, exports.buildSecretRankingsSnapshot)(rankingItems);
    await db.collection('_config').doc('secret_rankings').set(rankings, { merge: true });
    return rankings;
};
exports.refreshSecretRankingsInternal = refreshSecretRankingsInternal;
//# sourceMappingURL=secretUtils.js.map