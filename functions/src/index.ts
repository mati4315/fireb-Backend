import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { Readable } from 'stream';
import * as crypto from 'crypto';
import * as ftp from 'basic-ftp';
import sharp = require('sharp');

admin.initializeApp();
const db = admin.firestore();

type SurveyStatus = 'active' | 'inactive' | 'completed';

type SurveyOption = {
  id: string;
  text: string;
  voteCount: number;
  active: boolean;
};

type LotteryStatus = 'draft' | 'active' | 'closed' | 'completed';
type LotteryMigrationStatus = 'pending' | 'running' | 'done' | 'failed';
type NotificationType = 'like' | 'comment' | 'reply' | 'follow';
type NotificationPlatform = 'web' | 'android';
type UserDefaultFeedTab = 'todo' | 'news' | 'post' | 'surveys' | 'lottery';
type NotificationTypeSettings = {
  likes: boolean;
  comments: boolean;
  replies: boolean;
  follows: boolean;
};
type NotificationActorIdentity = {
  userId: string;
  actorName: string;
  actorUsername: string;
  actorProfilePictureUrl: string;
};
type ContentNotificationTarget = {
  contentId: string;
  contentModule: 'news' | 'community';
  contentPublicRef: string;
  contentSlug: string;
  targetPath: string;
};
type NotificationWriteInput = {
  type: NotificationType;
  recipientUserId: string;
  actor: NotificationActorIdentity;
  targetPath: string;
  notificationId?: string;
  contentTarget?: ContentNotificationTarget;
  commentId?: string;
  replyId?: string;
};

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
const CONTENT_SLUG_MAX_LENGTH = 96;
const NOTIFICATION_PAGE_SIZE = 300;
const NOTIFICATION_RETENTION_DAYS = 30;
const NOTIFICATION_DEVICE_ID_MAX_LENGTH = 120;
const SECRET_TEXT_MIN_LENGTH = 12;
const SECRET_TEXT_MAX_LENGTH = 280;
const SECRET_TEXT_MAX_ABSOLUTE = 500;
const SECRET_NUMERIC_ID_START = 8301641;
const SECRET_COMMENT_MIN_LENGTH = 2;
const SECRET_COMMENT_MAX_LENGTH = 300;
const SECRET_ZONE_MAX_LENGTH = 48;
const SECRET_REPORT_REASON_MAX_LENGTH = 140;
const SECRET_DAILY_LIMIT = 5;
const SECRET_FINGERPRINT_TTL_MS = 72 * 60 * 60 * 1000;
const SECRET_AUTO_HIDE_REPORT_THRESHOLD = 6;
const SECRET_RANKINGS_SAMPLE_LIMIT = 450;
const SECRET_RANKINGS_LIST_LIMIT = 12;
const USER_DEFAULT_FEED_TAB_VALUES = new Set<UserDefaultFeedTab>([
  'todo',
  'news',
  'post',
  'surveys',
  'lottery'
]);
const NOTIFICATION_TYPE_DEFAULTS: NotificationTypeSettings = {
  likes: true,
  comments: true,
  replies: true,
  follows: true
};
const PERMANENT_FCM_TOKEN_ERROR_CODES = new Set<string>([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered'
]);
const SECRET_CATEGORY_VALUES = new Set<string>([
  'rumores',
  'relaciones',
  'trabajo_negocios',
  'denuncia_light',
  'random_divertido'
]);
const SECRET_SEX_VALUES = new Set<string>([
  'no_responder',
  'hombre',
  'mujer'
]);

const buildCommentRef = (contentId: string, commentId: string) =>
  db.collection('content').doc(contentId).collection('comments').doc(commentId);

const inferContentModule = (
  contentData: FirebaseFirestore.DocumentData
): 'news' | 'community' => {
  if (contentData?.module === 'news' || contentData?.type === 'news') {
    return 'news';
  }
  return 'community';
};

const normalizeContentSlug = (value: unknown): string => {
  const raw = typeof value === 'string' ? value : '';
  const normalized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');

  const trimmed = normalized.slice(0, CONTENT_SLUG_MAX_LENGTH).replace(/-+$/g, '');
  return trimmed || 'contenido';
};

const buildContentSlugKey = (moduleName: 'news' | 'community', slug: string): string =>
  `${moduleName}__${slug}`;

const normalizeNewsPublicIdScalar = (value: unknown): string => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = Math.floor(value);
    return parsed > 0 ? String(parsed) : '';
  }

  if (typeof value === 'string') {
    const raw = value.trim().replace(/^id:?/i, '');
    if (!/^\d+$/.test(raw)) return '';
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return '';
    const normalized = Math.floor(parsed);
    return normalized > 0 ? String(normalized) : '';
  }

  return '';
};

const normalizeNewsPublicId = (value: unknown): string => {
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const candidate = queue.shift();
    const normalized = normalizeNewsPublicIdScalar(candidate);
    if (normalized) return normalized;

    if (Array.isArray(candidate)) {
      queue.push(...candidate);
      continue;
    }

    if (candidate && typeof candidate === 'object') {
      const record = candidate as Record<string, unknown>;
      queue.push(
        record.publicId,
        record.postId,
        record.postID,
        record.id,
        record.value,
        record.rendered
      );
    }
  }

  return '';
};

const buildContentPublicIdKey = (moduleName: 'news' | 'community', publicId: string): string =>
  `${moduleName}__${publicId}`;

const extractNewsPublicIdFromPayload = (payload: any): string => {
  const candidates: unknown[] = [
    payload?.publicId,
    payload?.postId,
    payload?.postID,
    payload?.id,
    payload?.wpPostId,
    payload?.wordpressId,
    payload?.custom_fields?.postId,
    payload?.custom_fields?.postID,
    payload?.custom_fields?.id,
    payload?.custom_fields?.wpPostId
  ];

  for (const candidate of candidates) {
    const normalized = normalizeNewsPublicId(candidate);
    if (normalized) return normalized;
  }

  return '';
};

const buildContentSlugBase = (contentData: FirebaseFirestore.DocumentData): string => {
  const title = typeof contentData?.titulo === 'string' ? contentData.titulo.trim() : '';
  if (title) return normalizeContentSlug(title);
  const moduleName = inferContentModule(contentData);
  return moduleName === 'news' ? 'noticia' : 'publicacion';
};

const isLikeModuleEnabledForContent = (
  modulesConfig: FirebaseFirestore.DocumentData | undefined,
  moduleName: 'news' | 'community'
): boolean => {
  const likesConfig = modulesConfig?.likes ?? {};
  const likesEnabled = likesConfig.enabled ?? true;
  const likesNewsEnabled = likesConfig.newsEnabled ?? true;
  const likesCommunityEnabled = likesConfig.communityEnabled ?? true;

  if (!likesEnabled) return false;
  return moduleName === 'news' ? likesNewsEnabled : likesCommunityEnabled;
};

const isNotificationsModuleEnabled = (
  modulesConfig: FirebaseFirestore.DocumentData | undefined
): boolean => {
  const notificationsConfig = modulesConfig?.notifications ?? {};
  return notificationsConfig.enabled ?? true;
};

const isLotteryModuleEnabled = (
  modulesConfig: FirebaseFirestore.DocumentData | undefined
): boolean => {
  const lotteryConfig = modulesConfig?.lottery ?? {};
  return lotteryConfig.enabled ?? true;
};

const isSecretsModuleEnabled = (
  modulesConfig: FirebaseFirestore.DocumentData | undefined
): boolean => {
  const secretsConfig = modulesConfig?.secrets ?? {};
  return secretsConfig.enabled ?? true;
};

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const hasMeaningfulSecretText = (value: string): boolean =>
  /[0-9A-Za-z\u00C0-\u024F]/.test(value);

const sanitizeSecretText = (value: unknown, maxLength: number): string => {
  const asString = typeof value === 'string' ? value : '';
  return collapseWhitespace(asString).slice(0, maxLength);
};

const normalizeSecretCategory = (value: unknown): string | null => {
  const normalized = sanitizeBoundedString(value, 40).toLowerCase();
  if (!normalized) return null;
  return SECRET_CATEGORY_VALUES.has(normalized) ? normalized : null;
};

const normalizeSecretSex = (value: unknown): 'no_responder' | 'hombre' | 'mujer' => {
  const normalized = sanitizeBoundedString(value, 20).toLowerCase();
  if (SECRET_SEX_VALUES.has(normalized)) {
    return normalized as 'no_responder' | 'hombre' | 'mujer';
  }
  return 'no_responder';
};

const normalizeSecretZone = (value: unknown): string | null => {
  const sanitized = sanitizeSecretText(value, SECRET_ZONE_MAX_LENGTH);
  return sanitized || null;
};

const normalizeSecretAge = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  if (normalized < 13 || normalized > 99) return null;
  return normalized;
};

const normalizeSecretReportReason = (value: unknown): string => {
  const reason = sanitizeSecretText(value, SECRET_REPORT_REASON_MAX_LENGTH);
  return reason || 'contenido_inapropiado';
};

const normalizeSecretClientAnonId = (value: unknown): string => {
  const raw = sanitizeBoundedString(value, 120);
  return raw.replace(/[^a-zA-Z0-9_-]/g, '');
};

const timestampToMillisOrZero = (value: unknown): number => {
  if (value instanceof admin.firestore.Timestamp) return value.toMillis();
  return 0;
};

