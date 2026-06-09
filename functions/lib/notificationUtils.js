"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ANDROID_PUSH_CHANNEL_ID = exports.getNotificationTopicsForPlatform = exports.buildPushTextForNotification = exports.buildProfileTargetPath = exports.sanitizeNotificationDeviceId = exports.buildStableHash = exports.safeNotificationPath = void 0;
const NOTIFICATION_TOPIC_ALL = 'all_users';
const NOTIFICATION_TOPIC_ANDROID = 'android_users';
const NOTIFICATION_TOPIC_WEB = 'web_users';
const ANDROID_PUSH_CHANNEL_ID = 'general_notifications';
exports.ANDROID_PUSH_CHANNEL_ID = ANDROID_PUSH_CHANNEL_ID;
const safeNotificationPath = (value, fallback) => {
    if (typeof value !== 'string')
        return fallback;
    const trimmed = value.trim();
    if (!trimmed.startsWith('/'))
        return fallback;
    return trimmed.slice(0, 240) || fallback;
};
exports.safeNotificationPath = safeNotificationPath;
const buildStableHash = (value) => {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
};
exports.buildStableHash = buildStableHash;
const sanitizeNotificationDeviceId = (value, fallbackToken, platform) => {
    const fromInput = typeof value === 'string' ? value.trim() : '';
    const normalized = fromInput
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 120);
    if (normalized)
        return normalized;
    return `${platform}_${(0, exports.buildStableHash)(fallbackToken)}`.slice(0, 120);
};
exports.sanitizeNotificationDeviceId = sanitizeNotificationDeviceId;
const buildProfileTargetPath = (actorUsername, actorUserId) => {
    const profileRef = actorUsername || actorUserId;
    return `/perfil/${encodeURIComponent(profileRef)}`;
};
exports.buildProfileTargetPath = buildProfileTargetPath;
const buildPushTextForNotification = (type, actorName) => {
    const safeActor = actorName || 'Alguien';
    if (type === 'like') {
        return {
            title: 'Nuevo me gusta',
            body: `${safeActor} le dio me gusta a tu publicacion.`
        };
    }
    if (type === 'comment') {
        return {
            title: 'Nuevo comentario',
            body: `${safeActor} comento tu publicacion.`
        };
    }
    if (type === 'reply') {
        return {
            title: 'Nueva respuesta',
            body: `${safeActor} respondio tu comentario.`
        };
    }
    return {
        title: 'Nuevo seguidor',
        body: `${safeActor} empezo a seguirte.`
    };
};
exports.buildPushTextForNotification = buildPushTextForNotification;
const getNotificationTopicsForPlatform = (platform) => {
    if (platform === 'android') {
        return [NOTIFICATION_TOPIC_ALL, NOTIFICATION_TOPIC_ANDROID];
    }
    return [NOTIFICATION_TOPIC_ALL, NOTIFICATION_TOPIC_WEB];
};
exports.getNotificationTopicsForPlatform = getNotificationTopicsForPlatform;
//# sourceMappingURL=notificationUtils.js.map