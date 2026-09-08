import * as crypto from 'crypto';
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import {
  mapPublicCategory,
  mapPublicEvent,
  mapPublicNews,
  mapPublicNewsSummary,
  mapPublicSearchResult
} from './mappers';
import type { PublicEvent, PublicNews, PublicSearchResult, PublicSnapshotLike } from './types';

const getDb = (): FirebaseFirestore.Firestore => admin.firestore();
const API_VERSION = 'v1';
const MAX_LIMIT = 100;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const MAX_QUERY_SCAN = 100;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_ORIGIN = 'https://cdelu.ar';
const MAX_RESPONSE_BYTES = 900_000;
const CACHE_TTL_SECONDS = { list: 30, detail: 60, categories: 120, search: 15 } as const;
const PUBLIC_CONTENT_FIELDS = [
  'module', 'type', 'source', 'isOficial', 'deletedAt', 'visibility', 'status', 'moderation',
  'titulo', 'descripcion', 'publishedAt', 'createdAt', 'updatedAt', 'slug', 'category',
  'images', 'imagesV2', 'imgMiniatura', 'publicId', 'postId'
];
const PUBLIC_EVENT_FIELDS = [
  'module', 'type', 'source', 'deletedAt', 'visibility', 'status', 'name', 'titulo',
  'summary', 'descripcion', 'canonicalUrl', 'slug', 'startAt', 'start_at', 'endAt',
  'end_at', 'publishedAt', 'updatedAt', 'originalUrl', 'sourceUrl', 'venue'
];

type RateBucket = { startedAt: number; count: number };
type CacheEntry<T> = { expiresAt: number; value: T };
type RequestLike = {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  ip?: string;
  cacheHit?: boolean;
  firestoreReads?: number;
  get(name: string): string | undefined;
};
type ResponseLike = {
  status(code: number): ResponseLike;
  setHeader(name: string, value: string): ResponseLike;
  json(body: unknown): ResponseLike;
  end(): void;
  statusCode?: number;
  responseBytes?: number;
};

const rateBuckets = new Map<string, RateBucket>();
const responseCache = new Map<string, CacheEntry<unknown>>();

const getString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const getRequestId = (req: RequestLike): string => {
  const supplied = getString(req.get('x-request-id'));
  if (/^[a-zA-Z0-9._:-]{8,80}$/.test(supplied)) return supplied;
  return `req_${crypto.randomUUID()}`;
};

const getClientIp = (req: RequestLike): string => {
  const forwarded = getString(req.get('x-forwarded-for')).split(',')[0].trim();
  return forwarded || getString(req.ip) || 'unknown';
};