const buildSecretFingerprintHash = (
  data: any,
  context: functions.https.CallableContext
): string => {
  const rawRequest = (context as functions.https.CallableContext & { rawRequest?: any }).rawRequest;
  const forwardedForHeader = rawRequest?.headers?.['x-forwarded-for'];
  const forwardedForValue = Array.isArray(forwardedForHeader)
    ? String(forwardedForHeader[0] || '')
    : String(forwardedForHeader || '');
  const forwardedIp = forwardedForValue.split(',')[0]?.trim() || '';
  const requestIp = forwardedIp || String(rawRequest?.ip || '');
  const userAgent = String(rawRequest?.headers?.['user-agent'] || '');
  const clientAnonId = normalizeSecretClientAnonId(data?.clientAnonId);
  const projectTag = String(process.env.GCLOUD_PROJECT || 'cdelu');
  const pepper = String(
    process.env.SECRETS_FINGERPRINT_PEPPER || 'change_me_secretos_pepper_v1'
  );

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

const createSecretAlias = (fingerprintHash: string, scope: string): string => {
  const aliasSeed = crypto
    .createHash('sha1')
    .update(`${fingerprintHash}|${scope}`)
    .digest('hex')
    .slice(0, 8);
  const numeric = Number.parseInt(aliasSeed, 16) % 10000;
  return `Anon${String(numeric).padStart(4, '0')}`;
};

type SecretTrend = 'up' | 'down' | 'stable';

type SecretRankResult = {
  score: number;
  hotScore: number;
  controversyScore: number;
  trend: SecretTrend;
};

type SecretRuntimeSettings = {
  minTextLength: number;
  maxTextLength: number;
  createCooldownMs: number;
  commentCooldownMs: number;
  dailyLimit: number;
  autoHideReportsThreshold: number;
};

const resolveSecretRuntimeSettings = (
  data: FirebaseFirestore.DocumentData | undefined
): SecretRuntimeSettings => {
  const maxTextLength = clampInteger(data?.maxTextLength, 120, 500, SECRET_TEXT_MAX_LENGTH);
  const minTextLengthRaw = clampInteger(data?.minTextLength, 1, 80, SECRET_TEXT_MIN_LENGTH);
  const minTextLength = Math.min(minTextLengthRaw, maxTextLength);

  const createCooldownMinutes = clampInteger(data?.createCooldownMinutes, 1, 240, 30);
  const commentCooldownSeconds = clampInteger(data?.commentCooldownSeconds, 1, 300, 20);
  const dailyLimit = clampInteger(data?.dailyLimit, 1, 30, SECRET_DAILY_LIMIT);
  const autoHideReportsThreshold = clampInteger(
    data?.autoHideReportsThreshold,
    1,
    100,
    SECRET_AUTO_HIDE_REPORT_THRESHOLD
  );

  return {
    minTextLength,
    maxTextLength,
    createCooldownMs: createCooldownMinutes * 60 * 1000,
    commentCooldownMs: commentCooldownSeconds * 1000,
    dailyLimit,
    autoHideReportsThreshold
  };
};

type SecretRankingItem = {
  secretId: string;
  textPreview: string;
  category: string;
  zone: string;
  createdAtMs: number;
  commentsCount: number;
  upVotesCount: number;
  downVotesCount: number;
  totalVotesCount: number;
  reportsCount: number;
  trend: SecretTrend;
  score: number;
  hotScore: number;
  controversyScore: number;
};

const computeSecretRank = (
  upVotesCount: number,
  downVotesCount: number,
  commentsCount: number,
  createdAtMs: number
): SecretRankResult => {
  const safeUp = Math.max(0, Math.floor(Number(upVotesCount) || 0));
  const safeDown = Math.max(0, Math.floor(Number(downVotesCount) || 0));
  const safeComments = Math.max(0, Math.floor(Number(commentsCount) || 0));
  const totalVotes = safeUp + safeDown;
  const score = safeUp - safeDown;
  const ageHours = Math.max(0, (Date.now() - createdAtMs) / (60 * 60 * 1000));
  const engagementBoost = Math.log10(Math.max(1, totalVotes + safeComments + 1));
  const hotScoreRaw = score * 1.25 + safeComments * 0.8 + engagementBoost * 2.2 - ageHours * 0.06;
  const controversyScoreRaw =
    totalVotes > 0
      ? (Math.min(safeUp, safeDown) / totalVotes) * Math.log2(totalVotes + 1) * 100
      : 0;

  let trend: SecretTrend = 'stable';
  if (score >= 4 || hotScoreRaw >= 3) trend = 'up';
  else if (score <= -3) trend = 'down';

  return {
    score,
    hotScore: Number(hotScoreRaw.toFixed(4)),
    controversyScore: Number(controversyScoreRaw.toFixed(4)),
    trend
  };
};

const isSecretActiveForRanking = (data: FirebaseFirestore.DocumentData): boolean => {
  if (data?.module !== 'secrets') return false;
  if (data?.deletedAt != null) return false;
  const moderationStatus = sanitizeBoundedString(data?.moderation?.status, 40) || 'active';
  return moderationStatus === 'active';
};

const toSecretRankingItem = (
  secretDoc: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>
): SecretRankingItem => {
  const data = secretDoc.data() || {};
  const createdAtMs = timestampToMillisOrZero(data.createdAt) || Date.now();
  const upVotesCount = Math.max(0, Math.floor(Number(data?.stats?.upVotesCount || 0)));
  const downVotesCount = Math.max(0, Math.floor(Number(data?.stats?.downVotesCount || 0)));
  const commentsCount = Math.max(0, Math.floor(Number(data?.stats?.commentsCount || 0)));
  const reportsCount = Math.max(0, Math.floor(Number(data?.stats?.reportsCount || 0)));
  const totalVotesCount = upVotesCount + downVotesCount;
  const rank = computeSecretRank(upVotesCount, downVotesCount, commentsCount, createdAtMs);

  return {
    secretId: secretDoc.id,
    textPreview: sanitizeSecretText(data.descripcion, 220),
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

const takeUniqueSecretRankingItems = (
  items: SecretRankingItem[],
  maxItems = SECRET_RANKINGS_LIST_LIMIT
): SecretRankingItem[] => {
  const unique = new Set<string>();
  const result: SecretRankingItem[] = [];
  for (const item of items) {
    if (unique.has(item.secretId)) continue;
    unique.add(item.secretId);
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
};

const buildSecretRankingsSnapshot = (
  allItems: SecretRankingItem[]
): Record<string, unknown> => {
  const nowMs = Date.now();
  const dayAgoMs = nowMs - (24 * 60 * 60 * 1000);

  const topDay = takeUniqueSecretRankingItems(
    allItems
      .filter((item) => item.createdAtMs >= dayAgoMs)
      .sort((a, b) => b.hotScore - a.hotScore || b.score - a.score || b.createdAtMs - a.createdAtMs)
  );

  const mostCommented = takeUniqueSecretRankingItems(
    [...allItems].sort((a, b) => b.commentsCount - a.commentsCount || b.hotScore - a.hotScore)
  );

  const mostVoted = takeUniqueSecretRankingItems(
    [...allItems].sort((a, b) => b.totalVotesCount - a.totalVotesCount || b.hotScore - a.hotScore)
  );

  const mostPolemic = takeUniqueSecretRankingItems(
    [...allItems]
      .filter((item) => item.totalVotesCount >= 3)
      .sort(
        (a, b) =>
          b.controversyScore - a.controversyScore ||
          b.totalVotesCount - a.totalVotesCount ||
          b.createdAtMs - a.createdAtMs
      )
  );

  return {
    version: 2,
    generatedAtMs: nowMs,
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: {
      sampleSize: allItems.length,
      listLimit: SECRET_RANKINGS_LIST_LIMIT
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

const refreshSecretRankingsInternal = async (): Promise<Record<string, unknown>> => {
  const snapshot = await db.collection('content')
    .where('module', '==', 'secrets')
    .where('deletedAt', '==', null)
    .where('moderation.status', '==', 'active')
    .orderBy('createdAt', 'desc')
    .limit(SECRET_RANKINGS_SAMPLE_LIMIT)
    .get();

  const rankingItems = snapshot.docs
    .filter((docSnap) => isSecretActiveForRanking(docSnap.data() || {}))
    .map(toSecretRankingItem);

  const rankings = buildSecretRankingsSnapshot(rankingItems);
  await db.collection('_config').doc('secret_rankings').set(rankings, { merge: true });
  return rankings;
};

const clampInteger = (value: unknown, min: number, max: number, fallback: number): number => {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const parsed = Math.floor(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

const normalizeLotteryMaxNumber = (value: unknown): number => {
  return clampInteger(
    value,
    LOTTERY_MIN_MAX_NUMBER,
    LOTTERY_MAX_MAX_NUMBER,
    LOTTERY_DEFAULT_MAX_NUMBER
  );
};

const normalizeLotteryMaxTicketsPerUser = (value: unknown): number => {
  return clampInteger(
    value,
    LOTTERY_MIN_TICKETS_PER_USER,
    LOTTERY_MAX_TICKETS_PER_USER,
    LOTTERY_DEFAULT_MAX_TICKETS_PER_USER
  );
};

const parseSelectedLotteryNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  if (!Number.isFinite(normalized) || normalized !== parsed) return null;
  if (normalized <= 0) return null;
  return normalized;
};

const toLotteryEntryDocId = (selectedNumber: number): string => {
  return `${LOTTERY_ENTRY_DOC_PREFIX}${selectedNumber}`;
};

const extractSelectedNumberFromEntryDoc = (
  entryDoc: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>
): number | null => {
  const data = entryDoc.data() || {};
  const selectedRaw = parseSelectedLotteryNumber(data.selectedNumber);
  if (selectedRaw != null) return selectedRaw;

  const matches = entryDoc.id.match(/^n_(\d+)$/);
  if (!matches) return null;
  return parseSelectedLotteryNumber(matches[1]);
};

const normalizeRoleAlias = (value: unknown): string => {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s_-]+/g, '')
    : '';
};

const isAdminClaim = (token: Record<string, unknown>): boolean => {
  return token.admin === true ||
    token.superAdmin === true ||
    token.super_admin === true;
};

const isSystemAdminClaim = (token: Record<string, unknown>): boolean => {
  return token.superAdmin === true ||
    token.super_admin === true;
};

const isStaffRole = (role: unknown): boolean => {
  const normalized = normalizeRoleAlias(role);
  return normalized === 'colaborador' ||
    normalized === 'admin' ||
    normalized === 'administrador' ||
    normalized === 'superadmin';
};

const isAdminRole = (role: unknown): boolean => {
  const normalized = normalizeRoleAlias(role);
  return normalized === 'admin' ||
    normalized === 'administrador' ||
    normalized === 'superadmin';
};

const assertStaffUser = async (
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

const assertSystemAdminUser = (
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

const assertAdminUser = async (
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

const sanitizeBoundedString = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
};

const normalizeUserDefaultFeedTab = (value: unknown): UserDefaultFeedTab => {
  const normalized = sanitizeBoundedString(value, 40).toLowerCase();
  if (USER_DEFAULT_FEED_TAB_VALUES.has(normalized as UserDefaultFeedTab)) {
    return normalized as UserDefaultFeedTab;
  }
  return 'todo';
};

const normalizeUsernameCandidate = (value: unknown): string => {
  const raw = sanitizeBoundedString(value, USERNAME_MAX_LENGTH);
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
};

const buildFallbackUsername = (userId: string): string => {
  const compactUid = userId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  const base = `user_${compactUid || 'perfil'}`;
  const trimmed = base.slice(0, USERNAME_MAX_LENGTH);
  return trimmed.length >= USERNAME_MIN_LENGTH
    ? trimmed
    : `${trimmed}${'x'.repeat(USERNAME_MIN_LENGTH - trimmed.length)}`;
};

const normalizeUsernameStrict = (value: unknown): { username: string; usernameLower: string } => {
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

const normalizeUsernameLoose = (
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

const ensureNotificationTypeSettings = (value: unknown): NotificationTypeSettings => {
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

const isNotificationTypeEnabled = (
  typeSettings: NotificationTypeSettings,
  notificationType: NotificationType
): boolean => {
  if (notificationType === 'like') return typeSettings.likes;
  if (notificationType === 'comment') return typeSettings.comments;
  if (notificationType === 'reply') return typeSettings.replies;
  return typeSettings.follows;
};

const buildStableHash = (value: string): string => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
};

const sanitizeNotificationDeviceId = (
  value: unknown,
  fallbackToken: string,
  platform: NotificationPlatform
): string => {
  const fromInput = typeof value === 'string' ? value.trim() : '';
  const normalized = fromInput
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, NOTIFICATION_DEVICE_ID_MAX_LENGTH);
  if (normalized) return normalized;
  return `${platform}_${buildStableHash(fallbackToken)}`.slice(0, NOTIFICATION_DEVICE_ID_MAX_LENGTH);
};

const safeNotificationPath = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return fallback;
  return trimmed.slice(0, 240) || fallback;
};

const buildProfileTargetPath = (actorUsername: string, actorUserId: string): string => {
  const profileRef = actorUsername || actorUserId;
  return `/perfil/${encodeURIComponent(profileRef)}`;
};

const buildContentTargetFromDoc = (
  contentId: string,
  contentData: FirebaseFirestore.DocumentData
): ContentNotificationTarget => {
  const contentModule = inferContentModule(contentData);
  const contentSlug = normalizeContentSlug(contentData?.slug || contentData?.titulo || contentId);
  const contentPublicRef = contentModule === 'news'
    ? (extractNewsPublicIdFromPayload(contentData) || contentId)
    : contentId;

  const targetPath = contentModule === 'news'
    ? `/noticia/${encodeURIComponent(contentPublicRef)}/${encodeURIComponent(contentSlug)}`
    : `/c/${encodeURIComponent(contentId)}/${encodeURIComponent(contentSlug)}`;

  return {
    contentId,
    contentModule,
    contentPublicRef,
    contentSlug,
    targetPath
  };
};

const buildPushTextForNotification = (
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

const loadNotificationActorIdentity = async (actorUserId: string): Promise<NotificationActorIdentity> => {
  const [userPublicSnap, userPrivateSnap] = await Promise.all([
    db.collection('users_public').doc(actorUserId).get(),
    db.collection('users').doc(actorUserId).get()
  ]);

  const sourceData = userPublicSnap.exists
    ? (userPublicSnap.data() || {})
    : (userPrivateSnap.data() || {});
  const { usernameLower } = normalizeUsernameLoose(actorUserId, sourceData);
  const actorName = sanitizeBoundedString(sourceData?.nombre, 120) || 'Usuario';
  const actorProfilePictureUrl = sanitizeBoundedString(sourceData?.profilePictureUrl, 1200);

  return {
    userId: actorUserId,
    actorName,
    actorUsername: usernameLower,
    actorProfilePictureUrl
  };
};

const sendPushToNotificationDevices = async (
  notificationRef: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>,
  recipientUserId: string,
  notificationType: NotificationType,
  actorName: string,
  targetPath: string
): Promise<void> => {
  const devicesSnap = await db.collection('users')
    .doc(recipientUserId)
    .collection('notification_devices')
    .where('enabled', '==', true)
    .get();
  if (devicesSnap.empty) return;

  const tokenToDeviceRefs = new Map<string, FirebaseFirestore.DocumentReference[]>();
  const uniqueTokens: string[] = [];

  for (const deviceDoc of devicesSnap.docs) {
    const token = sanitizeBoundedString(deviceDoc.data()?.token, 4096);
    if (!token) continue;

    const existing = tokenToDeviceRefs.get(token) || [];
    existing.push(deviceDoc.ref);
    tokenToDeviceRefs.set(token, existing);

    if (existing.length === 1) uniqueTokens.push(token);
  }

  if (uniqueTokens.length === 0) return;

  const pushText = buildPushTextForNotification(notificationType, actorName);
  const sendResult = await admin.messaging().sendEachForMulticast({
    tokens: uniqueTokens,
    notification: {
      title: pushText.title,
      body: pushText.body
    },
    data: {
      notificationId: notificationRef.id,
      type: notificationType,
      targetPath
    },
    android: {
      priority: 'high',
      notification: {
        clickAction: 'FLUTTER_NOTIFICATION_CLICK'
      }
    },
    webpush: {
      fcmOptions: {
        link: targetPath
      }
    }
  });

  const refsToDelete: FirebaseFirestore.DocumentReference[] = [];
  sendResult.responses.forEach((response, index) => {
    if (response.success) return;
    const code = String(response.error?.code || '');
    if (!PERMANENT_FCM_TOKEN_ERROR_CODES.has(code)) return;
    const token = uniqueTokens[index];
    const linkedRefs = tokenToDeviceRefs.get(token) || [];
    refsToDelete.push(...linkedRefs);
  });

  if (refsToDelete.length === 0) return;

  const batch = db.batch();
  for (const ref of refsToDelete) {
    batch.delete(ref);
  }
  await batch.commit();
};

const writeNotificationEvent = async (input: NotificationWriteInput): Promise<void> => {
  if (input.recipientUserId === input.actor.userId) return;

  const [modulesConfigSnap, recipientSnap] = await Promise.all([
    db.collection('_config').doc('modules').get(),
    db.collection('users').doc(input.recipientUserId).get()
  ]);

  if (!isNotificationsModuleEnabled(modulesConfigSnap.data())) return;
  if (!recipientSnap.exists) return;

  const recipientData = recipientSnap.data() || {};
  const recipientSettings = ensureUserSettings(recipientData.settings);
  const notificationsEnabled = recipientSettings.notificationsEnabled !== false;
  if (!notificationsEnabled) return;

  const typeSettings = ensureNotificationTypeSettings(recipientSettings.notificationTypes);
  if (!isNotificationTypeEnabled(typeSettings, input.type)) return;

  const notificationsCollection = db.collection('users')
    .doc(input.recipientUserId)
    .collection('notifications');
  const notificationRef = input.notificationId
    ? notificationsCollection.doc(input.notificationId)
    : notificationsCollection.doc();

  if (input.notificationId) {
    await db.runTransaction(async (tx) => {
      const existingSnap = await tx.get(notificationRef);
      const existingData = existingSnap.data() || {};
      const currentCountRaw = Number(existingData.eventCount ?? 1);
      const currentCount = Number.isFinite(currentCountRaw) ? Math.max(1, Math.floor(currentCountRaw)) : 1;

      tx.set(
        notificationRef,
        {
          type: input.type,
          recipientUserId: input.recipientUserId,
          actorUserId: input.actor.userId,
          actorName: input.actor.actorName,
          actorUsername: input.actor.actorUsername,
          actorProfilePictureUrl: input.actor.actorProfilePictureUrl,
          contentId: input.contentTarget?.contentId || '',
          contentModule: input.contentTarget?.contentModule || '',
          contentPublicRef: input.contentTarget?.contentPublicRef || '',
          contentSlug: input.contentTarget?.contentSlug || '',
          commentId: input.commentId || '',
          replyId: input.replyId || '',
          targetPath: safeNotificationPath(input.targetPath, '/notificaciones'),
          isRead: false,
          readAt: null,
          eventCount: existingSnap.exists ? currentCount + 1 : 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastEventAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: existingSnap.exists
            ? (existingData.createdAt || admin.firestore.FieldValue.serverTimestamp())
            : admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });
  } else {
    await notificationRef.set({
      type: input.type,
      recipientUserId: input.recipientUserId,
      actorUserId: input.actor.userId,
      actorName: input.actor.actorName,
      actorUsername: input.actor.actorUsername,
      actorProfilePictureUrl: input.actor.actorProfilePictureUrl,
      contentId: input.contentTarget?.contentId || '',
      contentModule: input.contentTarget?.contentModule || '',
      contentPublicRef: input.contentTarget?.contentPublicRef || '',
      contentSlug: input.contentTarget?.contentSlug || '',
      commentId: input.commentId || '',
      replyId: input.replyId || '',
      targetPath: safeNotificationPath(input.targetPath, '/notificaciones'),
      isRead: false,
      readAt: null,
      eventCount: 1,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastEventAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  await sendPushToNotificationDevices(
    notificationRef,
    input.recipientUserId,
    input.type,
    input.actor.actorName,
    safeNotificationPath(input.targetPath, '/notificaciones')
  );
};

const sanitizeOptionalUrl = (value: unknown, fieldName: string): string => {
  const raw = sanitizeBoundedString(value, 240);
  if (!raw) return '';

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported-protocol');
    }
    return parsed.toString().slice(0, 240);
  } catch {
    throw new functions.https.HttpsError(
      'invalid-argument',
      `${fieldName} debe ser una URL valida (http/https).`
    );
  }
};

const readStatValue = (stats: Record<string, unknown>, key: string): number => {
  const raw = Number(stats[key] ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
};

const ensureUserStats = (value: unknown): Record<string, number> => {
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

const ensureUserSettings = (value: unknown): Record<string, unknown> => {
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

const buildPublicUserProfile = (
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

const propagateUserFields = async (
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

const normalizeOptionIds = (value: unknown): string[] => {
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

const normalizeSurveyOptions = (value: unknown): SurveyOption[] => {
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

const isExpired = (value: unknown): boolean => {
  if (!value) return false;
  if (value instanceof admin.firestore.Timestamp) {
    return value.toMillis() <= Date.now();
  }

  if (value instanceof Date) {
    return value.getTime() <= Date.now();
  }

  return false;
};

const ensureImageMime = (value: unknown): string => {
  const mime = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!mime.startsWith('image/')) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Formato de archivo invalido.'
    );
  }
  return mime;
};

const decodeBase64Payload = (value: unknown): Buffer => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'No se recibio imagen.'
    );
  }

  const sanitized = value.replace(/^data:[^;]+;base64,/, '').trim();
  const buffer = Buffer.from(sanitized, 'base64');
  if (buffer.length === 0) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'No se pudo decodificar la imagen.'
    );
  }
  if (buffer.length > MAX_HOSTING_UPLOAD_BYTES) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'La imagen supera el limite permitido.'
    );
  }
  return buffer;
};

const sanitizePathSegment = (value: string): string => {
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
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Falta configurar credenciales FTP del hosting.'
    );
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
export const onLikeAdded = functions.firestore
  .document('content/{contentId}/likes/{userId}')
  .onCreate(async (snap, context) => {
    const { contentId, userId: actorUserId } = context.params;
    const likeData = snap.data() || {};
    try {
      const contentRef = db.collection('content').doc(contentId);
      const contentSnap = await contentRef.get();
      if (!contentSnap.exists) return;

      const contentData = contentSnap.data() || {};
      if (contentData.deletedAt != null) return;

      if (likeData.writer !== LIKE_WRITER_CALLABLE) {
        await contentRef.update({
          'stats.likesCount': admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      const recipientUserId = sanitizeBoundedString(contentData.userId, 128);
      if (!recipientUserId) return;

      const actor = await loadNotificationActorIdentity(actorUserId);
      const contentTarget = buildContentTargetFromDoc(contentId, contentData);
      await writeNotificationEvent({
        type: 'like',
        recipientUserId,
        actor,
        notificationId: `like_${actorUserId}_${contentId}`,
        contentTarget,
        targetPath: contentTarget.targetPath
      });
      console.log(`âœ… Like +1 for ${contentId}`);
    } catch (error) {
      console.error(`âŒ Like increment failed: ${contentId}`, error);
    }
  });

export const onLikeRemoved = functions.firestore
  .document('content/{contentId}/likes/{userId}')
  .onDelete(async (snap, context) => {
    const { contentId } = context.params;
    const likeData = snap.data() || {};
    if (likeData.writer === LIKE_WRITER_CALLABLE) return;
    try {
      await db.collection('content').doc(contentId).update({
        'stats.likesCount': admin.firestore.FieldValue.increment(-1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error(`âŒ Like decrement failed`, error);
    }
  });

export const toggleContentLike = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para dar me gusta.'
    );
  }

  const contentId = typeof data?.contentId === 'string' ? data.contentId.trim() : '';
  if (!contentId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'contentId es obligatorio.'
    );
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
      throw new functions.https.HttpsError(
        'failed-precondition',
        'No puedes dar me gusta a contenido eliminado.'
      );
    }

    const moduleName = inferContentModule(contentData);
    const isEnabled = isLikeModuleEnabledForContent(modulesConfigSnap.data(), moduleName);
    if (!isEnabled) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Los me gusta estan deshabilitados para este modulo.'
      );
    }

    if (likeSnap.exists) {
      const existingLike = likeSnap.data() || {};
      tx.delete(likeRef);

      // Legacy likes (sin writer callable) mantienen compatibilidad via trigger.
      if (existingLike.writer === LIKE_WRITER_CALLABLE) {
        tx.set(
          contentRef,
          {
            stats: {
              likesCount: admin.firestore.FieldValue.increment(-1)
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
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

    tx.set(
      contentRef,
      {
        stats: {
          likesCount: admin.firestore.FieldValue.increment(1)
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      status: 'ok',
      liked: true,
      contentId
    };
  });
});

// 2. Secrets
export const createSecretCallable = functions.https.onCall(async (data, context) => {
  const textRaw = sanitizeSecretText(data?.text, SECRET_TEXT_MAX_ABSOLUTE);

  const sex = normalizeSecretSex(data?.sex);
  const age = normalizeSecretAge(data?.age);
  const category = normalizeSecretCategory(data?.category);
  const zone = normalizeSecretZone(data?.zone);
  const fingerprintHash = buildSecretFingerprintHash(data, context);
  const nowMs = Date.now();
  const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);
  const oneDayMs = 24 * 60 * 60 * 1000;

  const modulesConfigRef = db.collection('_config').doc('modules');
  const secretSettingsRef = db.collection('_config').doc('secret_settings');
  const secretCounterRef = db.collection('_counters').doc('secret_ids');
  const rateLimitRef = db.collection('secret_rate_limits').doc(fingerprintHash);
  const fingerprintRef = db.collection('secret_fingerprints').doc(fingerprintHash);

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, secretSettingsSnap, secretCounterSnap, rateLimitSnap, fingerprintSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(secretSettingsRef),
      tx.get(secretCounterRef),
      tx.get(rateLimitRef),
      tx.get(fingerprintRef)
    ]);

    if (!isSecretsModuleEnabled(modulesConfigSnap.data())) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El modulo de secretos esta deshabilitado.'
      );
    }

    const runtimeSettings = resolveSecretRuntimeSettings(secretSettingsSnap.data());
    const text = sanitizeSecretText(textRaw, runtimeSettings.maxTextLength);
    if (text.length < runtimeSettings.minTextLength) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        `El secreto debe tener al menos ${runtimeSettings.minTextLength} caracteres.`
      );
    }
    if (!hasMeaningfulSecretText(text)) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Escribe un texto real, no solo emojis o simbolos.'
      );
    }

    const rateLimitData = rateLimitSnap.data() || {};
    let burstWindowStartMs = timestampToMillisOrZero(rateLimitData.burstWindowStart);
    let burstCount = Number(rateLimitData.burstCount || 0);

    // Reiniciar ráfaga si ya pasó el tiempo
    if (!burstWindowStartMs || nowMs - burstWindowStartMs >= runtimeSettings.createCooldownMs) {
      burstWindowStartMs = nowMs;
      burstCount = 0;
    }

    if (burstCount >= 3) {
      const elapsed = nowMs - burstWindowStartMs;
      const remainingMin = Math.max(
        1,
        Math.ceil((runtimeSettings.createCooldownMs - elapsed) / (60 * 1000))
      );
      throw new functions.https.HttpsError(
        'failed-precondition',
        `Has publicado demasiados secretos rapido. Espera ${remainingMin} min para publicar otro.`
      );
    }

    let dailyWindowStartMs = timestampToMillisOrZero(rateLimitData.dailyWindowStart);
    let dailyCount = Number(rateLimitData.dailyCount || 0);
    if (!dailyWindowStartMs || nowMs - dailyWindowStartMs >= oneDayMs) {
      dailyWindowStartMs = nowMs;
      dailyCount = 0;
    }

    if (dailyCount >= runtimeSettings.dailyLimit) {
      throw new functions.https.HttpsError(
        'resource-exhausted',
        'Alcanzaste el limite diario de secretos anonimos.'
      );
    }

    const counterData = secretCounterSnap.data() || {};
    const lastIssuedId = Math.max(
      SECRET_NUMERIC_ID_START - 1,
      Math.floor(Number(counterData.lastIssuedId || 0))
    );
    let nextSecretNumericId = lastIssuedId + 1;
    let secretRef = db.collection('content').doc(String(nextSecretNumericId));
    let secretSnap = await tx.get(secretRef);
    while (secretSnap.exists) {
      nextSecretNumericId += 1;
      secretRef = db.collection('content').doc(String(nextSecretNumericId));
      secretSnap = await tx.get(secretRef);
    }

    tx.set(
      secretCounterRef,
      {
        lastIssuedId: nextSecretNumericId,
        startFrom: SECRET_NUMERIC_ID_START,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    const secretId = String(nextSecretNumericId);
    const alias = createSecretAlias(fingerprintHash, secretId);
    const initialRank = computeSecretRank(0, 0, 0, nowMs);

    tx.set(secretRef, {
      module: 'secrets',
      type: 'secret',
      source: 'anonymous',
      isOficial: false,
      titulo: '',
      descripcion: text,
      category: category || null,
      zone: zone || null,
      sex,
      age,
      anonAlias: alias,
      stats: {
        upVotesCount: 0,
        downVotesCount: 0,
        commentsCount: 0,
        reportsCount: 0,
        viewsCount: 0,
        totalVotesCount: 0
      },
      rank: {
        score: initialRank.score,
        hotScore: initialRank.hotScore,
        controversyScore: initialRank.controversyScore,
        trend: initialRank.trend
      },
      moderation: {
        status: 'active',
        reason: null,
        reviewedBy: null,
        reviewedAt: null
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedAt: null
    });

    const nextRateLimit: Record<string, unknown> = {
      lastSecretAt: nowTs,
      dailyCount: dailyCount + 1,
      dailyWindowStart: admin.firestore.Timestamp.fromMillis(dailyWindowStartMs),
      burstWindowStart: admin.firestore.Timestamp.fromMillis(burstWindowStartMs),
      burstCount: burstCount + 1,
      expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + SECRET_FINGERPRINT_TTL_MS),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const preservedLastCommentAt = rateLimitData.lastCommentAt;
    if (preservedLastCommentAt instanceof admin.firestore.Timestamp) {
      nextRateLimit.lastCommentAt = preservedLastCommentAt;
    }

    tx.set(rateLimitRef, nextRateLimit, { merge: true });

    const existingFirstSeenAt =
      (fingerprintSnap.data()?.firstSeenAt instanceof admin.firestore.Timestamp)
        ? fingerprintSnap.data()?.firstSeenAt
        : nowTs;

    tx.set(
      fingerprintRef,
      {
        firstSeenAt: existingFirstSeenAt,
        lastSeenAt: nowTs,
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + SECRET_FINGERPRINT_TTL_MS),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      status: 'ok',
      secretId,
      anonAlias: alias
    };
  });
});

export const voteSecretCallable = functions.https.onCall(async (data, context) => {
  const secretId = typeof data?.secretId === 'string' ? data.secretId.trim() : '';
  const voteRaw = Number(data?.vote);
  const vote = voteRaw === -1 ? -1 : 1;
  if (!secretId) {
    throw new functions.https.HttpsError('invalid-argument', 'secretId es obligatorio.');
  }
  if (voteRaw !== 1 && voteRaw !== -1) {
    throw new functions.https.HttpsError('invalid-argument', 'vote debe ser 1 o -1.');
  }

  const fingerprintHash = buildSecretFingerprintHash(data, context);
  const nowMs = Date.now();
  const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);

  const modulesConfigRef = db.collection('_config').doc('modules');
  const secretRef = db.collection('content').doc(secretId);
  const voteRef = secretRef.collection('secret_votes').doc(fingerprintHash);
  const fingerprintRef = db.collection('secret_fingerprints').doc(fingerprintHash);

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, secretSnap, voteSnap, fingerprintSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(secretRef),
      tx.get(voteRef),
      tx.get(fingerprintRef)
    ]);

    if (!isSecretsModuleEnabled(modulesConfigSnap.data())) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El modulo de secretos esta deshabilitado.'
      );
    }
    if (!secretSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'El secreto no existe.');
    }

    const secretData = secretSnap.data() || {};
    if (secretData.module !== 'secrets' || secretData.deletedAt != null) {
      throw new functions.https.HttpsError('failed-precondition', 'El secreto no esta disponible.');
    }
    const moderationStatus = sanitizeBoundedString(secretData?.moderation?.status, 40) || 'active';
    if (moderationStatus !== 'active') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Este secreto no acepta interacciones por moderacion.'
      );
    }

    const previousVote = voteSnap.exists
      ? Number(voteSnap.data()?.vote || 0)
      : 0;
    if (previousVote === vote) {
      return {
        status: 'ok',
        secretId,
        unchanged: true,
        vote
      };
    }

    let upVotesCount = Math.max(0, Math.floor(Number(secretData?.stats?.upVotesCount || 0)));
    let downVotesCount = Math.max(0, Math.floor(Number(secretData?.stats?.downVotesCount || 0)));
    const commentsCount = Math.max(0, Math.floor(Number(secretData?.stats?.commentsCount || 0)));

    if (previousVote === 1) upVotesCount = Math.max(0, upVotesCount - 1);
    if (previousVote === -1) downVotesCount = Math.max(0, downVotesCount - 1);

    if (vote === 1) upVotesCount += 1;
    if (vote === -1) downVotesCount += 1;

    const createdAtMs = timestampToMillisOrZero(secretData.createdAt) || nowMs;
    const rank = computeSecretRank(upVotesCount, downVotesCount, commentsCount, createdAtMs);

    const existingVoteCreatedAt = voteSnap.data()?.createdAt;
    tx.set(
      voteRef,
      {
        vote,
        createdAt: existingVoteCreatedAt instanceof admin.firestore.Timestamp
          ? existingVoteCreatedAt
          : admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    tx.update(secretRef, {
      'stats.upVotesCount': upVotesCount,
      'stats.downVotesCount': downVotesCount,
      'stats.totalVotesCount': upVotesCount + downVotesCount,
      'rank.score': rank.score,
      'rank.hotScore': rank.hotScore,
      'rank.controversyScore': rank.controversyScore,
      'rank.trend': rank.trend,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const existingFirstSeenAt =
      (fingerprintSnap.data()?.firstSeenAt instanceof admin.firestore.Timestamp)
        ? fingerprintSnap.data()?.firstSeenAt
        : nowTs;

    tx.set(
      fingerprintRef,
      {
        firstSeenAt: existingFirstSeenAt,
        lastSeenAt: nowTs,
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + SECRET_FINGERPRINT_TTL_MS),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      status: 'ok',
      secretId,
      vote,
      upVotesCount,
      downVotesCount,
      score: rank.score,
      trend: rank.trend
    };
  });
});

