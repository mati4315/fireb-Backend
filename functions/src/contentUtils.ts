export const CONTENT_SLUG_MAX_LENGTH = 96;

export const inferContentModule = (
  contentData: FirebaseFirestore.DocumentData
): 'news' | 'community' => {
  if (contentData?.module === 'news' || contentData?.type === 'news') {
    return 'news';
  }
  return 'community';
};

export const normalizeContentSlug = (value: unknown): string => {
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

export const buildContentSlugKey = (moduleName: 'news' | 'community', slug: string): string =>
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

export const buildContentPublicIdKey = (moduleName: 'news' | 'community', publicId: string): string =>
  `${moduleName}__${publicId}`;

export const extractNewsPublicIdFromPayload = (payload: any): string => {
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

export const buildContentSlugBase = (contentData: FirebaseFirestore.DocumentData): string => {
  const title = typeof contentData?.titulo === 'string' ? contentData.titulo.trim() : '';
  if (title) return normalizeContentSlug(title);
  const moduleName = inferContentModule(contentData);
  return moduleName === 'news' ? 'noticia' : 'publicacion';
};