const allowedOrigins = (): Set<string> => new Set(
  (process.env.PUBLIC_API_ALLOWED_ORIGINS || DEFAULT_ORIGIN)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

const applyCors = (req: RequestLike, res: ResponseLike): void => {
  const origin = getString(req.get('origin'));
  if (origin && allowedOrigins().has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id');
  res.setHeader('Access-Control-Max-Age', '600');
};

const cacheKey = (prefix: string, value: unknown): string =>
  `${prefix}:${JSON.stringify(value, Object.keys(value as object).sort())}`;

const getCached = <T>(key: string, req: RequestLike): T | null => {
  const entry = responseCache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return null;
  }
  req.cacheHit = true;
  return entry.value;
};

const setCached = <T>(key: string, value: T, ttlSeconds: number): void => {
  if (responseCache.size > 500) {
    for (const [entryKey, entry] of responseCache) {
      if (entry.expiresAt <= Date.now()) responseCache.delete(entryKey);
    }
  }
  responseCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
};

const sendJson = (
  req: RequestLike,
  res: ResponseLike,
  status: number,
  body: unknown,
  options: { cacheSeconds?: number; etagSource?: unknown } = {}
): ResponseLike => {
  const serialized = JSON.stringify(body);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  res.responseBytes = bytes;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Response-Bytes', String(bytes));
  res.setHeader('X-Cache', req.cacheHit ? 'HIT' : 'MISS');
  if (bytes > MAX_RESPONSE_BYTES) {
    return res.status(413).json({
      error: {
        code: 'RESPONSE_TOO_LARGE',
        message: 'La respuesta supera el límite permitido.',
        request_id: getRequestId(req),
        details: []
      }
    });
  }
  const etag = `W/\"${crypto.createHash('sha256').update(JSON.stringify(options.etagSource ?? body)).digest('hex')}\"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', options.cacheSeconds ? `public, max-age=${options.cacheSeconds}` : 'no-store');
  if (req.get('if-none-match') === etag) {
    res.status(304).end();
    return res;
  }
  return res.status(status).json(body);
};

const errorResponse = (
  res: ResponseLike,
  status: number,
  code: string,
  message: string,
  requestId: string,
  details: Array<{ field: string; reason: string }> = []
): ResponseLike => res.status(status).json({
  error: { code, message, request_id: requestId, details }
});

const successMeta = (requestId: string): Record<string, string> => ({
  request_id: requestId,
  generated_at: new Date().toISOString(),
  api_version: API_VERSION
});

const collectionResponse = <T>(
  req: RequestLike,
  res: ResponseLike,
  data: T[],
  requestId: string,
  limit: number,
  nextCursor: string | null,
  hasNext: boolean
): ResponseLike => {
  const pagination = { limit, next_cursor: nextCursor, has_next: hasNext };
  return sendJson(req, res, 200, { data, pagination, meta: successMeta(requestId) }, {
    cacheSeconds: CACHE_TTL_SECONDS.list,
    etagSource: { data, pagination }
  });
};

const detailResponse = <T>(req: RequestLike, res: ResponseLike, data: T, requestId: string): ResponseLike =>
  sendJson(req, res, 200, { data, meta: successMeta(requestId) }, {
    cacheSeconds: CACHE_TTL_SECONDS.detail,
    etagSource: data
  });

const parseLimit = (value: unknown, max = MAX_LIMIT): { value?: number; error?: string } => {
  const raw = value === undefined ? String(DEFAULT_LIMIT) : getString(value);
  if (!/^\d+$/.test(raw)) return { error: `El parámetro limit debe ser un entero entre 1 y ${max}.` };
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    return { error: `El parámetro limit debe estar entre 1 y ${max}.` };
  }
  return { value: parsed };
};

const parseDate = (value: unknown, field: string): { value?: admin.firestore.Timestamp; error?: string } => {
  const raw = getString(value);
  if (!raw) return {};
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return { error: `${field} debe ser una fecha ISO 8601 válida.` };
  return { value: admin.firestore.Timestamp.fromDate(date) };
};

const encodeCursor = (value: admin.firestore.Timestamp): string =>
  Buffer.from(JSON.stringify({ created_at_ms: value.toMillis() }), 'utf8').toString('base64url');

const decodeCursor = (value: unknown): admin.firestore.Timestamp | null => {
  const raw = getString(value);
  if (!raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { created_at_ms?: unknown };
    if (typeof decoded.created_at_ms !== 'number' || !Number.isFinite(decoded.created_at_ms)) return null;
    return admin.firestore.Timestamp.fromMillis(decoded.created_at_ms);
  } catch {
    return null;
  }
};

const parseCsv = (value: unknown): string[] => getString(value)
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const validateQueryKeys = (
  query: RequestLike['query'],
  allowed: Set<string>
): string | null => {
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) return key;
  }
  return null;
};

const getPathParts = (req: RequestLike): string[] => req.path.split('/').filter(Boolean);

const publicSnapshot = (snapshot: FirebaseFirestore.DocumentSnapshot): PublicSnapshotLike => ({
  id: snapshot.id,
  data: () => snapshot.data()
});

const newsQuery = (query: RequestLike['query']): FirebaseFirestore.Query => {
  let result: FirebaseFirestore.Query = getDb().collection('content')
    .where('deletedAt', '==', null)
    .where('module', '==', 'news')
    .orderBy('createdAt', 'desc')
    .select(...PUBLIC_CONTENT_FIELDS);

  const from = parseDate(query.from, 'from').value;
  const until = parseDate(query.until, 'until').value;
  if (from) result = result.where('createdAt', '>=', from);
  if (until) result = result.where('createdAt', '<=', until);
  const cursor = decodeCursor(query.cursor);
  if (cursor) result = result.startAfter(cursor);
  return result;
};

const eventQuery = (query: RequestLike['query']): FirebaseFirestore.Query => {
  let result: FirebaseFirestore.Query = getDb().collection('content')
    .where('deletedAt', '==', null)
    .where('module', '==', 'events')
    .orderBy('createdAt', 'desc')
    .select(...PUBLIC_EVENT_FIELDS);
  const cursor = decodeCursor(query.cursor);
  if (cursor) result = result.startAfter(cursor);
  return result;
};

type NewsReadResult = {
  items: Array<PublicNews | Omit<PublicNews, 'content'>>;
  nextCursor: string | null;
  hasNext: boolean;
};

const readNews = async (
  query: RequestLike['query'],
  requestedLimit: number,
  includeContent: boolean,
  req?: RequestLike
): Promise<NewsReadResult> => {
  const key = cacheKey(`news-read:${includeContent}:${requestedLimit}`, query);
  const cached = req ? getCached<NewsReadResult>(key, req) : null;
  if (cached) return cached;
  const snapshot = await newsQuery(query).limit(Math.min(requestedLimit + 1, MAX_QUERY_SCAN)).get();
  if (req) req.firestoreReads = (req.firestoreReads || 0) + snapshot.docs.length;
  const mapped = snapshot.docs
    .map((doc) => includeContent ? mapPublicNews(publicSnapshot(doc)) : mapPublicNewsSummary(publicSnapshot(doc)))
    .filter((item): item is PublicNews | Omit<PublicNews, 'content'> => item !== null);
  const items = mapped.slice(0, requestedLimit);
  const hasNext = snapshot.docs.length > requestedLimit;
  const lastDoc = snapshot.docs[Math.min(requestedLimit, snapshot.docs.length) - 1];
  const result = {
    items,
    hasNext,
    nextCursor: hasNext && lastDoc ? encodeCursor(lastDoc.get('createdAt') as admin.firestore.Timestamp) : null
  };
  if (req) setCached(key, result, CACHE_TTL_SECONDS.list);
  return result;
};

const resolveNewsSnapshot = async (id: string): Promise<FirebaseFirestore.DocumentSnapshot | null> => {
  const direct = await getDb().collection('content').doc(id).get();
  if (direct.exists) return direct;

  const publicRef = await getDb().collection('_content_public_ids').doc(`news__${id}`).get();
  const mappedId = publicRef.exists ? getString(publicRef.get('contentId')) : '';
  if (mappedId) {
    const resolved = await getDb().collection('content').doc(mappedId).get();
    if (resolved.exists) return resolved;
  }

  const slugRef = await getDb().collection('_content_slugs').doc(`news__${id}`).get();
  const slugMappedId = slugRef.exists ? getString(slugRef.get('contentId')) : '';
  if (!slugMappedId) return null;
  const resolved = await getDb().collection('content').doc(slugMappedId).get();
  return resolved.exists ? resolved : null;
};

const matchesNewsFilters = (item: Omit<PublicNews, 'content'>, query: RequestLike['query']): boolean => {
  const category = getString(query.category).toLowerCase();
  if (category && item.category?.id !== category && item.category?.name.toLowerCase() !== category) return false;
  return true;
};

const publicNewsList = async (req: RequestLike, res: ResponseLike, requestId: string): Promise<ResponseLike> => {
  const unsupportedKey = validateQueryKeys(req.query, new Set(['limit', 'cursor', 'category', 'from', 'until']));
  if (unsupportedKey) return errorResponse(res, 400, 'INVALID_PARAMETER', `El filtro ${unsupportedKey} no está disponible en esta versión.`, requestId, [{ field: unsupportedKey, reason: 'unsupported_filter' }]);
  const parsedLimit = parseLimit(req.query.limit);
  if (parsedLimit.error) return errorResponse(res, 400, 'INVALID_PARAMETER', parsedLimit.error, requestId, [{ field: 'limit', reason: 'out_of_range' }]);
  const dates = [parseDate(req.query.from, 'from'), parseDate(req.query.until, 'until')];
  const dateError = dates.find((item) => item.error);
  if (dateError?.error) return errorResponse(res, 400, 'INVALID_PARAMETER', dateError.error, requestId);
  const result = await readNews(req.query, parsedLimit.value || DEFAULT_LIMIT, false, req);
  const filtered = result.items.filter((item): item is Omit<PublicNews, 'content'> => matchesNewsFilters(item, req.query));
  return collectionResponse(req, res, filtered, requestId, parsedLimit.value || DEFAULT_LIMIT, result.nextCursor, result.hasNext);
};

const publicNewsDetail = async (id: string, req: RequestLike, res: ResponseLike, requestId: string): Promise<ResponseLike> => {
  const snapshot = await resolveNewsSnapshot(id);
  const item = snapshot ? mapPublicNews(publicSnapshot(snapshot)) : null;
  if (!item) return errorResponse(res, 404, 'NOT_FOUND', 'La noticia no existe o no es pública.', requestId);
  return detailResponse(req, res, item, requestId);
};

const publicEventsList = async (req: RequestLike, res: ResponseLike, requestId: string): Promise<ResponseLike> => {
  const unsupportedKey = validateQueryKeys(req.query, new Set(['limit', 'cursor']));
  if (unsupportedKey) return errorResponse(res, 400, 'INVALID_PARAMETER', `El filtro ${unsupportedKey} no está disponible en esta versión.`, requestId, [{ field: unsupportedKey, reason: 'unsupported_filter' }]);
  const parsedLimit = parseLimit(req.query.limit);
  if (parsedLimit.error) return errorResponse(res, 400, 'INVALID_PARAMETER', parsedLimit.error, requestId);
  const limit = parsedLimit.value || DEFAULT_LIMIT;
  const snapshot = await eventQuery(req.query).limit(limit + 1).get();
  req.firestoreReads = (req.firestoreReads || 0) + snapshot.docs.length;
  const items = snapshot.docs.map((doc) => mapPublicEvent(publicSnapshot(doc))).filter((item): item is PublicEvent => item !== null).slice(0, limit);
  const hasNext = snapshot.docs.length > limit;
  const lastDoc = snapshot.docs[Math.min(limit, snapshot.docs.length) - 1];
  const nextCursor = hasNext && lastDoc ? encodeCursor(lastDoc.get('createdAt') as admin.firestore.Timestamp) : null;
  return collectionResponse(req, res, items, requestId, limit, nextCursor, hasNext);
};

const publicEventDetail = async (id: string, req: RequestLike, res: ResponseLike, requestId: string): Promise<ResponseLike> => {
  const snapshot = await getDb().collection('content').doc(id).get();
  req.firestoreReads = (req.firestoreReads || 0) + 1;
  const item = snapshot.exists ? mapPublicEvent(publicSnapshot(snapshot)) : null;
  if (!item) return errorResponse(res, 404, 'NOT_FOUND', 'El evento no existe o no es público.', requestId);
  return detailResponse(req, res, item, requestId);
};

const publicCategories = async (req: RequestLike, res: ResponseLike, requestId: string): Promise<ResponseLike> => {
  const unsupportedKey = validateQueryKeys(req.query, new Set([]));
  if (unsupportedKey) return errorResponse(res, 400, 'INVALID_PARAMETER', `El parámetro ${unsupportedKey} no está disponible en esta versión.`, requestId, [{ field: unsupportedKey, reason: 'unsupported_parameter' }]);
  const snapshot = await newsQuery(req.query).limit(MAX_QUERY_SCAN).get();
  req.firestoreReads = (req.firestoreReads || 0) + snapshot.docs.length;
  const categories = new Map<string, ReturnType<typeof mapPublicCategory>>();
  for (const doc of snapshot.docs) {
    const item = mapPublicNewsSummary(publicSnapshot(doc));
    if (!item?.category) continue;
    categories.set(item.category.id, item.category);
  }
  return collectionResponse(req, res, Array.from(categories.values()).filter((item): item is NonNullable<typeof item> => item !== null), requestId, categories.size, null, false);
};

const publicSearch = async (req: RequestLike, res: ResponseLike, requestId: string): Promise<ResponseLike> => {
  const unsupportedKey = validateQueryKeys(req.query, new Set(['q', 'types', 'limit', 'cursor', 'category', 'from', 'until']));
  if (unsupportedKey) return errorResponse(res, 400, 'INVALID_PARAMETER', `El filtro ${unsupportedKey} no está disponible en esta versión.`, requestId, [{ field: unsupportedKey, reason: 'unsupported_filter' }]);
  const q = getString(req.query.q).toLowerCase();
  if (q.length < 2 || q.length > 120) return errorResponse(res, 400, 'INVALID_PARAMETER', 'El parámetro q debe tener entre 2 y 120 caracteres.', requestId, [{ field: 'q', reason: 'invalid_length' }]);
  const parsedLimit = parseLimit(req.query.limit, MAX_SEARCH_LIMIT);
  if (parsedLimit.error) return errorResponse(res, 400, 'INVALID_PARAMETER', parsedLimit.error, requestId);
  const types = parseCsv(req.query.types);
  if (types.some((type) => type !== 'news' && type !== 'event')) return errorResponse(res, 400, 'INVALID_PARAMETER', 'types solo admite news,event.', requestId, [{ field: 'types', reason: 'unsupported_value' }]);
  const dates = [parseDate(req.query.from, 'from'), parseDate(req.query.until, 'until')];
  const dateError = dates.find((item) => item.error);
  if (dateError?.error) return errorResponse(res, 400, 'INVALID_PARAMETER', dateError.error, requestId);
  if (types.includes('event') && !types.includes('news')) {
    return collectionResponse(req, res, [], requestId, parsedLimit.value || DEFAULT_LIMIT, null, false);
  }

  const scan = await readNews(req.query, Math.min(MAX_QUERY_SCAN, Math.max(parsedLimit.value || DEFAULT_LIMIT, 20)), true, req);
  const results: PublicSearchResult[] = [];
  for (const item of scan.items) {
    if (item.type !== 'news' || !('content' in item)) continue;
    const fields = [item.title.toLowerCase(), item.summary.toLowerCase(), item.content.toLowerCase()];
    const matches = fields
      .map((field, index) => field.includes(q) ? (index === 0 ? 'title' : index === 1 ? 'summary' : 'content') : null)
      .filter((field): field is 'title' | 'summary' | 'content' => field !== null);
    if (matches.length === 0) continue;
    results.push(mapPublicSearchResult(item, matches.includes('title') ? 1 : 0.5, { kind: 'lexical', fields: matches }));
    if (results.length >= (parsedLimit.value || DEFAULT_LIMIT)) break;
  }
  return collectionResponse(req, res, results, requestId, parsedLimit.value || DEFAULT_LIMIT, scan.nextCursor, scan.hasNext);
};

const health = (req: RequestLike, res: ResponseLike, requestId: string): ResponseLike => detailResponse(req, res, {
  status: 'ok',
  service: 'cdelu-public-api',
  version: API_VERSION
}, requestId);

const checkRateLimit = (req: RequestLike, route: string): boolean => {
  const key = `${getClientIp(req)}:${route}`;
  const now = Date.now();
  const existing = rateBuckets.get(key);
  const max = route === 'search' ? 30 : route === 'detail' ? 120 : 60;
  if (rateBuckets.size > 10_000) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (now - bucket.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(bucketKey);
    }
  }
  if (!existing || now - existing.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (existing.count >= max) return false;
  existing.count += 1;
  return true;
};

export const publicApi = functions.https.onRequest(async (req, res) => {
  const typedReq = req as unknown as RequestLike;
  const typedRes = res as unknown as ResponseLike;
  const requestId = getRequestId(typedReq);
  const startedAt = Date.now();
  applyCors(typedReq, typedRes);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    errorResponse(typedRes, 405, 'METHOD_NOT_ALLOWED', 'Solo se admite GET.', requestId);
    return;
  }

  const parts = getPathParts(typedReq);
  const route = parts.includes('search') ? 'search' : parts.length >= 4 ? 'detail' : 'list';
  if (!checkRateLimit(typedReq, route)) {
    typedRes.setHeader('Retry-After', '60');
    errorResponse(typedRes, 429, 'RATE_LIMITED', 'Se alcanzó el límite temporal de solicitudes.', requestId);
    return;
  }

  try {
    if (parts.length === 3 && parts[0] === 'api' && parts[1] === API_VERSION && parts[2] === 'health') {
      health(typedReq, typedRes, requestId);
      return;
    }
    if (parts.length >= 3 && parts[0] === 'api' && parts[1] === API_VERSION && parts[2] === 'news') {
      if (parts.length === 4) {
        await publicNewsDetail(decodeURIComponent(parts[3]), typedReq, typedRes, requestId);
        return;
      }
      await publicNewsList(typedReq, typedRes, requestId);
      return;
    }
    if (parts.length >= 3 && parts[0] === 'api' && parts[1] === API_VERSION && parts[2] === 'events') {
      if (parts.length === 4) {
        await publicEventDetail(decodeURIComponent(parts[3]), typedReq, typedRes, requestId);
        return;
      }
      await publicEventsList(typedReq, typedRes, requestId);
      return;
    }
    if (parts.length === 3 && parts[0] === 'api' && parts[1] === API_VERSION && parts[2] === 'categories') {
      await publicCategories(typedReq, typedRes, requestId);
      return;
    }
    if (parts.length === 3 && parts[0] === 'api' && parts[1] === API_VERSION && parts[2] === 'search') {
      await publicSearch(typedReq, typedRes, requestId);
      return;
    }
    errorResponse(typedRes, 404, 'NOT_FOUND', 'La ruta no existe.', requestId);
  } catch (error) {
    console.error('[public-api] request failed', { requestId, error });
    errorResponse(typedRes, 500, 'INTERNAL_ERROR', 'No se pudo completar la solicitud.', requestId);
  } finally {
    console.log('[public-api-metrics]', JSON.stringify({
      request_id: requestId,
      method: req.method,
      path: req.path,
      status: typedRes.statusCode || 500,
      latency_ms: Date.now() - startedAt,
      firestore_reads: typedReq.firestoreReads || 0,
      cache_hit: typedReq.cacheHit === true,
      response_bytes: typedRes.responseBytes || 0
    }));
  }
});