export const createSecretCommentCallable = functions.https.onCall(async (data, context) => {
  const secretId = typeof data?.secretId === 'string' ? data.secretId.trim() : '';
  if (!secretId) {
    throw new functions.https.HttpsError('invalid-argument', 'secretId es obligatorio.');
  }

  const text = sanitizeSecretText(data?.text, SECRET_COMMENT_MAX_LENGTH);
  if (text.length < SECRET_COMMENT_MIN_LENGTH) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      `El comentario debe tener al menos ${SECRET_COMMENT_MIN_LENGTH} caracteres.`
    );
  }
  if (!hasMeaningfulSecretText(text)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Escribe un comentario valido.'
    );
  }

  const fingerprintHash = buildSecretFingerprintHash(data, context);
  const nowMs = Date.now();
  const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);

  const modulesConfigRef = db.collection('_config').doc('modules');
  const secretSettingsRef = db.collection('_config').doc('secret_settings');
  const secretRef = db.collection('content').doc(secretId);
  const rateLimitRef = db.collection('secret_rate_limits').doc(fingerprintHash);
  const fingerprintRef = db.collection('secret_fingerprints').doc(fingerprintHash);

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, secretSettingsSnap, secretSnap, rateLimitSnap, fingerprintSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(secretSettingsRef),
      tx.get(secretRef),
      tx.get(rateLimitRef),
      tx.get(fingerprintRef)
    ]);

    if (!isSecretsModuleEnabled(modulesConfigSnap.data())) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El modulo de secretos esta deshabilitado.'
      );
    }
    if (!secretSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'El secreto no existe.');
    }

    const secretData = secretSnap.data() || {};
    if (secretData.module !== 'secrets' || secretData.deletedAt != null) {
      throw new functions.https.HttpsError('failed-precondition', 'El secreto no esta disponible.');
    }
    const moderationStatus = sanitizeBoundedString(secretData?.moderation?.status, 40) || 'active';
    if (moderationStatus !== 'active') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Este secreto no permite comentarios.'
      );
    }

    const runtimeSettings = resolveSecretRuntimeSettings(secretSettingsSnap.data());
    const rateLimitData = rateLimitSnap.data() || {};
    const lastCommentAtMs = timestampToMillisOrZero(rateLimitData.lastCommentAt);
    if (lastCommentAtMs > 0) {
      const elapsed = nowMs - lastCommentAtMs;
      if (elapsed < runtimeSettings.commentCooldownMs) {
        const remaining = Math.max(1, Math.ceil((runtimeSettings.commentCooldownMs - elapsed) / 1000));
        throw new functions.https.HttpsError(
          'failed-precondition',
          `Espera ${remaining}s antes de comentar de nuevo.`
        );
      }
    }

    const commentRef = secretRef.collection('secret_comments').doc();
    const alias = createSecretAlias(fingerprintHash, `${secretId}:${commentRef.id}`);

    const upVotesCount = Math.max(0, Math.floor(Number(secretData?.stats?.upVotesCount || 0)));
    const downVotesCount = Math.max(0, Math.floor(Number(secretData?.stats?.downVotesCount || 0)));
    const commentsCount = Math.max(0, Math.floor(Number(secretData?.stats?.commentsCount || 0))) + 1;
    const createdAtMs = timestampToMillisOrZero(secretData.createdAt) || nowMs;
    const rank = computeSecretRank(upVotesCount, downVotesCount, commentsCount, createdAtMs);

    tx.set(commentRef, {
      text,
      anonAlias: alias,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedAt: null,
      score: 0,
      reportsCount: 0
    });

    tx.update(secretRef, {
      'stats.commentsCount': commentsCount,
      'rank.score': rank.score,
      'rank.hotScore': rank.hotScore,
      'rank.controversyScore': rank.controversyScore,
      'rank.trend': rank.trend,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const nextRateLimit: Record<string, unknown> = {
      lastCommentAt: nowTs,
      expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + SECRET_FINGERPRINT_TTL_MS),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const preservedLastSecretAt = rateLimitData.lastSecretAt;
    const preservedDailyCount = Number(rateLimitData.dailyCount || 0);
    const preservedDailyWindowStart = rateLimitData.dailyWindowStart;
    if (preservedLastSecretAt instanceof admin.firestore.Timestamp) {
      nextRateLimit.lastSecretAt = preservedLastSecretAt;
    }
    if (preservedDailyCount > 0) {
      nextRateLimit.dailyCount = preservedDailyCount;
    }
    if (preservedDailyWindowStart instanceof admin.firestore.Timestamp) {
      nextRateLimit.dailyWindowStart = preservedDailyWindowStart;
    }

    tx.set(rateLimitRef, nextRateLimit, { merge: true });

    const existingFirstSeenAt =
      (fingerprintSnap.data()?.firstSeenAt instanceof admin.firestore.Timestamp)
        ? fingerprintSnap.data()?.firstSeenAt
        : nowTs;

    tx.set(
      fingerprintRef,
      {
        firstSeenAt: existingFirstSeenAt,
        lastSeenAt: nowTs,
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + SECRET_FINGERPRINT_TTL_MS),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      status: 'ok',
      secretId,
      commentId: commentRef.id,
      anonAlias: alias
    };
  });
});

