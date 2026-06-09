import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { type NotificationType } from './notificationUtils';

export type UserDefaultFeedTab = 'todo' | 'news' | 'post' | 'surveys' | 'lottery';

export type NotificationTypeSettings = {
  likes: boolean;
  comments: boolean;
  replies: boolean;
  follows: boolean;
};

export const USER_PROPAGATION_QUERY_PAGE_SIZE = 100;
export const USER_PROPAGATION_BATCH_WRITE_LIMIT = 450;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
export const USERNAME_REGEX = /^[a-z0-9_]+$/;

const USER_DEFAULT_FEED_TAB_VALUES = new Set<UserDefaultFeedTab>([
  'todo',
  'news',
  'post',
  'surveys',
  'lottery'
]);

export const NOTIFICATION_TYPE_DEFAULTS: NotificationTypeSettings = {
  likes: true,
  comments: true,
  replies: true,
  follows: true
};

export const sanitizeBoundedString = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
};

export const normalizeRoleAlias = (value: unknown): string => {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s_-]+/g, '')
    : '';
};

export const isAdminClaim = (token: Record<string, unknown>): boolean => {
  return token.admin === true ||
    token.superAdmin === true ||
    token.super_admin === true;
};

export const isSystemAdminClaim = (token: Record<string, unknown>): boolean => {
  return token.superAdmin === true ||
    token.super_admin === true;
};

export const isStaffRole = (role: unknown): boolean => {
  const normalized = normalizeRoleAlias(role);
  return normalized === 'colaborador' ||
    normalized === 'admin' ||
    normalized === 'administrador' ||
    normalized === 'superadmin';
};

export const isAdminRole = (role: unknown): boolean => {
  const normalized = normalizeRoleAlias(role);
  return normalized === 'admin' ||
    normalized === 'administrador' ||
    normalized === 'superadmin';
};

export const assertStaffUser = async (
  db: FirebaseFirestore.Firestore,
  authContext: functions.https.CallableContext['auth']
): Promise<void> => {
  const uid = authContext?.uid || '';
  if (!uid) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para ejecutar esta accion.'
    );
  }

  const token = (authContext?.token || {}) as Record<string, unknown>;
  const email = typeof token.email === 'string' ? token.email.toLowerCase() : '';
  if (
    uid === 'Z4f5ogXDQaNhEY4iBf9jgkPnQMP2' ||
    email === 'matias4315@gmail.com' ||
    isAdminClaim(token)
  ) {
    return;
  }

  const userSnap = await db.collection('users').doc(uid).get();
  const role = userSnap.data()?.rol;
  if (isStaffRole(role)) return;

  throw new functions.https.HttpsError(
    'permission-denied',
    'Solo staff puede ejecutar esta accion.'
  );
};

export const assertSystemAdminUser = (
  authContext: functions.https.CallableContext['auth']
): void => {
  const uid = authContext?.uid || '';
  if (!uid) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para ejecutar esta accion.'
    );
  }

  const token = (authContext?.token || {}) as Record<string, unknown>;
  const email = typeof token.email === 'string' ? token.email.toLowerCase() : '';
  if (
    uid === 'Z4f5ogXDQaNhEY4iBf9jgkPnQMP2' ||
    email === 'matias4315@gmail.com' ||
    isSystemAdminClaim(token)
  ) {
    return;
  }

  throw new functions.https.HttpsError(
    'permission-denied',
    'Solo el administrador del sistema puede ejecutar esta accion.'
  );
};

export const assertAdminUser = async (
  db: FirebaseFirestore.Firestore,
  authContext: functions.https.CallableContext['auth']
): Promise<void> => {
  const uid = authContext?.uid || '';
  if (!uid) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para ejecutar esta accion.'
    );
  }

  const token = (authContext?.token || {}) as Record<string, unknown>;
  const email = typeof token.email === 'string' ? token.email.toLowerCase() : '';
  if (
    uid === 'Z4f5ogXDQaNhEY4iBf9jgkPnQMP2' ||
    email === 'matias4315@gmail.com' ||
    isAdminClaim(token)
  ) {
    return;
  }

  const userSnap = await db.collection('users').doc(uid).get();
  const role = userSnap.data()?.rol;
  if (isAdminRole(role)) return;

  throw new functions.https.HttpsError(
    'permission-denied',
    'Solo administradores pueden ejecutar esta accion.'
  );
};

export const normalizeUserDefaultFeedTab = (value: unknown): UserDefaultFeedTab => {
  const normalized = sanitizeBoundedString(value, 40).toLowerCase();
  if (USER_DEFAULT_FEED_TAB_VALUES.has(normalized as UserDefaultFeedTab)) {
    return normalized as UserDefaultFeedTab;
  }
  return 'todo';
};

export const normalizeUsernameCandidate = (value: unknown): string => {
  const raw = sanitizeBoundedString(value, USERNAME_MAX_LENGTH);
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
};

export const buildFallbackUsername = (userId: string): string => {
  const compactUid = userId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  const base = `user_${compactUid || 'perfil'}`;
  const trimmed = base.slice(0, USERNAME_MAX_LENGTH);
  return trimmed.length >= USERNAME_MIN_LENGTH
    ? trimmed
    : `${trimmed}${'x'.repeat(USERNAME_MIN_LENGTH - trimmed.length)}`;
};

