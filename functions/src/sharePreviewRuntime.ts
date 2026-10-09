import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

const PUBLIC_ORIGIN = 'https://cdelu.ar';
const DEFAULT_IMAGE = `${PUBLIC_ORIGIN}/logo.jpg?v=20260522`;

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const cleanText = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') return '';
  const decodeHtml = (input: string): string => input.replace(
    /&(#x[\da-f]{1,6}|#\d{1,7}|nbsp|amp|quot|apos|lt|gt);/gi,
    (entity, code: string) => {
      const normalized = code.toLowerCase();
      if (normalized === 'nbsp') return ' ';
      if (normalized === 'amp') return '&';
      if (normalized === 'quot') return '"';
      if (normalized === 'apos') return "'";
      if (normalized === 'lt') return '<';
      if (normalized === 'gt') return '>';
      const numeric = normalized.startsWith('#x')
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 0x10ffff) return ' ';
      try {
        return String.fromCodePoint(numeric);
      } catch {
        return ' ';
      }
    }
  );

  // Algunos artículos llegan con HTML escapado más de una vez.
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decodeHtml(decoded);
    if (next === decoded) break;
    decoded = next;
  }

  return decoded
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b(?:class|style|id|data-[\w-]+|aria-[\w-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
};

const publicImageUrl = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
};

const firstImage = (data: FirebaseFirestore.DocumentData): string => {
  const candidates: unknown[] = [
    data.imagesV2?.[0]?.url,
    data.images?.[0]?.url,
    data.images?.[0],
    data.coverImageUrl,
    data.coverImage,
    data.thumbnailUrl,
    data.imgMiniatura,
    data.imagesV2?.[0]?.thumbUrl,
    data.images?.[0]?.thumbUrl
  ];
  for (const candidate of candidates) {
    const image = publicImageUrl(candidate);
    if (image) return image;
  }
  return '';
};

const findNews = async (reference: string): Promise<FirebaseFirestore.DocumentData | null> => {
  const db = admin.firestore();
  const publicIdDoc = await db.collection('_content_public_ids').doc(`news__${reference}`).get();
  const mappedId = String(publicIdDoc.data()?.contentId || '').trim();
  if (mappedId) {
    const mappedDoc = await db.collection('content').doc(mappedId).get();
    if (mappedDoc.exists && mappedDoc.data()?.module === 'news') {
      return { id: mappedDoc.id, ...(mappedDoc.data() || {}) };
    }
  }

  const directDoc = await db.collection('content').doc(reference).get();
  if (directDoc.exists && directDoc.data()?.module === 'news') {
    return { id: directDoc.id, ...(directDoc.data() || {}) };
  }

  if (/^\d+$/.test(reference)) {
    const fallback = await db.collection('content')
      .where('module', '==', 'news')
      .where('postId', '==', Number(reference))
      .limit(1)
      .get();
    if (!fallback.empty) {
      const doc = fallback.docs[0];
      return { id: doc.id, ...(doc.data() || {}) };
    }
  }
  return null;
};

const buildPreviewHtml = (
  canonicalUrl: string,
  title: string,
  description: string,
  image: string
): string => {
  const safeUrl = escapeHtml(canonicalUrl);
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeImage = escapeHtml(image);

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title><meta name="description" content="${safeDescription}">
<link rel="canonical" href="${safeUrl}">
<meta property="og:type" content="article"><meta property="og:site_name" content="Cdelu.ar">
<meta property="og:title" content="${safeTitle}"><meta property="og:description" content="${safeDescription}">
<meta property="og:url" content="${safeUrl}"><meta property="og:image" content="${safeImage}">
<meta property="og:image:secure_url" content="${safeImage}"><meta property="og:image:alt" content="${safeTitle}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:description" content="${safeDescription}"><meta name="twitter:image" content="${safeImage}"></head>
<body><p><a href="${safeUrl}">Abrir en Cdelu.ar</a></p></body></html>`;
};

export const sharePreview = functions.https.onRequest(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }

  const requestPath = typeof req.query.path === 'string' ? req.query.path : '';
  const match = requestPath.match(/^\/(noticia|s)\/([^/?#]+)(?:\/[^?#]*)?$/);
  if (!match) {
    res.status(400).send('Invalid preview path');
    return;
  }

  const [, kind, rawReference] = match;
  let reference = '';
  try {
    reference = decodeURIComponent(rawReference).trim();
  } catch {
    res.status(400).send('Invalid preview reference');
    return;
  }
  if (!reference || reference.length > 128 || /[\/\\]/.test(reference)) {
    res.status(400).send('Invalid preview reference');
    return;
  }

  const canonicalUrl = new URL(requestPath, PUBLIC_ORIGIN).toString();
  let title = 'Cdelu.ar';
  let description = 'Noticias y comunidad de Concepción del Uruguay.';
  let image = DEFAULT_IMAGE;

  try {
    if (kind === 'noticia') {
      const news = await findNews(reference);
      if (!news || news.deletedAt != null || news.published === false) {
        res.status(404).send('La noticia no está disponible.');
        return;
      }
      title = cleanText(news.titulo, 180) || 'Noticia en Cdelu.ar';
      description = cleanText(news.descripcion, 300) || 'Lee esta noticia en Cdelu.ar.';
      image = firstImage(news) || DEFAULT_IMAGE;
    } else {
      const secretDoc = await admin.firestore().collection('content').doc(reference).get();
      const secret = secretDoc.data();
      if (
        !secretDoc.exists || secret?.module !== 'secrets' || secret?.deletedAt != null ||
        (secret?.moderation?.status && secret.moderation.status !== 'active')
      ) {
        res.status(404).send('El secreto no está disponible.');
        return;
      }
      title = 'Secreto anónimo | Cdelu.ar';
      description = cleanText(secret.descripcion, 300) || 'Lee este secreto en Cdelu.ar.';
    }

    res.status(200).type('html').send(buildPreviewHtml(canonicalUrl, title, description, image));
  } catch (error) {
    console.error('[share-preview] failed', { kind, reference, error });
    res.status(500).send('No se pudo preparar la vista previa.');
  }
});
