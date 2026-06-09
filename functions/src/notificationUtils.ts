export type NotificationType = 'like' | 'comment' | 'reply' | 'follow';
export type NotificationPlatform = 'web' | 'android';

const NOTIFICATION_TOPIC_ALL = 'all_users';
const NOTIFICATION_TOPIC_ANDROID = 'android_users';
const NOTIFICATION_TOPIC_WEB = 'web_users';
const ANDROID_PUSH_CHANNEL_ID = 'general_notifications';

export const safeNotificationPath = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return fallback;
  return trimmed.slice(0, 240) || fallback;
};

export const buildStableHash = (value: string): string => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
};

export const sanitizeNotificationDeviceId = (
  value: unknown,
  fallbackToken: string,
  platform: NotificationPlatform
): string => {
  const fromInput = typeof value === 'string' ? value.trim() : '';
  const normalized = fromInput
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);
  if (normalized) return normalized;
  return `${platform}_${buildStableHash(fallbackToken)}`.slice(0, 120);
};

export const buildProfileTargetPath = (actorUsername: string, actorUserId: string): string => {
  const profileRef = actorUsername || actorUserId;
  return `/perfil/${encodeURIComponent(profileRef)}`;
};

export const buildPushTextForNotification = (
  type: NotificationType,
  actorName: string
): { title: string; body: string } => {
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

export const getNotificationTopicsForPlatform = (platform: NotificationPlatform): string[] => {
  if (platform === 'android') {
    return [NOTIFICATION_TOPIC_ALL, NOTIFICATION_TOPIC_ANDROID];
  }
  return [NOTIFICATION_TOPIC_ALL, NOTIFICATION_TOPIC_WEB];
};

export { ANDROID_PUSH_CHANNEL_ID };
