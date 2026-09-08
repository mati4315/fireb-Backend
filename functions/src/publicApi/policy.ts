import type { PublicOrigin } from './types';

export const PUBLIC_TIMEZONE = 'America/Argentina/Buenos_Aires' as const;
export const PUBLIC_PUBLISHER = 'CDELU';
export const PUBLIC_NEWS_SOURCES = new Set(['wordpress', 'admin']);

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (value: UnknownRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export const sourceToPublicOrigin = (source: unknown): PublicOrigin => {
  if (source === 'wordpress' || source === 'admin') return 'editorial';
  if (source === 'scraping') return 'aggregated';
  if (source === 'user') return 'user_submitted';
  return 'unknown';
};

export const isPublicNewsRecord = (value: unknown): value is UnknownRecord => {
  if (!isRecord(value)) return false;
  if (value.module !== 'news' || value.type !== 'news') return false;
  if (value.isOficial !== true) return false;
  if (!PUBLIC_NEWS_SOURCES.has(String(value.source || ''))) return false;
  if (value.deletedAt !== null && value.deletedAt !== undefined) return false;

  if (hasOwn(value, 'visibility') && value.visibility !== 'public') return false;
  if (hasOwn(value, 'status') && value.status !== 'published') return false;

  const moderation = value.moderation;
  if (hasOwn(value, 'moderation') && !isRecord(moderation)) return false;
  if (isRecord(moderation) && hasOwn(moderation, 'status')) {
    if (moderation.status !== 'approved' && moderation.status !== 'active') return false;
  }

  return true;
};

export const isStructuredPublicEvent = (value: unknown): value is UnknownRecord => {
  if (!isRecord(value)) return false;
  if (value.type !== 'event' && value.module !== 'events') return false;
  if (value.deletedAt !== null && value.deletedAt !== undefined) return false;
  if (value.visibility !== undefined && value.visibility !== 'public') return false;
  return typeof value.startAt === 'string' || typeof value.startAt === 'object';
};
