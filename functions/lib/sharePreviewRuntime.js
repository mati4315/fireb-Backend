"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sharePreview = void 0;
const admin = require("firebase-admin");
const functions = require("firebase-functions");
const PUBLIC_ORIGIN = 'https://cdelu.ar';
const DEFAULT_IMAGE = `${PUBLIC_ORIGIN}/logo.jpg?v=20260522`;
const escapeHtml = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const cleanText = (value, maxLength) => {
    if (typeof value !== 'string')
        return '';
    return value
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
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
        data.imgMiniatura,
        data.coverImageUrl,
        data.coverImage,
        data.thumbnailUrl,
        (_b = (_a = data.imagesV2) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.thumbUrl,
        (_d = (_c = data.imagesV2) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.url,
        (_f = (_e = data.images) === null || _e === void 0 ? void 0 : _e[0]) === null || _f === void 0 ? void 0 : _f.thumbUrl,
        (_h = (_g = data.images) === null || _g === void 0 ? void 0 : _g[0]) === null || _h === void 0 ? void 0 : _h.url,
        (_j = data.images) === null || _j === void 0 ? void 0 : _j[0]
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
exports.sharePreview = functions.https.onRequest(async (req, res) => {
    var _a;
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
        else {
            const secretDoc = await admin.firestore().collection('content').doc(reference).get();
            const secret = secretDoc.data();
            if (!secretDoc.exists || (secret === null || secret === void 0 ? void 0 : secret.module) !== 'secrets' || (secret === null || secret === void 0 ? void 0 : secret.deletedAt) != null ||
                (((_a = secret === null || secret === void 0 ? void 0 : secret.moderation) === null || _a === void 0 ? void 0 : _a.status) && secret.moderation.status !== 'active')) {
                res.status(404).send('El secreto no está disponible.');
                return;
            }
            title = 'Secreto anónimo | Cdelu.ar';
            description = cleanText(secret.descripcion, 300) || 'Lee este secreto en Cdelu.ar.';
        }
        res.status(200).type('html').send(buildPreviewHtml(canonicalUrl, title, description, image));
    }
    catch (error) {
        console.error('[share-preview] failed', { kind, reference, error });
        res.status(500).send('No se pudo preparar la vista previa.');
    }
});
//# sourceMappingURL=sharePreviewRuntime.js.map