export const reportSecretCallable = functions.https.onCall(async (data, context) => {
  const secretId = typeof data?.secretId === 'string' ? data.secretId.trim() : '';
  if (!secretId) {
    throw new functions.https.HttpsError('invalid-argument', 'secretId es obligatorio.');
  }

  const reason = normalizeSecretReportReason(data?.reason);
  const fingerprintHash = buildSecretFingerprintHash(data, context);
  const nowMs = Date.now();
  const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);

  const modulesConfigRef = db.collection('_config').doc('modules');
  const secretSettingsRef = db.collection('_config').doc('secret_settings');
  const secretRef = db.collection('content').doc(secretId);
  const reportRef = secretRef.collection('secret_reports').doc(fingerprintHash);
  const fingerprintRef = db.collection('secret_fingerprints').doc(fingerprintHash);

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, secretSettingsSnap, secretSnap, reportSnap, fingerprintSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(secretSettingsRef),
      tx.get(secretRef),
      tx.get(reportRef),
      tx.get(fingerprintRef)
    ]);

    if (!isSecretsModuleEnabled(modulesConfigSnap.data())) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El modulo de secretos esta deshabilitado.'
      );
    }
    if (!secretSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'El secreto no existe.');
    }

    const secretData = secretSnap.data() || {};
    if (secretData.module !== 'secrets' || secretData.deletedAt != null) {
      throw new functions.https.HttpsError('failed-precondition', 'El secreto no esta disponible.');
    }

    if (reportSnap.exists) {
      return {
        status: 'already_reported',
        secretId
      };
    }

    const runtimeSettings = resolveSecretRuntimeSettings(secretSettingsSnap.data());
    const reportsCount = Math.max(0, Math.floor(Number(secretData?.stats?.reportsCount || 0))) + 1;
    const currentStatus = sanitizeBoundedString(secretData?.moderation?.status, 40) || 'active';
    const currentReason = secretData?.moderation?.reason ?? null;

    let nextStatus = currentStatus;
    let nextReason = currentReason;
    if (currentStatus === 'active' && reportsCount >= runtimeSettings.autoHideReportsThreshold) {
      nextStatus = 'hidden_auto';
      nextReason = 'report_threshold';
    }

    tx.set(reportRef, {
      reason,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    tx.update(secretRef, {
      'stats.reportsCount': reportsCount,
      'moderation.status': nextStatus,
      'moderation.reason': nextReason,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const existingFirstSeenAt =
      (fingerprintSnap.data()?.firstSeenAt instanceof admin.firestore.Timestamp)
        ? fingerprintSnap.data()?.firstSeenAt
        : nowTs;

    tx.set(
      fingerprintRef,
      {
        firstSeenAt: existingFirstSeenAt,
        lastSeenAt: nowTs,
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + SECRET_FINGERPRINT_TTL_MS),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      status: 'ok',
      secretId,
      reportsCount,
      moderationStatus: nextStatus
    };
  });
});

const SECRET_MODERATION_STATUS_VALUES = new Set([
  'all',
  'active',
  'hidden_auto',
  'hidden_admin',
  'blocked'
]);

const normalizeSecretModerationStatusFilter = (value: unknown): string => {
  const normalized = sanitizeBoundedString(value, 40).toLowerCase();
  if (SECRET_MODERATION_STATUS_VALUES.has(normalized)) return normalized;
  return 'all';
};

const normalizeSecretModerationAction = (
  value: unknown
): 'hide' | 'restore' | 'block' => {
  const normalized = sanitizeBoundedString(value, 40).toLowerCase();
  if (normalized === 'hide' || normalized === 'restore' || normalized === 'block') {
    return normalized;
  }
  throw new functions.https.HttpsError(
    'invalid-argument',
    'action debe ser hide, restore o block.'
  );
};

export const getSecretModerationQueueCallable = functions.https.onCall(async (data, context) => {
  await assertAdminUser(context.auth);

  const statusFilter = normalizeSecretModerationStatusFilter(data?.status);
  const limitValue = clampInteger(data?.limit, 10, 200, 80);

  let moderationQuery: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = db
    .collection('content')
    .where('module', '==', 'secrets')
    .where('deletedAt', '==', null);

  if (statusFilter !== 'all') {
    moderationQuery = moderationQuery.where('moderation.status', '==', statusFilter);
  }

  moderationQuery = moderationQuery.orderBy('createdAt', 'desc').limit(limitValue);
  const snapshot = await moderationQuery.get();

  const items = snapshot.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    return {
      secretId: docSnap.id,
      textPreview: sanitizeSecretText(data.descripcion, 280),
      category: sanitizeBoundedString(data.category, 40),
      zone: sanitizeBoundedString(data.zone, 60),
      createdAtMs: timestampToMillisOrZero(data.createdAt),
      updatedAtMs: timestampToMillisOrZero(data.updatedAt),
      moderation: {
        status: sanitizeBoundedString(data?.moderation?.status, 40) || 'active',
        reason: sanitizeBoundedString(data?.moderation?.reason, 180),
        reviewedBy: sanitizeBoundedString(data?.moderation?.reviewedBy, 128),
        reviewedAtMs: timestampToMillisOrZero(data?.moderation?.reviewedAt)
      },
      stats: {
        upVotesCount: Math.max(0, Math.floor(Number(data?.stats?.upVotesCount || 0))),
        downVotesCount: Math.max(0, Math.floor(Number(data?.stats?.downVotesCount || 0))),
        commentsCount: Math.max(0, Math.floor(Number(data?.stats?.commentsCount || 0))),
        reportsCount: Math.max(0, Math.floor(Number(data?.stats?.reportsCount || 0))),
        totalVotesCount: Math.max(0, Math.floor(Number(data?.stats?.totalVotesCount || 0)))
      }
    };
  });

  return {
    status: 'ok',
    filter: statusFilter,
    count: items.length,
    items,
    fetchedAtMs: Date.now()
  };
});

