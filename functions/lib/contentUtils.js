"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildContentSlugBase = exports.extractNewsPublicIdFromPayload = exports.buildContentPublicIdKey = exports.buildContentSlugKey = exports.normalizeContentSlug = exports.inferContentModule = exports.CONTENT_SLUG_MAX_LENGTH = void 0;
exports.CONTENT_SLUG_MAX_LENGTH = 96;
const inferContentModule = (contentData) => {
    if ((contentData === null || contentData === void 0 ? void 0 : contentData.module) === 'news' || (contentData === null || contentData === void 0 ? void 0 : contentData.type) === 'news') {
        return 'news';
    }
    return 'community';
};
exports.inferContentModule = inferContentModule;
const normalizeContentSlug = (value) => {
    const raw = typeof value === 'string' ? value : '';
    const normalized = raw
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-');
    const trimmed = normalized.slice(0, exports.CONTENT_SLUG_MAX_LENGTH).replace(/-+$/g, '');
    return trimmed || 'contenido';
};
exports.normalizeContentSlug = normalizeContentSlug;
const buildContentSlugKey = (moduleName, slug) => `${moduleName}__${slug}`;
exports.buildContentSlugKey = buildContentSlugKey;
const normalizeNewsPublicIdScalar = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        const parsed = Math.floor(value);
        return parsed > 0 ? String(parsed) : '';
    }
    if (typeof value === 'string') {
        const raw = value.trim().replace(/^id:?/i, '');
        if (!/^\d+$/.test(raw))
            return '';
        const parsed = Number(raw);
        if (!Number.isFinite(parsed))
            return '';
        const normalized = Math.floor(parsed);
        return normalized > 0 ? String(normalized) : '';
    }
    return '';
};
const normalizeNewsPublicId = (value) => {
    const queue = [value];
    while (queue.length > 0) {
        const candidate = queue.shift();
        const normalized = normalizeNewsPublicIdScalar(candidate);
        if (normalized)
            return normalized;
        if (Array.isArray(candidate)) {
            queue.push(...candidate);
            continue;
        }
        if (candidate && typeof candidate === 'object') {
            const record = candidate;
            queue.push(record.publicId, record.postId, record.postID, record.id, record.value, record.rendered);
        }
    }
    return '';
};
const buildContentPublicIdKey = (moduleName, publicId) => `${moduleName}__${publicId}`;
exports.buildContentPublicIdKey = buildContentPublicIdKey;
const extractNewsPublicIdFromPayload = (payload) => {
    var _a, _b, _c, _d;
    const candidates = [
        payload === null || payload === void 0 ? void 0 : payload.publicId,
        payload === null || payload === void 0 ? void 0 : payload.postId,
        payload === null || payload === void 0 ? void 0 : payload.postID,
        payload === null || payload === void 0 ? void 0 : payload.id,
        payload === null || payload === void 0 ? void 0 : payload.wpPostId,
        payload === null || payload === void 0 ? void 0 : payload.wordpressId,
        (_a = payload === null || payload === void 0 ? void 0 : payload.custom_fields) === null || _a === void 0 ? void 0 : _a.postId,
        (_b = payload === null || payload === void 0 ? void 0 : payload.custom_fields) === null || _b === void 0 ? void 0 : _b.postID,
        (_c = payload === null || payload === void 0 ? void 0 : payload.custom_fields) === null || _c === void 0 ? void 0 : _c.id,
        (_d = payload === null || payload === void 0 ? void 0 : payload.custom_fields) === null || _d === void 0 ? void 0 : _d.wpPostId
    ];
    for (const candidate of candidates) {
        const normalized = normalizeNewsPublicId(candidate);
        if (normalized)
            return normalized;
    }
    return '';
};
exports.extractNewsPublicIdFromPayload = extractNewsPublicIdFromPayload;
const buildContentSlugBase = (contentData) => {
    const title = typeof (contentData === null || contentData === void 0 ? void 0 : contentData.titulo) === 'string' ? contentData.titulo.trim() : '';
    if (title)
        return (0, exports.normalizeContentSlug)(title);
    const moduleName = (0, exports.inferContentModule)(contentData);
    return moduleName === 'news' ? 'noticia' : 'publicacion';
};
exports.buildContentSlugBase = buildContentSlugBase;
//# sourceMappingURL=contentUtils.js.map