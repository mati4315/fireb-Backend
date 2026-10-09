"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.secretShareImage = exports.sharePreview = void 0;
const admin = require("firebase-admin");
const functions = require("firebase-functions");
const sharp = require("sharp");
const PUBLIC_ORIGIN = 'https://cdelu.ar';
const DEFAULT_IMAGE = `${PUBLIC_ORIGIN}/logo.jpg?v=20260522`;
const SECRET_IMAGE_WIDTH = 1200;
const SECRET_IMAGE_HEIGHT = 630;
const escapeHtml = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const escapeXml = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
const cleanText = (value, maxLength) => {
    if (typeof value !== 'string')
        return '';
    const decodeHtml = (input) => input.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|nbsp|amp|quot|apos|lt|gt);/gi, (entity, code) => {
        const normalized = code.toLowerCase();
        if (normalized === 'nbsp')
            return ' ';
        if (normalized === 'amp')
            return '&';
        if (normalized === 'quot')
            return '"';
        if (normalized === 'apos')
            return "'";
        if (normalized === 'lt')
            return '<';
        if (normalized === 'gt')
            return '>';
        const numeric = normalized.startsWith('#x')
            ? Number.parseInt(normalized.slice(2), 16)
            : Number.parseInt(normalized.slice(1), 10);
        if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 0x10ffff)
            return ' ';
        try {
            return String.fromCodePoint(numeric);
        }
        catch (_a) {
            return ' ';
        }
    });
    // Algunos artículos llegan con HTML escapado más de una vez.
    let decoded = value;
    for (let pass = 0; pass < 3; pass += 1) {
        const next = decodeHtml(decoded);
        if (next === decoded)
            break;
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
const publicImageUrl = (value) => {
    if (typeof value !== 'string')
        return '';
    try {
        const parsed = new URL(value.trim());
        return parsed.protocol === 'https:' ? parsed.toString() : '';
    }
    catch (_a) {
        return '';
    }
};
const firstImage = (data) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const candidates = [
        (_b = (_a = data.imagesV2) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.url,
        (_d = (_c = data.images) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.url,
        (_e = data.images) === null || _e === void 0 ? void 0 : _e[0],
        data.coverImageUrl,
        data.coverImage,
        data.thumbnailUrl,
        data.imgMiniatura,
        (_g = (_f = data.imagesV2) === null || _f === void 0 ? void 0 : _f[0]) === null || _g === void 0 ? void 0 : _g.thumbUrl,
        (_j = (_h = data.images) === null || _h === void 0 ? void 0 : _h[0]) === null || _j === void 0 ? void 0 : _j.thumbUrl
    ];
    for (const candidate of candidates) {
        const image = publicImageUrl(candidate);
        if (image)
            return image;
    }
    return '';
};
const findNews = async (reference) => {
    var _a, _b, _c;
    const db = admin.firestore();
    const publicIdDoc = await db.collection('_content_public_ids').doc(`news__${reference}`).get();
    const mappedId = String(((_a = publicIdDoc.data()) === null || _a === void 0 ? void 0 : _a.contentId) || '').trim();
    if (mappedId) {
        const mappedDoc = await db.collection('content').doc(mappedId).get();
        if (mappedDoc.exists && ((_b = mappedDoc.data()) === null || _b === void 0 ? void 0 : _b.module) === 'news') {
            return Object.assign({ id: mappedDoc.id }, (mappedDoc.data() || {}));
        }
    }
    const directDoc = await db.collection('content').doc(reference).get();
    if (directDoc.exists && ((_c = directDoc.data()) === null || _c === void 0 ? void 0 : _c.module) === 'news') {
        return Object.assign({ id: directDoc.id }, (directDoc.data() || {}));
    }
    if (/^\d+$/.test(reference)) {
        const fallback = await db.collection('content')
            .where('module', '==', 'news')
            .where('postId', '==', Number(reference))
            .limit(1)
            .get();
        if (!fallback.empty) {
            const doc = fallback.docs[0];
            return Object.assign({ id: doc.id }, (doc.data() || {}));
        }
    }
    return null;
};
const buildPreviewHtml = (canonicalUrl, title, description, image) => {
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
const wrapSecretText = (text, maxCharsPerLine, maxLines) => {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (next.length <= maxCharsPerLine) {
            line = next;
            continue;
        }
        if (line)
            lines.push(line);
        line = word;
        if (lines.length >= maxLines)
            break;
    }
    if (lines.length < maxLines && line)
        lines.push(line);
    const shownText = lines.join(' ');
    if (shownText.length < text.length && lines.length) {
        lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,;:!?\s]+$/, '')}…`;
    }
    return lines;
};
const buildSecretImageSvg = (description) => {
    const lines = wrapSecretText(description || 'Lee este secreto en Cdelu.ar.', 48, 6);
    const textElements = lines.map((line, index) => `<text x="112" y="${263 + index * 43}" class="body">${escapeXml(line)}</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${SECRET_IMAGE_WIDTH}" height="${SECRET_IMAGE_HEIGHT}" viewBox="0 0 ${SECRET_IMAGE_WIDTH} ${SECRET_IMAGE_HEIGHT}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff7ed"/><stop offset="1" stop-color="#f1f5f9"/></linearGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff8a00"/><stop offset="1" stop-color="#ffb020"/></linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#172033" flood-opacity=".16"/></filter>
    </defs>
    <style>
      .label{font:700 24px Arial,sans-serif;letter-spacing:3px;fill:#e87500}
      .title{font:700 42px Arial,sans-serif;fill:#172033}
      .body{font:400 32px Arial,sans-serif;fill:#354052}
      .brand{font:700 23px Arial,sans-serif;fill:#667085}
    </style>
    <rect width="1200" height="630" fill="url(#bg)"/>
    <circle cx="1112" cy="74" r="155" fill="#ff9a1f" opacity=".08"/>
    <rect x="48" y="42" width="1104" height="546" rx="28" fill="#fff" filter="url(#shadow)"/>
    <rect x="48" y="42" width="1104" height="12" rx="6" fill="url(#accent)"/>
    <text x="112" y="132" class="label">EL MURO ANÓNIMO</text>
    <text x="112" y="202" class="title">Un secreto de la comunidad</text>
    ${textElements}
    <line x1="112" y1="516" x2="1088" y2="516" stroke="#e8edf3" stroke-width="2"/>
    <text x="112" y="558" class="brand">Cdelu.ar · Concepción del Uruguay</text>
  </svg>`;
};
const getPublicSecret = async (reference) => {
    var _a;
    const secretDoc = await admin.firestore().collection('content').doc(reference).get();
    const secret = secretDoc.data();
    if (!secretDoc.exists || (secret === null || secret === void 0 ? void 0 : secret.module) !== 'secrets' || (secret === null || secret === void 0 ? void 0 : secret.deletedAt) != null ||
        (((_a = secret === null || secret === void 0 ? void 0 : secret.moderation) === null || _a === void 0 ? void 0 : _a.status) && secret.moderation.status !== 'active'))
        return null;
    return secret;
};
exports.sharePreview = functions.https.onRequest(async (req, res) => {
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
    }
    catch (_a) {
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
        }
        else {
            const secret = await getPublicSecret(reference);
            if (!secret) {
                res.status(404).send('El secreto no está disponible.');
                return;
            }
            title = 'Secreto anónimo | Cdelu.ar';
            description = cleanText(secret.descripcion, 300) || 'Lee este secreto en Cdelu.ar.';
            image = `https://us-central1-cdeluar-ddefc.cloudfunctions.net/secretShareImage?id=${encodeURIComponent(reference)}`;
        }
        res.status(200).type('html').send(buildPreviewHtml(canonicalUrl, title, description, image));
    }
    catch (error) {
        console.error('[share-preview] failed', { kind, reference, error });
        res.status(500).send('No se pudo preparar la vista previa.');
    }
});
/** Renders each public secret preview on demand; no image is written to Storage. */
exports.secretShareImage = functions.https.onRequest(async (req, res) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.status(405).send('Method not allowed');
        return;
    }
    const reference = typeof req.query.id === 'string' ? req.query.id.trim() : '';
    if (!reference || reference.length > 128 || /[\/\\]/.test(reference)) {
        res.status(400).send('Invalid secret reference');
        return;
    }
    try {
        const secret = await getPublicSecret(reference);
        if (!secret) {
            res.status(404).send('El secreto no está disponible.');
            return;
        }
        const description = cleanText(secret.descripcion, 500);
        const png = await sharp(Buffer.from(buildSecretImageSvg(description)))
            .png({ compressionLevel: 9, palette: true })
            .toBuffer();
        res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
        res.set('Content-Length', String(png.length));
        res.type('png').status(200);
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        res.send(png);
    }
    catch (error) {
        console.error('[secret-share-image] failed', { reference, error });
        res.status(500).send('No se pudo generar la vista previa.');
    }
});
//# sourceMappingURL=sharePreviewRuntime.js.map