export const moderateSecretCallable = functions.https.onCall(async (data, context) => {
  await assertAdminUser(context.auth);

  const secretId = sanitizeBoundedString(data?.secretId, 128);
  if (!secretId) {
    throw new functions.https.HttpsError('invalid-argument', 'secretId es obligatorio.');
  }

  const action = normalizeSecretModerationAction(data?.action);
  const reasonInput = sanitizeSecretText(data?.reason, 180);
  const reviewerUid = context.auth?.uid || 'admin';

  const secretRef = db.collection('content').doc(secretId);

  return db.runTransaction(async (tx) => {
    const secretSnap = await tx.get(secretRef);
    if (!secretSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'El secreto no existe.');
    }
    const secretData = secretSnap.data() || {};
    if (secretData.module !== 'secrets' || secretData.deletedAt != null) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El secreto no esta disponible para moderacion.'
      );
    }

    let moderationStatus: 'active' | 'hidden_admin' | 'blocked' = 'active';
    let moderationReason: string | null = null;

    if (action === 'hide') {
      moderationStatus = 'hidden_admin';
      moderationReason = reasonInput || 'hidden_by_admin';
    } else if (action === 'block') {
      moderationStatus = 'blocked';
      moderationReason = reasonInput || 'blocked_by_admin';
    } else {
      moderationStatus = 'active';
      moderationReason = null;
    }

    tx.update(secretRef, {
      'moderation.status': moderationStatus,
      'moderation.reason': moderationReason,
      'moderation.reviewedBy': reviewerUid,
      'moderation.reviewedAt': admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      status: 'ok',
      secretId,
      moderationStatus,
      action
    };
  });
});

export const refreshSecretRankingsCallable = functions.https.onCall(async (_data, context) => {
  await assertStaffUser(context.auth);
  const rankings = await refreshSecretRankingsInternal();
  const lists = (rankings.lists || {}) as Record<string, unknown[]>;

  return {
    status: 'ok',
    generatedAtMs: Number(rankings.generatedAtMs || Date.now()),
    sourceSampleSize: Number((rankings.source as any)?.sampleSize || 0),
    counts: {
      topDay: Array.isArray(lists.topDay) ? lists.topDay.length : 0,
      mostCommented: Array.isArray(lists.mostCommented) ? lists.mostCommented.length : 0,
      mostVoted: Array.isArray(lists.mostVoted) ? lists.mostVoted.length : 0,
      mostPolemic: Array.isArray(lists.mostPolemic) ? lists.mostPolemic.length : 0
    }
  };
});

export const refreshSecretRankings = functions.pubsub
  .schedule('every 5 minutes')
  .onRun(async () => {
    const rankings = await refreshSecretRankingsInternal();
    const sampleSize = Number((rankings.source as any)?.sampleSize || 0);
    console.log(`Secret rankings refreshed. sampleSize=${sampleSize}`);
    return null;
  });

// 2. Comments
export const onCommentCreated = functions.firestore
  .document('content/{contentId}/comments/{commentId}')
  .onCreate(async (snap, context) => {
    const { contentId, commentId } = context.params;
    const commentData = snap.data();
    if (!commentData || !commentData.userId || commentData.deletedAt != null) return;

    try {
      const contentRef = db.collection('content').doc(contentId);
      await contentRef.set(
        {
          stats: {
            commentsCount: admin.firestore.FieldValue.increment(1)
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      const contentSnap = await contentRef.get();
      if (!contentSnap.exists) return;
      const contentData = contentSnap.data() || {};
      if (contentData.deletedAt != null) return;

      const recipientUserId = sanitizeBoundedString(contentData.userId, 128);
      const actorUserId = sanitizeBoundedString(commentData.userId, 128);
      if (!recipientUserId || !actorUserId) return;

      const actor = await loadNotificationActorIdentity(actorUserId);
      const contentTarget = buildContentTargetFromDoc(contentId, contentData);
      await writeNotificationEvent({
        type: 'comment',
        recipientUserId,
        actor,
        commentId,
        contentTarget,
        targetPath: contentTarget.targetPath
      });

      console.log(`Comment +1 for ${contentId}`);
    } catch (error) {
      console.error(`Comment increment failed`, error);
    }
  });

export const onCommentUpdated = functions.firestore
  .document('content/{contentId}/comments/{commentId}')
  .onUpdate(async (change, context) => {
    const { contentId, commentId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();
    if (!beforeData || !afterData) return;

    const wasAlive = beforeData.deletedAt == null;
    const isAlive = afterData.deletedAt == null;
    if (wasAlive === isAlive) return;

    const delta = isAlive ? 1 : -1;
    try {
      await db.collection('content').doc(contentId).set(
        {
          stats: {
            commentsCount: admin.firestore.FieldValue.increment(delta)
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      console.log(`Comment ${commentId} visibility changed (delta ${delta})`);
    } catch (error) {
      console.error(`Comment visibility update failed`, error);
    }
  });

export const onReplyCreated = functions.firestore
  .document('content/{contentId}/comments/{commentId}/replies/{replyId}')
  .onCreate(async (snap, context) => {
    const { contentId, commentId, replyId } = context.params;
    const replyData = snap.data();
    if (!replyData || !replyData.userId || replyData.deletedAt != null) return;

    try {
      const commentRef = buildCommentRef(contentId, commentId);
      await commentRef.set(
        {
          stats: {
            repliesCount: admin.firestore.FieldValue.increment(1)
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      const [commentSnap, contentSnap] = await Promise.all([
        commentRef.get(),
        db.collection('content').doc(contentId).get()
      ]);
      if (!commentSnap.exists) return;

      const parentCommentData = commentSnap.data() || {};
      if (parentCommentData.deletedAt != null) return;

      const recipientUserId = sanitizeBoundedString(parentCommentData.userId, 128);
      const actorUserId = sanitizeBoundedString(replyData.userId, 128);
      if (!recipientUserId || !actorUserId) return;

      const actor = await loadNotificationActorIdentity(actorUserId);
      const fallbackModule: 'news' | 'community' = replyData.module === 'news'
        ? 'news'
        : 'community';
      const contentTarget = contentSnap.exists
        ? buildContentTargetFromDoc(contentId, contentSnap.data() || {})
        : {
          contentId,
          contentModule: fallbackModule,
          contentPublicRef: contentId,
          contentSlug: normalizeContentSlug(contentId),
          targetPath: `/c/${encodeURIComponent(contentId)}/${encodeURIComponent(normalizeContentSlug(contentId))}`
        };
      await writeNotificationEvent({
        type: 'reply',
        recipientUserId,
        actor,
        commentId,
        replyId,
        contentTarget,
        targetPath: contentTarget.targetPath
      });

      console.log(`Reply +1 for comment ${commentId}`);
    } catch (error) {
      console.error(`Reply increment failed`, error);
    }
  });

export const onReplyUpdated = functions.firestore
  .document('content/{contentId}/comments/{commentId}/replies/{replyId}')
  .onUpdate(async (change, context) => {
    const { contentId, commentId, replyId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();
    if (!beforeData || !afterData) return;

    const wasAlive = beforeData.deletedAt == null;
    const isAlive = afterData.deletedAt == null;
    if (wasAlive === isAlive) return;

    const delta = isAlive ? 1 : -1;
    try {
      await buildCommentRef(contentId, commentId).set(
        {
          stats: {
            repliesCount: admin.firestore.FieldValue.increment(delta)
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      console.log(`Reply ${replyId} visibility changed (delta ${delta})`);
    } catch (error) {
      console.error(`Reply visibility update failed`, error);
    }
  });

// 2. Follows
// Trigger source of truth:
// relationships/{userId}/followers/{followerId}
// -> followerId follows userId
export const onFollowAdded = functions.firestore
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

      const actor = await loadNotificationActorIdentity(followerId);
      const targetPath = buildProfileTargetPath(actor.actorUsername, actor.userId);
      await writeNotificationEvent({
        type: 'follow',
        recipientUserId: userId,
        actor,
        targetPath
      });

      console.log(`Follow +1: ${followerId} -> ${userId}`);
    } catch (error) {
      console.error(`Follow increment failed`, error);
    }
  });

export const onFollowRemoved = functions.firestore
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
    } catch (error) {
      console.error(`Unfollow decrement failed`, error);
    }
  });

export const updateMyProfile = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para actualizar tu perfil.'
    );
  }

  const authToken = (context.auth?.token || {}) as Record<string, unknown>;
  const emailFromToken = typeof authToken.email === 'string' ? authToken.email : '';

  const { username, usernameLower } = normalizeUsernameStrict(data?.username);
  const nombre = sanitizeBoundedString(data?.nombre, 120);
  if (!nombre) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'nombre es obligatorio.'
    );
  }

  const bio = sanitizeBoundedString(data?.bio, 280);
  const location = sanitizeBoundedString(data?.location, 120);
  const website = sanitizeOptionalUrl(data?.website, 'website');
  const profilePictureUrl = sanitizeBoundedString(data?.profilePictureUrl, 1200);

  const userRef = db.collection('users').doc(userId);
  const userPublicRef = db.collection('users_public').doc(userId);
  const usernameRef = db.collection('usernames').doc(usernameLower);

  const result = await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const currentData = userSnap.exists
      ? (userSnap.data() || {})
      : ({} as FirebaseFirestore.DocumentData);

    const currentIdentity = normalizeUsernameLoose(userId, currentData);
    const previousUsernameLower = currentIdentity.usernameLower;
    const previousUsernameRef = db.collection('usernames').doc(previousUsernameLower);

    const usernameSnap = await tx.get(usernameRef);
    if (usernameSnap.exists && usernameSnap.data()?.uid !== userId) {
      throw new functions.https.HttpsError(
        'already-exists',
        'Ese username ya esta en uso.'
      );
    }

    if (previousUsernameLower !== usernameLower) {
      const previousUsernameSnap = await tx.get(previousUsernameRef);
      if (previousUsernameSnap.exists && previousUsernameSnap.data()?.uid === userId) {
        tx.delete(previousUsernameRef);
      }
    }

    const mergedStats = ensureUserStats(currentData.stats);
    const mergedSettings = ensureUserSettings(currentData.settings);

    const nextProfile: FirebaseFirestore.DocumentData = {
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
    tx.set(
      usernameRef,
      {
        uid: userId,
        username,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

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

  return {
    ok: true,
    ...result
  };
});

export const updateNotificationPreferences = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para configurar notificaciones.'
    );
  }

  const userRef = db.collection('users').doc(userId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError(
      'not-found',
      'No se encontro el perfil del usuario.'
    );
  }

  const currentSettings = ensureUserSettings(userSnap.data()?.settings);
  const currentTypes = ensureNotificationTypeSettings(currentSettings.notificationTypes);
  const hasNotificationsEnabled = Object.prototype.hasOwnProperty.call(data || {}, 'notificationsEnabled');
  const hasLikes = Object.prototype.hasOwnProperty.call(data || {}, 'likes');
  const hasComments = Object.prototype.hasOwnProperty.call(data || {}, 'comments');
  const hasReplies = Object.prototype.hasOwnProperty.call(data || {}, 'replies');
  const hasFollows = Object.prototype.hasOwnProperty.call(data || {}, 'follows');

  const nextSettings = {
    ...currentSettings,
    privateAccount: currentSettings.privateAccount === true,
    notificationsEnabled: hasNotificationsEnabled
      ? data.notificationsEnabled === true
      : currentSettings.notificationsEnabled !== false,
    notificationTypes: {
      likes: hasLikes ? data.likes === true : currentTypes.likes,
      comments: hasComments ? data.comments === true : currentTypes.comments,
      replies: hasReplies ? data.replies === true : currentTypes.replies,
      follows: hasFollows ? data.follows === true : currentTypes.follows
    }
  };

  await userRef.set(
    {
      settings: nextSettings,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return {
    ok: true,
    settings: nextSettings
  };
});

export const updateHomeFeedPreference = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para configurar tu feed.'
    );
  }

  const rawDefaultFeedTab = sanitizeBoundedString(data?.defaultFeedTab, 40).toLowerCase();
  if (!rawDefaultFeedTab || !USER_DEFAULT_FEED_TAB_VALUES.has(rawDefaultFeedTab as UserDefaultFeedTab)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'defaultFeedTab invalido. Valores permitidos: todo, news, post, surveys, lottery.'
    );
  }

  const userRef = db.collection('users').doc(userId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError(
      'not-found',
      'No se encontro el perfil del usuario.'
    );
  }

  const currentSettings = ensureUserSettings(userSnap.data()?.settings);
  const nextSettings = {
    ...currentSettings,
    defaultFeedTab: rawDefaultFeedTab
  };

  await userRef.set(
    {
      settings: nextSettings,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return {
    ok: true,
    settings: nextSettings
  };
});

