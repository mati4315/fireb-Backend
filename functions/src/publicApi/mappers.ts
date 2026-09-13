import {
  isPublicNewsRecord,
  isStructuredPublicEvent,
  PUBLIC_PUBLISHER,
  PUBLIC_TIMEZONE,
  sourceToPublicOrigin
} from './policy';
import type {
  PublicCategory,
  PublicEvent,
  PublicImage,
  PublicNews,
  PublicProvenance,
  PublicSearchMatch,
  PublicSearchResult,
  PublicSnapshotLike
} from './types';

type UnknownRecord = Record<string, unknown>;

const MAX_SLUG_LENGTH = 96;
const MAX_SUMMARY_LENGTH = 500;
const MAX_CONTENT_LENGTH = 120_000;
const MAX_IMAGES = 12;
const INVALID_WORDPRESS_THUMBNAILS = new Set([
  'https://arribanoticias.com.ar/wp-content/uploads/2025/04/logo-arriba-300x201.png',
  'https://www.elmiercolesdigital.com.ar/wp-content/uploads/2015/04/galeano-300x275.jpg'
]);

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});

const asString = (value: unknown, maxLength = 2400): string =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

const asNullableString = (value: unknown, maxLength = 2400): string | null => {
  const normalized = asString(value, maxLength);
  return normalized || null;
};