export const normalizeUsernameStrict = (value: unknown): { username: string; usernameLower: string } => {
  const username = normalizeUsernameCandidate(value);
  if (
    username.length < USERNAME_MIN_LENGTH ||
    username.length > USERNAME_MAX_LENGTH ||
    !USERNAME_REGEX.test(username)
  ) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      `username debe tener entre ${USERNAME_MIN_LENGTH} y ${USERNAME_MAX_LENGTH} caracteres, solo [a-z0-9_].`
    );
  }
  return { username, usernameLower: username };
};

export const normalizeUsernameLoose = (
  userId: string,
  userData: FirebaseFirestore.DocumentData
): { username: string; usernameLower: string } => {
  const fromLower = typeof userData?.usernameLower === 'string'
    ? normalizeUsernameCandidate(userData.usernameLower)
    : '';
  if (
    fromLower.length >= USERNAME_MIN_LENGTH &&
    fromLower.length <= USERNAME_MAX_LENGTH &&
    USERNAME_REGEX.test(fromLower)
  ) {
    return { username: fromLower, usernameLower: fromLower };
  }

  const fromUsername = normalizeUsernameCandidate(userData?.username);
  if (
    fromUsername.length >= USERNAME_MIN_LENGTH &&
    fromUsername.length <= USERNAME_MAX_LENGTH &&
    USERNAME_REGEX.test(fromUsername)
  ) {
    return { username: fromUsername, usernameLower: fromUsername };
  }

  const fallback = buildFallbackUsername(userId);
  return { username: fallback, usernameLower: fallback };
};

const toBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

export const ensureNotificationTypeSettings = (value: unknown): NotificationTypeSettings => {
  const raw = (value && typeof value === 'object'
    ? value
    : {}) as Record<string, unknown>;

  return {
    likes: toBoolean(raw.likes, NOTIFICATION_TYPE_DEFAULTS.likes),
    comments: toBoolean(raw.comments, NOTIFICATION_TYPE_DEFAULTS.comments),
    replies: toBoolean(raw.replies, NOTIFICATION_TYPE_DEFAULTS.replies),
    follows: toBoolean(raw.follows, NOTIFICATION_TYPE_DEFAULTS.follows)
  };
};

export const isNotificationTypeEnabled = (
  typeSettings: NotificationTypeSettings,
  notificationType: NotificationType
): boolean => {
  if (notificationType === 'like') return typeSettings.likes;
  if (notificationType === 'comment') return typeSettings.comments;
  if (notificationType === 'reply') return typeSettings.replies;
  return typeSettings.follows;
};

const readStatValue = (stats: Record<string, unknown>, key: string): number => {
  const raw = Number(stats[key] ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
};

export const ensureUserStats = (value: unknown): Record<string, number> => {
  const stats = (value && typeof value === 'object'
    ? value
    : {}) as Record<string, unknown>;

  return {
    postsCount: readStatValue(stats, 'postsCount'),
    followersCount: readStatValue(stats, 'followersCount'),
    followingCount: readStatValue(stats, 'followingCount'),
    likesTotalCount: readStatValue(stats, 'likesTotalCount')
  };
};

export const ensureUserSettings = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object') {
    return {
      notificationsEnabled: true,
      privateAccount: false,
      defaultFeedTab: 'todo',
      notificationTypes: { ...NOTIFICATION_TYPE_DEFAULTS }
    };
  }

  const settings = value as Record<string, unknown>;
  return {
    ...settings,
    notificationsEnabled: settings.notificationsEnabled !== false,
    privateAccount: settings.privateAccount === true,
    defaultFeedTab: normalizeUserDefaultFeedTab(settings.defaultFeedTab),
    notificationTypes: ensureNotificationTypeSettings(settings.notificationTypes)
  };
};

export const buildPublicUserProfile = (
  userId: string,
  userData: FirebaseFirestore.DocumentData
): FirebaseFirestore.DocumentData => {
  const { username, usernameLower } = normalizeUsernameLoose(userId, userData);
  const stats = ensureUserStats(userData?.stats);

  return {
    userId,
    username,
    usernameLower,
    nombre: sanitizeBoundedString(userData?.nombre, 120) || 'Usuario',
    bio: sanitizeBoundedString(userData?.bio, 280),
    location: sanitizeBoundedString(userData?.location, 120),
    website: sanitizeBoundedString(userData?.website, 240),
    profilePictureUrl: sanitizeBoundedString(userData?.profilePictureUrl, 1200),
    isVerified: userData?.isVerified === true,
    rol: typeof userData?.rol === 'string' ? userData.rol : 'usuario',
    stats,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
};

export const propagateUserFields = async (
  db: FirebaseFirestore.Firestore,
  target: 'content' | 'comments' | 'replies',
  userId: string,
  updateData: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>
) => {
  let baseQuery: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>;
  if (target === 'content') {
    baseQuery = db.collection('content').where('userId', '==', userId);
  } else {
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

export const normalizeOptionIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const deduped = new Set<string>();

  for (const item of value) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim();
    if (!cleaned) continue;
    deduped.add(cleaned);
  }

  return Array.from(deduped);
};

export type SurveyOption = {
  id: string;
  text: string;
  voteCount: number;
  active: boolean;
};

export const normalizeSurveyOptions = (value: unknown): SurveyOption[] => {
  if (!Array.isArray(value)) return [];
  const normalized: SurveyOption[] = [];

  for (const rawOption of value) {
    if (!rawOption || typeof rawOption !== 'object') continue;
    const optionData = rawOption as Record<string, unknown>;

    const id = typeof optionData.id === 'string' ? optionData.id.trim() : '';
    const text = typeof optionData.text === 'string' ? optionData.text.trim() : '';
    const voteCountRaw = Number(optionData.voteCount ?? 0);

    if (!id || !text) continue;

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