export const registerNotificationDevice = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para registrar un dispositivo.'
    );
  }

  const token = sanitizeBoundedString(data?.token, 4096);
  if (!token) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'token es obligatorio.'
    );
  }

  const platformRaw = sanitizeBoundedString(data?.platform, 20).toLowerCase();
  if (platformRaw !== 'web' && platformRaw !== 'android') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'platform debe ser "web" o "android".'
    );
  }
  const platform = platformRaw as NotificationPlatform;
  const deviceId = sanitizeNotificationDeviceId(data?.deviceId, token, platform);
  const locale = sanitizeBoundedString(data?.locale, 64);
  const timezone = sanitizeBoundedString(data?.timezone, 80);
  const userAgent = sanitizeBoundedString(data?.userAgent, 255);

  const devicesCollection = db.collection('users').doc(userId).collection('notification_devices');
  const deviceRef = devicesCollection.doc(deviceId);

  await db.runTransaction(async (tx) => {
    const deviceSnap = await tx.get(deviceRef);
    const previous = deviceSnap.data() || {};

    tx.set(
      deviceRef,
      {
        token,
        platform,
        enabled: true,
        locale,
        timezone,
        userAgent,
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: deviceSnap.exists
          ? (previous.createdAt || admin.firestore.FieldValue.serverTimestamp())
          : admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });

  const duplicatesSnap = await devicesCollection.where('token', '==', token).get();
  const duplicatesToDelete = duplicatesSnap.docs
    .filter((docSnap) => docSnap.id !== deviceId)
    .map((docSnap) => docSnap.ref);

  if (duplicatesToDelete.length > 0) {
    const batch = db.batch();
    for (const duplicateRef of duplicatesToDelete) {
      batch.delete(duplicateRef);
    }
    await batch.commit();
  }

  return {
    ok: true,
    deviceId,
    platform
  };
});

export const unregisterNotificationDevice = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para eliminar un dispositivo.'
    );
  }

  const devicesCollection = db.collection('users').doc(userId).collection('notification_devices');
  const deviceId = sanitizeBoundedString(data?.deviceId, NOTIFICATION_DEVICE_ID_MAX_LENGTH);
  const token = sanitizeBoundedString(data?.token, 4096);

  if (!deviceId && !token) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Debes enviar deviceId o token.'
    );
  }

  const refsToDelete: FirebaseFirestore.DocumentReference[] = [];
  if (deviceId) {
    refsToDelete.push(devicesCollection.doc(deviceId));
  } else {
    const tokenMatches = await devicesCollection.where('token', '==', token).get();
    refsToDelete.push(...tokenMatches.docs.map((docSnap) => docSnap.ref));
  }

  if (refsToDelete.length > 0) {
    const batch = db.batch();
    for (const ref of refsToDelete) {
      batch.delete(ref);
    }
    await batch.commit();
  }

  return {
    ok: true,
    removed: refsToDelete.length
  };
});

export const markNotificationRead = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para actualizar notificaciones.'
    );
  }

  const notificationId = sanitizeBoundedString(data?.notificationId, 200);
  if (!notificationId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'notificationId es obligatorio.'
    );
  }

  const notificationRef = db.collection('users').doc(userId).collection('notifications').doc(notificationId);
  const notificationSnap = await notificationRef.get();
  if (!notificationSnap.exists) {
    throw new functions.https.HttpsError(
      'not-found',
      'La notificacion no existe.'
    );
  }

  if (notificationSnap.data()?.isRead === true) {
    return {
      ok: true,
      updated: false
    };
  }

  await notificationRef.set(
    {
      isRead: true,
      readAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return {
    ok: true,
    updated: true
  };
});

export const markAllNotificationsRead = functions.https.onCall(async (_data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para actualizar notificaciones.'
    );
  }

  const notificationsCollection = db.collection('users').doc(userId).collection('notifications');
  let updatedCount = 0;

  while (true) {
    const unreadSnap = await notificationsCollection
      .where('isRead', '==', false)
      .limit(NOTIFICATION_PAGE_SIZE)
      .get();
    if (unreadSnap.empty) break;

    const batch = db.batch();
    for (const unreadDoc of unreadSnap.docs) {
      batch.set(
        unreadDoc.ref,
        {
          isRead: true,
          readAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }
    await batch.commit();
    updatedCount += unreadSnap.size;

    if (unreadSnap.size < NOTIFICATION_PAGE_SIZE) break;
  }

  return {
    ok: true,
    updatedCount
  };
});

export const updateUserManagement = functions.https.onCall(async (data, context) => {
  await assertStaffUser(context.auth);

  const requesterAuth = context.auth;
  const targetUserId = sanitizeBoundedString(data?.userId, 128);
  if (!targetUserId) {
    throw new functions.https.HttpsError('invalid-argument', 'userId es obligatorio.');
  }

  const nextRole = sanitizeBoundedString(data?.rol, 40);
  const hasRoleUpdate = nextRole.length > 0;
  const allowedRoles = new Set([
    'usuario',
    'colaborador',
    'admin',
    'administrador',
    'super_admin',
    'superadmin',
    'Sistema-no-user',
    'sistema-no-user'
  ]);
  if (hasRoleUpdate && !allowedRoles.has(nextRole)) {
    throw new functions.https.HttpsError('invalid-argument', 'Rol invalido.');
  }

  const hasVerifiedUpdate = typeof data?.isVerified === 'boolean';
  const nextIsVerified = hasVerifiedUpdate ? Boolean(data.isVerified) : null;

  const nextNombreRaw = sanitizeBoundedString(data?.nombre, 120);
  const nextEmailRaw = sanitizeBoundedString(data?.email, 320).toLowerCase();
  const usernameCandidate = normalizeUsernameCandidate(data?.username);
  const hasCoreFieldInput = (
    typeof data?.nombre === 'string' ||
    typeof data?.username === 'string' ||
    typeof data?.email === 'string'
  );

  if (typeof data?.username === 'string' && usernameCandidate.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Username invalido.');
  }
  if (
    typeof data?.username === 'string' &&
    (usernameCandidate.length < USERNAME_MIN_LENGTH ||
      usernameCandidate.length > USERNAME_MAX_LENGTH ||
      !USERNAME_REGEX.test(usernameCandidate))
  ) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Username invalido. Usa entre 3 y 30 caracteres: a-z, 0-9 y _.'
    );
  }
  if (typeof data?.nombre === 'string' && !nextNombreRaw) {
    throw new functions.https.HttpsError('invalid-argument', 'Nombre invalido.');
  }
  if (typeof data?.email === 'string') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(nextEmailRaw)) {
      throw new functions.https.HttpsError('invalid-argument', 'Email invalido.');
    }
  }

  const userRef = db.collection('users').doc(targetUserId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Usuario no encontrado.');
  }

  const currentData = userSnap.data() || {};
  const currentNombre = sanitizeBoundedString(currentData.nombre, 120);
  const currentEmail = sanitizeBoundedString(currentData.email, 320).toLowerCase();
  const currentUsernameLower = sanitizeBoundedString(currentData.usernameLower, USERNAME_MAX_LENGTH);
  const nextUsernameLower = typeof data?.username === 'string'
    ? usernameCandidate
    : currentUsernameLower;

  const nextNombre = typeof data?.nombre === 'string' ? nextNombreRaw : currentNombre;
  const nextEmail = typeof data?.email === 'string' ? nextEmailRaw : currentEmail;
  const willUpdateCoreFields = hasCoreFieldInput && (
    nextNombre !== currentNombre ||
    nextEmail !== currentEmail ||
    nextUsernameLower !== currentUsernameLower
  );

  if (willUpdateCoreFields) {
    assertSystemAdminUser(requesterAuth);
  }

  if (nextUsernameLower !== currentUsernameLower) {
    const usernameRef = db.collection('usernames').doc(nextUsernameLower);
    const usernameSnap = await usernameRef.get();
    if (usernameSnap.exists && usernameSnap.data()?.uid !== targetUserId) {
      throw new functions.https.HttpsError('already-exists', 'Ese username ya esta en uso.');
    }
  }

  const updates: Record<string, unknown> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (hasRoleUpdate) {
    updates.rol = nextRole;
  }
  if (hasVerifiedUpdate) {
    updates.isVerified = nextIsVerified;
  }
  if (willUpdateCoreFields) {
    updates.nombre = nextNombre;
    updates.email = nextEmail;
    updates.username = nextUsernameLower;
    updates.usernameLower = nextUsernameLower;
  }

  await userRef.set(updates, { merge: true });

  if (willUpdateCoreFields && nextEmail !== currentEmail) {
    await admin.auth().updateUser(targetUserId, { email: nextEmail });
  }

  return {
    ok: true,
    userId: targetUserId,
    updated: {
      rol: hasRoleUpdate ? nextRole : currentData.rol,
      isVerified: hasVerifiedUpdate ? nextIsVerified : currentData.isVerified,
      nombre: willUpdateCoreFields ? nextNombre : currentData.nombre,
      email: willUpdateCoreFields ? nextEmail : currentData.email,
      username: willUpdateCoreFields ? nextUsernameLower : currentData.username
    }
  };
});

export const getUsersSocialConnections = functions.https.onCall(async (data, context) => {
  await assertStaffUser(context.auth);

  const rawUserIds = Array.isArray(data?.userIds) ? data.userIds : [];
  const normalizedUserIds: string[] = rawUserIds
    .map((value: unknown) => sanitizeBoundedString(value, 128))
    .filter((value: string) => value.length > 0);
  const userIds: string[] = Array.from(new Set(normalizedUserIds)).slice(0, 50);

  if (userIds.length === 0) {
    return {
      ok: true,
      records: {}
    };
  }

  const records: Record<string, { providerIds: string[] }> = {};
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const userRecord = await admin.auth().getUser(uid);
        const providerIds = Array.from(
          new Set(
            (userRecord.providerData || [])
              .map((provider) => sanitizeBoundedString(provider.providerId, 64))
              .filter((providerId) => providerId.length > 0)
          )
        );
        records[uid] = { providerIds };
      } catch (error: any) {
        if (error?.code === 'auth/user-not-found') {
          records[uid] = { providerIds: [] };
          return;
        }
        console.error(`Error loading auth providers for uid ${uid}:`, error);
      }
    })
  );

  return {
    ok: true,
    records
  };
});