const isInvalidWordpressThumbnail = (value: string): boolean =>
  INVALID_WORDPRESS_THUMBNAILS.has(value.split(/[?#]/, 1)[0].replace(/\\/g, '/').toLowerCase());

const decodeBasicEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

export const cleanPublicText = (value: unknown, maxLength = MAX_CONTENT_LENGTH): string => {
  const raw = asString(value, maxLength * 2);
  const withoutDangerousBlocks = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decodeBasicEntities(withoutDangerousBlocks).replace(/\s+/g, ' ').trim().slice(0, maxLength);
};

const normalizeSlug = (value: unknown, fallback: string): string => {
  const base = asString(value, MAX_SLUG_LENGTH) || fallback;
  const normalized = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return (normalized.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '') || 'contenido');
};

const toIso = (value: unknown): string | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (isRecord(value) && typeof value.toDate === 'function') {
    const dateValue = value.toDate();
    if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) return dateValue.toISOString();
  }
  if (isRecord(value) && typeof value._seconds === 'number') {
    const date = new Date(value._seconds * 1000 + Number(value._nanoseconds || 0) / 1_000_000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
};

const asHttpUrl = (value: unknown): string => {
  const candidate = asString(value);
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
};

const normalizePublicRef = (value: unknown): string => {
  const candidates: unknown[] = [value];
  while (candidates.length > 0) {
    const candidate = candidates.shift();
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return String(Math.floor(candidate));
    if (typeof candidate === 'string' && /^\d+$/.test(candidate.trim()) && Number(candidate) > 0) return String(Math.floor(Number(candidate)));
    if (Array.isArray(candidate)) candidates.push(...candidate);
    else if (isRecord(candidate)) candidates.push(candidate.publicId, candidate.postId, candidate.postID, candidate.id, candidate.value);
  }
  return '';
};

const buildNewsCanonicalUrl = (id: string, data: UnknownRecord, slug: string): string => {
  const ref = normalizePublicRef(data.publicId) || normalizePublicRef(data.postId) || id;
  return `https://cdelu.ar/noticia/${encodeURIComponent(ref)}/${encodeURIComponent(slug)}`;
};

const mapImages = (data: UnknownRecord): PublicImage[] => {
  const rawImages: unknown[] = [];
  if (Array.isArray(data.imagesV2)) rawImages.push(...data.imagesV2);
  if (Array.isArray(data.images)) rawImages.push(...data.images);
  if (typeof data.img === 'string') rawImages.push(data.img);
  if (typeof data.imgMiniatura === 'string') rawImages.push(data.imgMiniatura);

  const seen = new Set<string>();
  const result: PublicImage[] = [];
  for (const raw of rawImages) {
    const entry = isRecord(raw) ? raw : { url: raw };
    const url = asHttpUrl(entry.url || entry.thumbUrl || entry.thumbnailUrl);
    if (!url || isInvalidWordpressThumbnail(url) || seen.has(url)) continue;
    seen.add(url);
    const thumbnailUrl = asHttpUrl(entry.thumbUrl || entry.thumbnailUrl || entry.thumbnail_url);
    result.push({
      url,
      alt: asNullableString(entry.alt || entry.altText, 240),
      thumbnail_url: thumbnailUrl && !isInvalidWordpressThumbnail(thumbnailUrl) ? thumbnailUrl : null
    });
    if (result.length >= MAX_IMAGES) break;
  }
  return result;
};

const mapCategory = (value: unknown): PublicCategory | null => {
  const name = cleanPublicText(value, 120);
  if (!name) return null;
  return { id: normalizeSlug(name, 'general'), name };
};

const mapProvenance = (id: string, data: UnknownRecord, canonicalUrl: string, publishedAt: string, retrievedAt: string): PublicProvenance => ({
  source_type: sourceToPublicOrigin(data.source),
  publisher: PUBLIC_PUBLISHER,
  canonical_url: canonicalUrl,
  source_id: id,
  published_at: publishedAt,
  updated_at: toIso(data.updatedAt),
  retrieved_at: retrievedAt
});

export const mapPublicNews = (
  snapshot: PublicSnapshotLike,
  options: { retrievedAt?: Date } = {}
): PublicNews | null => {
  const raw = snapshot.data();
  if (!isPublicNewsRecord(raw)) return null;
  const data = asRecord(raw) as UnknownRecord;
  const title = cleanPublicText(data.titulo, 240);
  const content = cleanPublicText(data.descripcion);
  const publishedAt = toIso(data.publishedAt) || toIso(data.createdAt);
  if (!title || !content || !publishedAt) return null;

  const slug = normalizeSlug(data.slug, title);
  const canonicalUrl = buildNewsCanonicalUrl(snapshot.id, data, slug);
  const retrievedAt = (options.retrievedAt || new Date()).toISOString();
  const category = mapCategory(data.category);

  return {
    id: snapshot.id,
    type: 'news',
    origin: 'editorial',
    visibility: 'public',
    status: 'published',
    title,
    slug,
    summary: content.slice(0, MAX_SUMMARY_LENGTH),
    content,
    canonical_url: canonicalUrl,
    published_at: publishedAt,
    updated_at: toIso(data.updatedAt) || publishedAt,
    language: 'es-AR',
    category,
    author: { id: 'cdelu-editorial', name: PUBLIC_PUBLISHER },
    location: { city: 'Concepción del Uruguay', province: 'Entre Ríos', country: 'AR' },
    images: mapImages(data),
    provenance: mapProvenance(snapshot.id, data, canonicalUrl, publishedAt, retrievedAt)
  };
};

export const mapPublicNewsSummary = (
  snapshot: PublicSnapshotLike,
  options: { retrievedAt?: Date } = {}
): Omit<PublicNews, 'content'> | null => {
  const news = mapPublicNews(snapshot, options);
  if (!news) return null;
  const { content: _content, ...summary } = news;
  return summary;
};

export const mapPublicEvent = (
  snapshot: PublicSnapshotLike,
  options: { retrievedAt?: Date } = {}
): PublicEvent | null => {
  const raw = snapshot.data();
  if (!isStructuredPublicEvent(raw)) return null;
  const data = asRecord(raw);
  const name = cleanPublicText(data.name || data.titulo, 240);
  const startAt = toIso(data.startAt || data.start_at);
  if (!name || !startAt) return null;

  const slug = normalizeSlug(data.slug, name);
  const canonicalUrl = asHttpUrl(data.canonicalUrl) || `https://cdelu.ar/evento/${encodeURIComponent(snapshot.id)}/${encodeURIComponent(slug)}`;
  const updatedAt = toIso(data.updatedAt);
  const publishedAt = toIso(data.publishedAt) || updatedAt || startAt;
  const sourceUrl = asHttpUrl(data.originalUrl || data.sourceUrl) || canonicalUrl;
  const venue = asRecord(data.venue);
  const retrievedAt = (options.retrievedAt || new Date()).toISOString();

  return {
    id: snapshot.id,
    type: 'event',
    origin: sourceToPublicOrigin(data.source),
    visibility: 'public',
    status: data.status === 'cancelled' || data.status === 'postponed' || data.status === 'finished' ? data.status : 'scheduled',
    name,
    summary: cleanPublicText(data.summary || data.descripcion, MAX_SUMMARY_LENGTH),
    canonical_url: canonicalUrl,
    start_at: startAt,
    end_at: toIso(data.endAt || data.end_at),
    timezone: PUBLIC_TIMEZONE,
    venue: Object.keys(venue).length > 0 ? {
      name: asNullableString(venue.name, 180),
      address: asNullableString(venue.address, 240),
      city: asNullableString(venue.city, 120)
    } : null,
    source: { url: sourceUrl, updated_at: updatedAt },
    provenance: {
      source_type: sourceToPublicOrigin(data.source),
      publisher: PUBLIC_PUBLISHER,
      canonical_url: canonicalUrl,
      source_id: snapshot.id,
      published_at: publishedAt,
      updated_at: updatedAt,
      retrieved_at: retrievedAt
    }
  };
};

export const mapPublicCategory = (value: unknown, id?: string): PublicCategory | null => {
  const data = isRecord(value) ? value : {};
  const name = cleanPublicText(data.name || value, 120);
  if (!name) return null;
  return { id: normalizeSlug(id || data.id || name, name), name };
};

export const mapPublicSearchResult = (
  resource: PublicNews | PublicEvent,
  score: number | null = null,
  match: PublicSearchMatch | null = null
): PublicSearchResult => ({
  id: resource.id,
  type: resource.type,
  title: resource.type === 'news' ? resource.title : resource.name,
  summary: resource.type === 'news' ? resource.summary : resource.summary,
  canonical_url: resource.canonical_url,
  published_at: resource.type === 'news' ? resource.published_at : resource.provenance.published_at || resource.start_at,
  score,
  match,
  provenance: resource.provenance
});
