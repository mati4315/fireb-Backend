"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isStructuredPublicEvent = exports.isPublicNewsRecord = exports.sourceToPublicOrigin = exports.PUBLIC_NEWS_SOURCES = exports.PUBLIC_PUBLISHER = exports.PUBLIC_TIMEZONE = void 0;
exports.PUBLIC_TIMEZONE = 'America/Argentina/Buenos_Aires';
exports.PUBLIC_PUBLISHER = 'CDELU';
exports.PUBLIC_NEWS_SOURCES = new Set(['wordpress', 'admin']);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const sourceToPublicOrigin = (source) => {
    if (source === 'wordpress' || source === 'admin')
        return 'editorial';
    if (source === 'scraping')
        return 'aggregated';
    if (source === 'user')
        return 'user_submitted';
    return 'unknown';
};
exports.sourceToPublicOrigin = sourceToPublicOrigin;
const isPublicNewsRecord = (value) => {
    if (!isRecord(value))
        return false;
    if (value.module !== 'news' || value.type !== 'news')
        return false;
    if (value.isOficial !== true)
        return false;
    if (!exports.PUBLIC_NEWS_SOURCES.has(String(value.source || '')))
        return false;
    if (value.deletedAt !== null && value.deletedAt !== undefined)
        return false;
    if (hasOwn(value, 'visibility') && value.visibility !== 'public')
        return false;
    if (hasOwn(value, 'status') && value.status !== 'published')
        return false;
    const moderation = value.moderation;
    if (hasOwn(value, 'moderation') && !isRecord(moderation))
        return false;
    if (isRecord(moderation) && hasOwn(moderation, 'status')) {
        if (moderation.status !== 'approved' && moderation.status !== 'active')
            return false;
    }
    return true;
};
exports.isPublicNewsRecord = isPublicNewsRecord;
const isStructuredPublicEvent = (value) => {
    if (!isRecord(value))
        return false;
    if (value.type !== 'event' && value.module !== 'events')
        return false;
    if (value.deletedAt !== null && value.deletedAt !== undefined)
        return false;
    if (value.visibility !== undefined && value.visibility !== 'public')
        return false;
    return typeof value.startAt === 'string' || typeof value.startAt === 'object';
};
exports.isStructuredPublicEvent = isStructuredPublicEvent;
//# sourceMappingURL=policy.js.map