export const syncPublicUserProfile = functions.firestore
  .document('users/{userId}')
  .onWrite(async (change, context) => {
    const { userId } = context.params;

    if (!change.after.exists) {
      const beforeData = change.before.data() || {};
      const previousIdentity = normalizeUsernameLoose(userId, beforeData);
      const previousUsernameRef = db.collection('usernames').doc(previousIdentity.usernameLower);

      await db.runTransaction(async (tx) => {
        const previousUsernameSnap = await tx.get(previousUsernameRef);
        if (previousUsernameSnap.exists && previousUsernameSnap.data()?.uid === userId) {
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
      const currentUsernameSnap = await tx.get(currentUsernameRef);
      if (!currentUsernameSnap.exists || currentUsernameSnap.data()?.uid === userId) {
        tx.set(
          currentUsernameRef,
          {
            uid: userId,
            username: currentIdentity.username,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      } else {
        console.warn(
          `Username collision detected for ${currentIdentity.usernameLower}. Keeping existing owner.`
        );
      }

      if (previousIdentity.usernameLower !== currentIdentity.usernameLower) {
        const previousUsernameSnap = await tx.get(previousUsernameRef);
        if (previousUsernameSnap.exists && previousUsernameSnap.data()?.uid === userId) {
          tx.delete(previousUsernameRef);
        }
      }

      tx.set(usersPublicRef, publicProfile, { merge: true });
    });

    return null;
  });

// 3. User Updates (PropagaciÃ³n desnormalizada)
export const onUserUpdated = functions.firestore
  .document('users/{userId}')
  .onUpdate(async (change, context) => {
    const { userId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();

    try {
      const nameChanged = beforeData.nombre !== afterData.nombre;
      const pictureChanged = beforeData.profilePictureUrl !== afterData.profilePictureUrl;
      const usernameChanged = beforeData.username !== afterData.username;

      if (!nameChanged && !pictureChanged && !usernameChanged) return;

      const postUpdateData: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {};
      const commentsUpdateData: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {};
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

      console.log(
        `User profile updated for ${userId}: posts=${postsUpdated}, comments=${commentsUpdated}, replies=${repliesUpdated}`
      );
    } catch (error) {
      console.error(`âŒ User update propagation failed:`, error);
    }
  });

// 4. Content Tracking
export const onContentSlugSync = functions.firestore
  .document('content/{contentId}')
  .onWrite(async (change, context) => {
    if (!change.after.exists) return null;

    const contentRef = change.after.ref;
    const beforeData = change.before.exists ? change.before.data() || {} : {};
    const afterData = change.after.data() || {};

    const beforeSlug = typeof beforeData.slug === 'string' ? beforeData.slug.trim() : '';
    const afterSlug = typeof afterData.slug === 'string' ? afterData.slug.trim() : '';
    const beforeModule = change.before.exists ? inferContentModule(beforeData) : null;
    const afterModule = inferContentModule(afterData);
    const beforePublicId =
      beforeModule === 'news'
        ? extractNewsPublicIdFromPayload(beforeData)
        : '';
    const afterPublicId =
      afterModule === 'news'
        ? extractNewsPublicIdFromPayload(afterData)
        : '';

    const shouldSync =
      !change.before.exists ||
      !afterSlug ||
      beforeSlug !== afterSlug ||
      beforeModule !== afterModule ||
      beforePublicId !== afterPublicId;

    if (!shouldSync) return null;

    try {
      await db.runTransaction(async (transaction) => {
        const freshSnapshot = await transaction.get(contentRef);
        if (!freshSnapshot.exists) return;

        const freshData = freshSnapshot.data() || {};
        const freshModule = inferContentModule(freshData);
        const freshPublicId =
          freshModule === 'news'
            ? extractNewsPublicIdFromPayload(freshData)
            : '';
        const existingSlugRaw =
          typeof freshData.slug === 'string' ? freshData.slug.trim() : '';

        if (existingSlugRaw) {
          const normalizedExistingSlug = normalizeContentSlug(existingSlugRaw);
          const existingSlugKey = buildContentSlugKey(freshModule, normalizedExistingSlug);

          transaction.set(
            db.collection('_content_slugs').doc(existingSlugKey),
            {
              contentId: freshSnapshot.id,
              module: freshModule,
              slug: normalizedExistingSlug,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            { merge: true }
          );

          const normalizedBase = buildContentSlugBase(freshData);
          const syncUpdate: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {};
          if (freshData.slug !== normalizedExistingSlug) syncUpdate.slug = normalizedExistingSlug;
          if (freshData.slugBase !== normalizedBase) syncUpdate.slugBase = normalizedBase;
          if (freshData.slugModule !== freshModule) syncUpdate.slugModule = freshModule;

          if (freshModule === 'news' && freshPublicId) {
            const numericPublicId = Number(freshPublicId);
            if (freshData.publicId !== freshPublicId) syncUpdate.publicId = freshPublicId;
            if (freshData.postId !== numericPublicId) syncUpdate.postId = numericPublicId;

            transaction.set(
              db.collection('_content_public_ids').doc(buildContentPublicIdKey(freshModule, freshPublicId)),
              {
                contentId: freshSnapshot.id,
                module: freshModule,
                publicId: freshPublicId,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              },
              { merge: true }
            );
          }

          if (Object.keys(syncUpdate).length > 0) {
            transaction.set(contentRef, syncUpdate, { merge: true });
          }
          return;
        }

        const slugBase = buildContentSlugBase(freshData);
        let nextSlug = slugBase;
        let attempt = 2;

        while (true) {
          const slugKey = buildContentSlugKey(freshModule, nextSlug);
          const slugRef = db.collection('_content_slugs').doc(slugKey);
          const slugSnapshot = await transaction.get(slugRef);

          if (!slugSnapshot.exists) {
            transaction.set(
              contentRef,
              {
                slug: nextSlug,
                slugBase,
                slugModule: freshModule,
                ...(freshModule === 'news' && freshPublicId
                  ? { publicId: freshPublicId, postId: Number(freshPublicId) }
                  : {})
              },
              { merge: true }
            );

            transaction.set(
              slugRef,
              {
                contentId: freshSnapshot.id,
                module: freshModule,
                slug: nextSlug,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              },
              { merge: true }
            );

            if (freshModule === 'news' && freshPublicId) {
              transaction.set(
                db.collection('_content_public_ids').doc(buildContentPublicIdKey(freshModule, freshPublicId)),
                {
                  contentId: freshSnapshot.id,
                  module: freshModule,
                  publicId: freshPublicId,
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                },
                { merge: true }
              );
            }
            return;
          }

          const mappedId = String(slugSnapshot.data()?.contentId || '').trim();
          if (mappedId === freshSnapshot.id) {
            transaction.set(
              contentRef,
              {
                slug: nextSlug,
                slugBase,
                slugModule: freshModule,
                ...(freshModule === 'news' && freshPublicId
                  ? { publicId: freshPublicId, postId: Number(freshPublicId) }
                  : {})
              },
              { merge: true }
            );

            if (freshModule === 'news' && freshPublicId) {
              transaction.set(
                db.collection('_content_public_ids').doc(buildContentPublicIdKey(freshModule, freshPublicId)),
                {
                  contentId: freshSnapshot.id,
                  module: freshModule,
                  publicId: freshPublicId,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                },
                { merge: true }
              );
            }
            return;
          }

          const suffix = `-${attempt}`;
          const allowedBaseLength = Math.max(1, CONTENT_SLUG_MAX_LENGTH - suffix.length);
          const shortenedBase = slugBase.slice(0, allowedBaseLength).replace(/-+$/g, '') || 'contenido';
          nextSlug = `${shortenedBase}${suffix}`;
          attempt += 1;
        }
      });
    } catch (error) {
      console.error(`Slug sync failed for content ${context.params.contentId}:`, error);
    }

    return null;
  });

export const onContentCreated = functions.firestore
  .document('content/{contentId}')
  .onCreate(async (snap, context) => {
    const contentData = snap.data();
    if (!contentData) return;

    const isCommunityPost =
      contentData.module === 'community' || contentData.type === 'post';
    if (!isCommunityPost || !contentData.userId) return;
    
    try {
      await db.collection('users').doc(contentData.userId).update({
        'stats.postsCount': admin.firestore.FieldValue.increment(1)
      });
    } catch (error) {
      console.error(`âŒ Content created increment failed:`, error);
    }
  });

export const onContentDeleted = functions.firestore
  .document('content/{contentId}')
  .onUpdate(async (change, context) => {
    const { contentId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();

    const isCommunityPost =
      afterData.module === 'community' || afterData.type === 'post';
    if (!isCommunityPost || !afterData.userId) return;

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
      } else if (!wasAlive && !isNowDeleted) {
        const userId = afterData.userId;
        await db.collection('users').doc(userId).update({
          'stats.postsCount': admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`âœ… Content restored: ${contentId}, postsCount incremented`);
      }
    } catch (error) {
      console.error(`âŒ Content deletion handling failed:`, error);
    }
  });

// 5. IntegraciÃ³n Oficial de Noticias desde WordPress via Realtime Database
export const onOfficialNewsReceived = functions.database
  .ref('/news/{newsId}')
  .onWrite(async (change, context) => {
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
      const parseDateCandidate = (value: unknown): admin.firestore.Timestamp | null => {
        if (!value) return null;
        if (value instanceof admin.firestore.Timestamp) return value;
        if (value instanceof Date && !isNaN(value.getTime())) {
          return admin.firestore.Timestamp.fromDate(value);
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
          const asMs = value > 1e12 ? value : value * 1000;
          const parsedNumeric = new Date(asMs);
          if (!isNaN(parsedNumeric.getTime())) {
            return admin.firestore.Timestamp.fromDate(parsedNumeric);
          }
          return null;
        }
        if (typeof value !== 'string') return null;

        const raw = value.trim();
        if (!raw) return null;

        const parsedNative = new Date(raw);
        if (!isNaN(parsedNative.getTime())) {
          return admin.firestore.Timestamp.fromDate(parsedNative);
        }

        const isoLike = raw.match(
          /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
        );
        if (isoLike) {
          const [, y, m, d, h, min, s] = isoLike;
          const parsedIsoLike = new Date(
            Number(y),
            Number(m) - 1,
            Number(d),
            Number(h),
            Number(min),
            Number(s || '0')
          );
          if (!isNaN(parsedIsoLike.getTime())) {
            return admin.firestore.Timestamp.fromDate(parsedIsoLike);
          }
        }

        const latamLike = raw.match(
          /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/
        );
        if (latamLike) {
          const [, d, m, y, h, min, s] = latamLike;
          const parsedLatam = new Date(
            Number(y),
            Number(m) - 1,
            Number(d),
            Number(h || '0'),
            Number(min || '0'),
            Number(s || '0')
          );
          if (!isNaN(parsedLatam.getTime())) {
            return admin.firestore.Timestamp.fromDate(parsedLatam);
          }
        }

        return null;
      };

      const contentRef = db.collection('content').doc(newsId);
      const existingSnap = await contentRef.get();
      const existingCreatedAt = existingSnap.exists ? existingSnap.data()?.createdAt : null;

      const createdCandidates: unknown[] = [
        afterData.createdAt,
        afterData.created_at,
        afterData.date,
        afterData.postDate,
        afterData.post_date,
        afterData.custom_fields?.createdAt,
        afterData.custom_fields?.date
      ];
      const updatedCandidates: unknown[] = [
        afterData.updatedAt,
        afterData.updated_at,
        afterData.modified,
        afterData.modifiedAt,
        afterData.custom_fields?.updatedAt,
        afterData.custom_fields?.modified
      ];

      let parsedCreatedAt: admin.firestore.Timestamp | null = null;
      for (const candidate of createdCandidates) {
        parsedCreatedAt = parseDateCandidate(candidate);
        if (parsedCreatedAt) break;
      }

      let parsedUpdatedAt: admin.firestore.Timestamp | null = null;
      for (const candidate of updatedCandidates) {
        parsedUpdatedAt = parseDateCandidate(candidate);
        if (parsedUpdatedAt) break;
      }

      const createdAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp =
        parsedCreatedAt ||
        (existingCreatedAt instanceof admin.firestore.Timestamp
          ? existingCreatedAt
          : admin.firestore.FieldValue.serverTimestamp());
      const updatedAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp =
        parsedUpdatedAt || admin.firestore.FieldValue.serverTimestamp();

      const normalizedPostId = extractNewsPublicIdFromPayload(afterData);
      const postIdNumber = normalizedPostId ? Number(normalizedPostId) : null;
      const normalizeUrlCandidate = (value: unknown): string => {
        if (typeof value !== 'string') return '';
        return value.trim().slice(0, 2400);
      };
      const coverThumbnailUrl = [
        normalizeUrlCandidate(afterData.img_miniatura),
        normalizeUrlCandidate(afterData.imgMiniatura),
        normalizeUrlCandidate(afterData.thumbnail),
        normalizeUrlCandidate(afterData.thumbnailUrl),
        normalizeUrlCandidate(afterData.coverThumbnailUrl),
        normalizeUrlCandidate(afterData.custom_fields?.img_miniatura),
        normalizeUrlCandidate(afterData.custom_fields?.thumbnail),
        normalizeUrlCandidate(afterData.custom_fields?.thumbnailUrl)
      ].find((value) => value.length > 0) || '';

      const rawImages = Array.isArray(afterData.images)
        ? afterData.images
        : [
          afterData.image,
          afterData.imageUrl,
          afterData.coverImage,
          afterData.custom_fields?.image
        ];
      const normalizedImages = Array.from(
        new Set(
          rawImages
            .map((value: unknown) => normalizeUrlCandidate(value))
            .filter((value: string) => value.length > 0)
        )
      );
      if (normalizedImages.length === 0 && coverThumbnailUrl) {
        normalizedImages.push(coverThumbnailUrl);
      }
      const imagesV2 = normalizedImages.map((url, index) => ({
        url,
        thumbUrl: index === 0 && coverThumbnailUrl ? coverThumbnailUrl : url
      }));

      // Payload purificado e idempotente
      const firestorePayload = {
        type: 'news',
        source: 'wordpress',
        module: 'news',
        externalId: newsId,
        externalSource: 'wordpress_plugin',
        postId: postIdNumber,
        publicId: normalizedPostId,
        
        titulo: afterData.titulo || 'Sin TÃ­tulo',
        descripcion: afterData.descripcion || '',
        images: normalizedImages,
        imagesV2,
        imgMiniatura: coverThumbnailUrl,
        
        userId: afterData.userId || 'wp_official',
        userName: afterData.userName || 'RedacciÃ³n CdeluAR',
        userProfilePicUrl: afterData.userProfilePicUrl || '',
        
        stats: {
          likesCount: afterData.stats?.likesCount || 0,
          commentsCount: afterData.stats?.commentsCount || 0,
          viewsCount: afterData.stats?.viewsCount || 0
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
      if (normalizedPostId) {
        const publicKey = buildContentPublicIdKey('news', normalizedPostId);
        await db
          .collection('_content_public_ids')
          .doc(publicKey)
          .set(
            {
              contentId: newsId,
              module: 'news',
              publicId: normalizedPostId,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            { merge: true }
          );
      }
      if (!normalizedPostId) {
        console.warn(`News ${newsId} synced without postId/publicId`);
      }
      console.log(`âœ… Noticia sincronizada en Firestore: ${newsId}`);

      return null;
    } catch (error) {
      console.error(`âŒ FallÃ³ la sincronizaciÃ³n de RTDB a Firestore para ${newsId}:`, error);
      return null;
    }
  });

// 6. Community image thumbnails
export const onCommunityPostImageFinalized = functions.storage
  .bucket(COMMUNITY_THUMBNAIL_BUCKET)
  .object()
  .onFinalize(async (object) => {
    const filePath = object.name;
    const contentType = object.contentType || '';
    const bucketName = object.bucket;
    const metadata = object.metadata || {};

    if (!filePath || !bucketName) return null;
    if (!filePath.startsWith('posts/')) return null;
    if (!contentType.startsWith('image/')) return null;
    if (filePath.includes('/thumbs/')) return null;
    if (metadata.generatedBy === 'community-thumbnail') return null;

    const ext = path.posix.extname(filePath).toLowerCase();
    const baseName = path.posix.basename(filePath, ext);
    if (baseName.endsWith('_t') || baseName.endsWith('-thumb')) return null;

    const directory = path.posix.dirname(filePath);
    const thumbPath = `${directory}/thumbs/${baseName}.webp`;
    const bucket = admin.storage().bucket(bucketName);
    const thumbFile = bucket.file(thumbPath);
    const [alreadyExists] = await thumbFile.exists();
    if (alreadyExists) return null;

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
    } catch (error) {
      console.error('Thumbnail generation failed', { filePath, error });
    } finally {
      await Promise.all([
        fs.unlink(sourceTempFile).catch(() => undefined),
        fs.unlink(thumbTempFile).catch(() => undefined)
      ]);
    }

    return null;
  });

// 7. Hosting FTP image upload fallback for community posts
export const uploadCommunityImageToHosting = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para subir imagenes.'
    );
  }

  const relativePathRaw = typeof data?.path === 'string' ? data.path.trim() : '';
  const contentType = ensureImageMime(data?.contentType);
  const base64Data = decodeBase64Payload(data?.base64Data);

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

  const ftpClient = new ftp.Client(30_000);
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
    await ftpClient.uploadFrom(Readable.from(base64Data), remoteFilePath);
  } catch (error) {
    console.error('FTP hosting upload failed', { userId, relativePath: targetRelativePath, error });
    throw new functions.https.HttpsError(
      'internal',
      'No se pudo subir la imagen al hosting.'
    );
  } finally {
    ftpClient.close();
  }

  return {
    url: publicUrl,
    path: targetRelativePath,
    sizeBytes: base64Data.length,
    contentType
  };
});

const listAllLotteryEntries = async (
  lotteryRef: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
): Promise<FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[]> => {
  const docs: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[] = [];
  let lastDocId: string | null = null;

  while (true) {
    let pageQuery = lotteryRef
      .collection('entries')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(LOTTERY_MIGRATION_PAGE_SIZE);

    if (lastDocId) {
      pageQuery = pageQuery.startAfter(lastDocId);
    }

    const pageSnap = await pageQuery.get();
    if (pageSnap.empty) break;

    docs.push(...pageSnap.docs);
    if (pageSnap.size < LOTTERY_MIGRATION_PAGE_SIZE) break;
    lastDocId = pageSnap.docs[pageSnap.docs.length - 1].id;
  }

  return docs;
};

const ensureLotteryEntriesSchemaV2 = async (lotteryId: string): Promise<void> => {
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
    const migrationStatus = migrationStatusRaw as LotteryMigrationStatus;

    const isAlreadyV2 = schemaVersion >= LOTTERY_ENTRY_SCHEMA_VERSION;
    if (isAlreadyV2 && migrationStatus !== 'failed') {
      const hasValidDefaults = lotteryData.maxNumber === maxNumber &&
        lotteryData.maxTicketsPerUser === maxTicketsPerUser &&
        migrationStatus === 'done';
      needsDefaultsPatch = !hasValidDefaults;
      return;
    }

    if (migrationStatus === 'running') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'migration-in-progress: La loteria esta migrando entradas, intenta nuevamente en unos segundos.'
      );
    }

    mustRunMigration = true;
    tx.set(
      lotteryRef,
      {
        migrationStatus: 'running',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });

  if (!mustRunMigration) {
    if (needsDefaultsPatch) {
      await lotteryRef.set(
        {
          maxNumber,
          maxTicketsPerUser,
          migrationStatus: 'done',
          entrySchemaVersion: LOTTERY_ENTRY_SCHEMA_VERSION,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }
    return;
  }

  try {
    const allEntries = await listAllLotteryEntries(lotteryRef);
    const usedNumbers = new Set<number>();
    const nextAvailableNumber = (() => {
      let cursor = 1;
      return (): number | null => {
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

    type PlannedEntry = {
      source: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>;
      selectedNumber: number;
      targetId: string;
    };

    const plannedEntries: PlannedEntry[] = [];
    const deferredEntries: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[] = [];

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
        throw new functions.https.HttpsError(
          'failed-precondition',
          'No hay suficientes numeros disponibles para migrar las entradas legacy. Aumenta maxNumber.'
        );
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
      if (writes === 0) return;
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

      const payload: Record<string, unknown> = {
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

    batch.set(
      lotteryRef,
      {
        maxNumber,
        maxTicketsPerUser,
        participantsCount: plannedEntries.length,
        entrySchemaVersion: LOTTERY_ENTRY_SCHEMA_VERSION,
        migrationStatus: 'done',
        migrationError: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    writes += 1;
    await flush();
  } catch (error: any) {
    await lotteryRef.set(
      {
        migrationStatus: 'failed',
        migrationError: typeof error?.message === 'string'
          ? error.message.slice(0, 300)
          : 'migration-failed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    throw error;
  }
};

// 8. Lottery entry callable (number-based entries, supports multiple tickets per user)
export const enterLottery = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para participar en la loteria.'
    );
  }

  const lotteryId = typeof data?.lotteryId === 'string' ? data.lotteryId.trim() : '';
  const selectedNumber = parseSelectedLotteryNumber(data?.selectedNumber);
  const idempotencyKeyRaw = typeof data?.idempotencyKey === 'string'
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
  const token = (context.auth?.token || {}) as Record<string, unknown>;

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
      throw new functions.https.HttpsError(
        'failed-precondition',
        'module-disabled: El modulo de loteria esta deshabilitado.'
      );
    }

    if (!lotterySnap.exists) {
      throw new functions.https.HttpsError('not-found', 'La loteria no existe.');
    }

    const lotteryData = lotterySnap.data() || {};
    if (lotteryData.deletedAt != null) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'lottery-inactive: La loteria ya no esta disponible.'
      );
    }

    const lotteryStatus = (lotteryData.status || 'draft') as LotteryStatus;
    if (lotteryStatus !== 'active') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'lottery-inactive: La loteria no esta activa.'
      );
    }

    if (lotteryData.winner) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'lottery-inactive: La loteria ya tiene ganador.'
      );
    }

    const nowMs = Date.now();
    const startsAt = lotteryData.startsAt instanceof admin.firestore.Timestamp
      ? lotteryData.startsAt.toMillis()
      : null;
    const endsAt = lotteryData.endsAt instanceof admin.firestore.Timestamp
      ? lotteryData.endsAt.toMillis()
      : null;

    if (startsAt != null && startsAt > nowMs) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'lottery-inactive: La loteria aun no inicio.'
      );
    }
    if (endsAt != null && endsAt < nowMs) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'lottery-inactive: La loteria ya finalizo la etapa de participacion.'
      );
    }

    const currentParticipantsRaw = Number(lotteryData.participantsCount || 0);
    const currentParticipants = Number.isFinite(currentParticipantsRaw)
      ? Math.max(0, Math.floor(currentParticipantsRaw))
      : 0;

    const maxNumber = normalizeLotteryMaxNumber(lotteryData.maxNumber);
    const maxTicketsPerUser = normalizeLotteryMaxTicketsPerUser(lotteryData.maxTicketsPerUser);
    if (selectedNumber < 1 || selectedNumber > maxNumber) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `out-of-range: Debes seleccionar un numero entre 1 y ${maxNumber}.`
      );
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
      throw new functions.https.HttpsError(
        'already-exists',
        'number-taken: El numero seleccionado ya esta ocupado.'
      );
    }

    if (userTicketsCount >= maxTicketsPerUser) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `limit-reached: Alcanzaste el maximo de ${maxTicketsPerUser} numeros para esta loteria.`
      );
    }

    const entryPayload: Record<string, unknown> = {
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
    tx.set(
      lotteryRef,
      {
        participantsCount: admin.firestore.FieldValue.increment(1),
        maxNumber,
        maxTicketsPerUser,
        entrySchemaVersion: LOTTERY_ENTRY_SCHEMA_VERSION,
        migrationStatus: 'done',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

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
export const drawLotteryWinner = functions.https.onCall(async (data, context) => {
  await assertStaffUser(context.auth);

  const lotteryId = typeof data?.lotteryId === 'string' ? data.lotteryId.trim() : '';
  if (!lotteryId) {
    throw new functions.https.HttpsError('invalid-argument', 'lotteryId es obligatorio.');
  }

  await ensureLotteryEntriesSchemaV2(lotteryId);

  const requesterUid = context.auth?.uid || 'system';
  const modulesConfigRef = db.collection('_config').doc('modules');
  const lotteryRef = db.collection('lotteries').doc(lotteryId);

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, lotterySnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(lotteryRef)
    ]);

    if (!isLotteryModuleEnabled(modulesConfigSnap.data())) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El modulo de loteria esta deshabilitado.'
      );
    }

    if (!lotterySnap.exists) {
      throw new functions.https.HttpsError('not-found', 'La loteria no existe.');
    }

    const lotteryData = lotterySnap.data() || {};
    if (lotteryData.deletedAt != null) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'La loteria ya no esta disponible.'
      );
    }

    if (lotteryData.winner) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'La loteria ya tiene ganador.'
      );
    }

    const lotteryStatus = (lotteryData.status || 'draft') as LotteryStatus;
    if (lotteryStatus !== 'closed') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'La loteria debe estar cerrada antes de sortear ganador.'
      );
    }

    const entriesQuery = lotteryRef
      .collection('entries')
      .orderBy('selectedNumber', 'asc')
      .limit(MAX_LOTTERY_DRAW_ENTRIES);
    const entriesSnap = await tx.get(entriesQuery);

    if (entriesSnap.empty) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'No hay participantes para sortear.'
      );
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

    tx.set(
      lotteryRef,
      {
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
      },
      { merge: true }
    );

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
export const submitSurveyVote = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para votar.'
    );
  }

  const surveyId = typeof data?.surveyId === 'string' ? data.surveyId.trim() : '';
  const optionIds = normalizeOptionIds(data?.optionIds);
  const idempotencyKeyRaw = typeof data?.idempotencyKey === 'string'
    ? data.idempotencyKey.trim()
    : '';
  const idempotencyKey = idempotencyKeyRaw ? idempotencyKeyRaw.slice(0, 120) : null;

  if (!surveyId) {
    throw new functions.https.HttpsError('invalid-argument', 'surveyId es obligatorio.');
  }
  if (optionIds.length === 0) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Debes seleccionar al menos una opcion.'
    );
  }
  if (optionIds.length > MAX_SURVEY_OPTIONS_SELECTED) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Cantidad de opciones seleccionadas invalida.'
    );
  }

  const surveyRef = db.collection('surveys').doc(surveyId);
  const voteRef = db.collection('survey_votes').doc(`${surveyId}_${userId}`);
  const modulesConfigRef = db.collection('_config').doc('modules');

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, surveySnap, existingVoteSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(surveyRef),
      tx.get(voteRef)
    ]);

    const surveysEnabled = Boolean(modulesConfigSnap.data()?.surveys?.enabled ?? true);
    if (!surveysEnabled) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El modulo de encuestas esta deshabilitado.'
      );
    }

    if (!surveySnap.exists) {
      throw new functions.https.HttpsError('not-found', 'La encuesta no existe.');
    }

    const surveyData = surveySnap.data() || {};
    const surveyStatus = (surveyData.status || 'inactive') as SurveyStatus;
    if (surveyStatus !== 'active') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'La encuesta no esta activa.'
      );
    }
    if (isExpired(surveyData.expiresAt)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'La encuesta ya expiro.'
      );
    }

    const isMultipleChoice = Boolean(surveyData.isMultipleChoice);
    const maxVotesRaw = Number(surveyData.maxVotesPerUser ?? 1);
    const maxVotesPerUser = Number.isFinite(maxVotesRaw)
      ? (isMultipleChoice ? Math.max(2, Math.floor(maxVotesRaw)) : 1)
      : (isMultipleChoice ? 2 : 1);

    if (!isMultipleChoice && optionIds.length !== 1) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Esta encuesta permite solo una opcion.'
      );
    }
    if (optionIds.length > maxVotesPerUser) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Superaste el maximo de opciones permitidas.'
      );
    }

    const surveyOptions = normalizeSurveyOptions(surveyData.options);
    if (surveyOptions.length < 2) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'La encuesta no tiene opciones validas para votar.'
      );
    }

    const availableOptionIds = new Set<string>();
    for (const option of surveyOptions) {
      if (option.active) {
        availableOptionIds.add(option.id);
      }
    }

    for (const selectedOptionId of optionIds) {
      if (!availableOptionIds.has(selectedOptionId)) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'Seleccionaste una opcion invalida.'
        );
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

    const optionSelectionCounts = new Map<string, number>();
    for (const optionId of optionIds) {
      const previousCount = optionSelectionCounts.get(optionId) || 0;
      optionSelectionCounts.set(optionId, previousCount + 1);
    }

    const nextOptions = surveyOptions.map((option) => {
      const incrementBy = optionSelectionCounts.get(option.id) || 0;
      if (incrementBy <= 0) return option;

      return {
        ...option,
        voteCount: option.voteCount + incrementBy
      };
    });

    const votePayload: Record<string, unknown> = {
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
export const completeExpiredSurveys = functions.pubsub
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

      if (snapshot.empty) break;

      const batch = db.batch();
      for (const surveyDoc of snapshot.docs) {
        batch.update(surveyDoc.ref, {
          status: 'completed',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      await batch.commit();
      completedCount += snapshot.size;

      if (snapshot.size < SURVEY_COMPLETE_BATCH_SIZE) break;
    }

    console.log(`Expired surveys completed: ${completedCount}`);
    return null;
  });

export const purgeOldNotifications = functions.pubsub
  .schedule('every day 03:00')
  .timeZone('Etc/UTC')
  .onRun(async () => {
    const cutoffDate = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const cutoffTs = admin.firestore.Timestamp.fromDate(cutoffDate);
    let removedCount = 0;

    while (true) {
      const snapshot = await db.collectionGroup('notifications')
        .where('lastEventAt', '<=', cutoffTs)
        .limit(NOTIFICATION_PAGE_SIZE)
        .get();
      if (snapshot.empty) break;

      const batch = db.batch();
      for (const notificationDoc of snapshot.docs) {
        batch.delete(notificationDoc.ref);
      }
      await batch.commit();
      removedCount += snapshot.size;

      if (snapshot.size < NOTIFICATION_PAGE_SIZE) break;
    }

    console.log(`Old notifications removed: ${removedCount}`);
    return null;
  });

// 12. Ads metrics aggregation
export const onAdEventCreated = functions.firestore
  .document('ad_events/{eventId}')
  .onCreate(async (snap) => {
    const eventData = snap.data();
    if (!eventData) return null;

    const adId = eventData.adId as string | undefined;
    const eventType = eventData.eventType as 'impression' | 'click' | undefined;
    const countRaw = Number(eventData.count ?? 1);
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

        tx.set(
          adRef,
          {
            stats: {
              impressionsTotal: admin.firestore.FieldValue.increment(impressionIncrement),
              clicksTotal: admin.firestore.FieldValue.increment(clickIncrement),
              ctr,
              lastEventAt: admin.firestore.FieldValue.serverTimestamp()
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      });

      return null;
    } catch (error) {
      console.error(`Failed to aggregate ad event for ad ${adId}`, error);
      return null;
    }
  });

