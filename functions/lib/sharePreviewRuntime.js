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
    let truncated = false;
    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (next.length <= maxCharsPerLine) {
            line = next;
            continue;
        }
        if (line)
            lines.push(line);
        line = word;
        if (lines.length >= maxLines) {
            truncated = true;
            break;
        }
    }
    if (lines.length < maxLines && line)
        lines.push(line);
    if (!truncated && lines.join(' ').length < text.length)
        truncated = true;
    if (truncated && lines.length) {
        lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,;:!?\s]+$/, '')}…`;
    }
    return { lines, truncated };
};
const relativeSecretTime = (value) => {
    let createdAtMs = 0;
    if (value && typeof value === 'object' && 'toMillis' in value && typeof value.toMillis === 'function') {
        createdAtMs = Number(value.toMillis());
    }
    else if (value && typeof value === 'object' && '_seconds' in value) {
        createdAtMs = Number(value._seconds) * 1000;
    }
    else if (typeof value === 'string' || typeof value === 'number') {
        createdAtMs = Date.parse(String(value));
    }
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0)
        return 'reciente';
    const minutes = Math.max(1, Math.floor((Date.now() - createdAtMs) / 60000));
    if (minutes < 60)
        return `hace ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `hace ${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30)
        return `hace ${days}d`;
    const months = Math.floor(days / 30);
    if (months < 12)
        return `hace ${months} mes${months === 1 ? '' : 'es'}`;
    const years = Math.floor(months / 12);
    return `hace ${years} año${years === 1 ? '' : 's'}`;
};
const secretCategoryLabel = (value) => {
    const labels = {
        rumores: 'Rumores',
        relaciones: 'Relaciones',
        trabajo_negocios: 'Trabajo / negocios',
        denuncia_light: 'Denuncias light',
        random_divertido: 'Random / divertido'
    };
    const category = typeof value === 'string' ? value.trim() : '';
    return labels[category] || category;
};
const buildSecretImageSvg = (secret, reference) => {
    var _a, _b, _c;
    const description = cleanText(secret.descripcion, 4000) || 'Lee este secreto en Cdelu.ar.';
    const hasChips = Boolean(secretCategoryLabel(secret.category) || (typeof secret.zone === 'string' && secret.zone.trim()));
    const { lines } = wrapSecretText(description, 76, hasChips ? 7 : 8);
    const textElements = lines.map((line, index) => `<text x="30" y="${224 + index * 36}" class="body">${escapeXml(line)}</text>`).join('');
    const sex = String(secret.sex || 'no_responder');
    const accent = sex === 'mujer' ? '#ca2a6e' : sex === 'hombre' ? '#1e5fad' : '#586477';
    const genderIcon = sex === 'mujer' ? '♀' : sex === 'hombre' ? '♂' : '•';
    const age = Number(secret.age);
    const ageLabel = Number.isFinite(age) && age > 0 ? `${Math.floor(age)} años` : '';
    const alias = cleanText(secret.anonAlias, 40) || 'Anonimo';
    const idLabel = `@${reference.slice(0, 8)}`;
    const upVotes = Math.max(0, Math.floor(Number((_a = secret.stats) === null || _a === void 0 ? void 0 : _a.upVotesCount) || 0));
    const downVotes = Math.max(0, Math.floor(Number((_b = secret.stats) === null || _b === void 0 ? void 0 : _b.downVotesCount) || 0));
    const totalVotes = upVotes + downVotes;
    const comments = Math.max(0, Math.floor(Number((_c = secret.stats) === null || _c === void 0 ? void 0 : _c.commentsCount) || 0));
    const category = secretCategoryLabel(secret.category);
    const zone = typeof secret.zone === 'string' ? cleanText(secret.zone, 28) : '';
    const chips = [category, zone].filter(Boolean).map((chip, index) => `<rect x="30" y="${hasChips ? 500 : 0}" width="${Math.max(88, chip.length * 14 + 34)}" height="34" rx="17" fill="#253247" stroke="#46556b" stroke-width="1.5" transform="translate(${index === 1 && category ? Math.max(88, category.length * 14 + 34) + 12 : 0} 0)"/><text x="${47 + (index === 1 && category ? Math.max(88, category.length * 14 + 34) + 12 : 0)}" y="523" class="chip">${escapeXml(chip)}</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${SECRET_IMAGE_WIDTH}" height="${SECRET_IMAGE_HEIGHT}" viewBox="0 0 ${SECRET_IMAGE_WIDTH} ${SECRET_IMAGE_HEIGHT}">
    <style>
      .header{font:700 25px Arial,sans-serif;fill:#fff}
      .header-id{font:600 23px Arial,sans-serif;fill:#fff;opacity:.92}
      .header-stat{font:700 26px Arial,sans-serif;fill:#fff}
      .body{font:400 28px Arial,sans-serif;fill:#f8fafc}
      .alias{font:700 23px Arial,sans-serif;fill:#fff}
      .time{font:400 20px Arial,sans-serif;fill:#b8c2d2}
      .chip{font:600 18px Arial,sans-serif;fill:#d9e2ef}
      .button{font:600 18px Arial,sans-serif;fill:#fff}
    </style>
    <rect width="1200" height="630" fill="#1e293b"/>
    <rect width="1200" height="108" fill="${accent}"/>
    <text x="30" y="67" class="header">${genderIcon}${ageLabel ? `  ${escapeXml(ageLabel)}` : ''}</text>
    <text x="600" y="67" text-anchor="middle" class="header-id">${escapeXml(idLabel)}</text>
    <text x="970" y="67" text-anchor="end" class="header-stat">${totalVotes}</text>
    <g fill="#fff" stroke="${accent}" stroke-width="2">
      <circle cx="1015" cy="58" r="15"/><circle cx="1060" cy="58" r="15"/>
    </g>
    <g fill="none" stroke="${accent}" stroke-width="2.2" stroke-linecap="round">
      <path d="M1009 54h1m10 0h1m-12 10q6-7 12 0"/><path d="M1054 54h1m10 0h1m-12 5q6 7 12 0"/>
    </g>
    <text x="1160" y="67" text-anchor="middle" class="header-stat">⋮</text>
    <text x="30" y="157" class="alias">${escapeXml(alias)}</text>
    <text x="${Math.min(260, 42 + alias.length * 14)}" y="157" class="time">·  ${escapeXml(relativeSecretTime(secret.createdAt))}</text>
    ${textElements}
    ${chips}
    <rect y="540" width="1200" height="90" fill="${accent}"/>
    <g fill="rgba(255,255,255,.15)" stroke="rgba(255,255,255,.38)" stroke-width="1.5">
      <rect x="30" y="559" width="105" height="48" rx="24"/><rect x="145" y="559" width="105" height="48" rx="24"/>
      <rect x="260" y="559" width="250" height="48" rx="24"/><rect x="520" y="559" width="58" height="48" rx="24"/>
      <rect x="588" y="559" width="105" height="48" rx="24"/>
    </g>
    <g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M48 579v15h-6v-15h6zm0 1h5l7-8c2-2 5 0 4 3l-2 5h9c2 0 3 2 2 4l-3 8c-.4 1.5-1.5 2.5-3 2.5H55l-7-2"/>
      <path d="M163 579v15h-6v-15h6zm0 1h5l7-8c2-2 5 0 4 3l-2 5h9c2 0 3 2 2 4l-3 8c-.4 1.5-1.5 2.5-3 2.5H170l-7-2" transform="rotate(180 174 586)"/>
    </g>
    <text x="82" y="590" class="button">${upVotes}</text>
    <text x="197" y="590" class="button">${downVotes}</text>
    <text x="282" y="590" class="button">Comentarios ${comments}</text>
    <text x="540" y="590" class="button">↗</text>
    <text x="608" y="590" class="button">Abrir</text>
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
    var _a;
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') {
        res.status(405).send('Method not allowed');
        return;
    }
    const requestPath = typeof req.query.path === 'string' ? req.query.path : '';
    const match = requestPath.match(/^\/(noticia|s|c)\/([^/?#]+)(?:\/[^?#]*)?$/);
    if (!match) {
        res.status(400).send('Invalid preview path');
        return;
    }
    const [, kind, rawReference] = match;
    let reference = '';
    try {
        reference = decodeURIComponent(rawReference).trim();
    }
    catch (_b) {
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
        else if (kind === 's') {
            const secret = await getPublicSecret(reference);
            if (!secret) {
                res.status(404).send('El secreto no está disponible.');
                return;
            }
            title = 'Secreto anónimo | Cdelu.ar';
            description = cleanText(secret.descripcion, 300) || 'Lee este secreto en Cdelu.ar.';
            image = `https://us-central1-cdeluar-ddefc.cloudfunctions.net/secretShareImage?id=${encodeURIComponent(reference)}`;
        }
        else {
            const communityDoc = await admin.firestore().collection('content').doc(reference).get();
            const community = communityDoc.data();
            if (!communityDoc.exists || (community === null || community === void 0 ? void 0 : community.module) !== 'community' || (community === null || community === void 0 ? void 0 : community.deletedAt) != null ||
                (((_a = community === null || community === void 0 ? void 0 : community.moderation) === null || _a === void 0 ? void 0 : _a.status) && community.moderation.status !== 'active')) {
                res.status(404).send('La publicación no está disponible.');
                return;
            }
            const author = cleanText(community.userName || community.titulo, 100);
            const postText = cleanText(community.descripcion, 300);
            title = author ? `Publicación de ${author}` : 'Publicación de la comunidad';
            description = postText || 'Mira esta publicación en Cdelu.ar.';
            image = firstImage(community) || DEFAULT_IMAGE;
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
        const png = await sharp(Buffer.from(buildSecretImageSvg(secret, reference)))
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