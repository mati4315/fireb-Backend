import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import * as crypto from 'crypto';

const db = admin.firestore();

export const SECRET_TEXT_MIN_LENGTH = 12;
export const SECRET_TEXT_MAX_LENGTH = 280;
export const SECRET_TEXT_MAX_ABSOLUTE = 500;
export const SECRET_NUMERIC_ID_START = 8301641;
export const SECRET_COMMENT_MIN_LENGTH = 2;
export const SECRET_COMMENT_MAX_LENGTH = 300;
export const SECRET_ZONE_MAX_LENGTH = 48;
export const SECRET_REPORT_REASON_MAX_LENGTH = 140;
export const SECRET_DAILY_LIMIT = 5;
export const SECRET_FINGERPRINT_TTL_MS = 72 * 60 * 60 * 1000;
export const SECRET_AUTO_HIDE_REPORT_THRESHOLD = 6;
export const SECRET_RANKINGS_SAMPLE_LIMIT = 450;
export const SECRET_RANKINGS_LIST_LIMIT = 12;

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

const clampInteger = (value: unknown, min: number, max: number, fallback: number): number => {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const parsed = Math.floor(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const sanitizeBoundedString = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
};

export const hasMeaningfulSecretText = (value: string): boolean =>
  /[0-9A-Za-z\u00C0-\u024F]/.test(value);

export const sanitizeSecretText = (value: unknown, maxLength: number): string => {
  const asString = typeof value === 'string' ? value : '';
  return collapseWhitespace(asString).slice(0, maxLength);
};

export const normalizeSecretCategory = (value: unknown): string | null => {
  const normalized = sanitizeBoundedString(value, 40).toLowerCase();
  if (!normalized) return null;
  return SECRET_CATEGORY_VALUES.has(normalized) ? normalized : null;
};

export const normalizeSecretSex = (value: unknown): 'no_responder' | 'hombre' | 'mujer' => {
  const normalized = sanitizeBoundedString(value, 20).toLowerCase();
  if (SECRET_SEX_VALUES.has(normalized)) {
    return normalized as 'no_responder' | 'hombre' | 'mujer';
  }
  return 'no_responder';
};

export const normalizeSecretZone = (value: unknown): string | null => {
  const sanitized = sanitizeSecretText(value, SECRET_ZONE_MAX_LENGTH);
  return sanitized || null;
};

export const normalizeSecretAge = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  if (normalized < 13 || normalized > 99) return null;
  return normalized;
};

export const normalizeSecretReportReason = (value: unknown): string => {
  const reason = sanitizeSecretText(value, SECRET_REPORT_REASON_MAX_LENGTH);
  return reason || 'contenido_inapropiado';
};

export const normalizeSecretClientAnonId = (value: unknown): string => {
  const raw = sanitizeBoundedString(value, 120);
  return raw.replace(/[^a-zA-Z0-9_-]/g, '');
};

export const timestampToMillisOrZero = (value: unknown): number => {
  if (value instanceof admin.firestore.Timestamp) return value.toMillis();
  return 0;
};

export const buildSecretFingerprintHash = (
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

export const createSecretAlias = (fingerprintHash: string, scope: string): string => {
  const aliasSeed = crypto
    .createHash('sha1')
    .update(`${fingerprintHash}|${scope}`)
    .digest('hex')
    .slice(0, 8);
  const numeric = Number.parseInt(aliasSeed, 16) % 10000;
  return `Anon${String(numeric).padStart(4, '0')}`;
};

export type SecretTrend = 'up' | 'down' | 'stable';

export type SecretRankResult = {
  score: number;
  hotScore: number;
  controversyScore: number;
  trend: SecretTrend;
};

export type SecretRuntimeSettings = {
  minTextLength: number;
  maxTextLength: number;
  createCooldownMs: number;
  commentCooldownMs: number;
  dailyLimit: number;
  autoHideReportsThreshold: number;
};

export const resolveSecretRuntimeSettings = (
  data: FirebaseFirestore.DocumentData | undefined,
  fallbackTextLength = SECRET_TEXT_MAX_LENGTH,
  fallbackDailyLimit = SECRET_DAILY_LIMIT,
  fallbackAutoHide = SECRET_AUTO_HIDE_REPORT_THRESHOLD
): SecretRuntimeSettings => {
  const maxTextLength = clampInteger(data?.maxTextLength, 120, 500, fallbackTextLength);
  const minTextLengthRaw = clampInteger(data?.minTextLength, 1, 80, SECRET_TEXT_MIN_LENGTH);
  const minTextLength = Math.min(minTextLengthRaw, maxTextLength);

  const createCooldownMinutes = clampInteger(data?.createCooldownMinutes, 1, 240, 30);
  const commentCooldownSeconds = clampInteger(data?.commentCooldownSeconds, 1, 300, 20);
  const dailyLimit = clampInteger(data?.dailyLimit, 1, 30, fallbackDailyLimit);
  const autoHideReportsThreshold = clampInteger(
    data?.autoHideReportsThreshold,
    1,
    100,
    fallbackAutoHide
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

export type SecretRankingItem = {
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

export const computeSecretRank = (
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

export const isSecretActiveForRanking = (data: FirebaseFirestore.DocumentData): boolean => {
  if (data?.module !== 'secrets') return false;
  if (data?.deletedAt != null) return false;
  const moderationStatus = sanitizeBoundedString(data?.moderation?.status, 40) || 'active';
  return moderationStatus === 'active';
};

export const toSecretRankingItem = (
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

export const takeUniqueSecretRankingItems = (
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

export const buildSecretRankingsSnapshot = (
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

export const refreshSecretRankingsInternal = async (): Promise<Record<string, unknown>> => {
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
