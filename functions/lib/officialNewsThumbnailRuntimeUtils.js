"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOfficialNewsThumbnail = exports.isCurrentWeekOrFuture = exports.isOfficialThumbnailSource = void 0;
const node_stream_1 = require("node:stream");
const hostingUtils_1 = require("./hostingUtils");
const TARGET_HOSTS = new Set([
    'arribanoticias.com.ar',
    'www.arribanoticias.com.ar',
    'elmiercolesdigital.com.ar',
    'www.elmiercolesdigital.com.ar'
]);
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const THUMBNAIL_WIDTH = 640;
const THUMBNAIL_QUALITY = 72;
const getArgentinaWeekStart = (now) => {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(now);
    const getPart = (type) => { var _a; return Number(((_a = parts.find((part) => part.type === type)) === null || _a === void 0 ? void 0 : _a.value) || 0); };
    const localMidnightUtc = new Date(Date.UTC(getPart('year'), getPart('month') - 1, getPart('day'), 3));
    const daysSinceMonday = (localMidnightUtc.getUTCDay() + 6) % 7;
    localMidnightUtc.setUTCDate(localMidnightUtc.getUTCDate() - daysSinceMonday);
    return localMidnightUtc;
};
const isOfficialThumbnailSource = (value) => {
    if (typeof value !== 'string' || !value.trim())
        return false;
    try {
        return TARGET_HOSTS.has(new URL(value).hostname.toLowerCase());
    }
    catch (_a) {
        return false;
    }
};
exports.isOfficialThumbnailSource = isOfficialThumbnailSource;
const isCurrentWeekOrFuture = (publishedAt, now = new Date()) => {
    return (publishedAt || now).getTime() >= getArgentinaWeekStart(now).getTime();
};
exports.isCurrentWeekOrFuture = isCurrentWeekOrFuture;
const safeNewsId = (newsId) => (0, hostingUtils_1.sanitizePathSegment)(newsId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120) || 'news';
const safeSourceName = (sourceUrl) => {
    try {
        return (0, hostingUtils_1.sanitizePathSegment)(new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, ''));
    }
    catch (_a) {
        return 'official';
    }
};
const createOfficialNewsThumbnail = async (options) => {
    if (!(0, exports.isOfficialThumbnailSource)(options.sourceUrl) ||
        !options.primaryImageUrl ||
        !(0, exports.isCurrentWeekOrFuture)(options.publishedAt)) {
        return null;
    }
    let imageUrl;
    try {
        imageUrl = new URL(options.primaryImageUrl);
        if (imageUrl.protocol !== 'http:' && imageUrl.protocol !== 'https:')
            return null;
    }
    catch (_a) {
        return null;
    }
    try {
        const response = await fetch(imageUrl, {
            headers: { Accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8' },
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok)
            throw new Error(`source-image-http-${response.status}`);
        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > MAX_SOURCE_BYTES)
            throw new Error('source-image-too-large');
        const sourceBuffer = Buffer.from(await response.arrayBuffer());
        if (sourceBuffer.length === 0 || sourceBuffer.length > MAX_SOURCE_BYTES) {
            throw new Error('source-image-invalid-size');
        }
        const sharp = await (0, hostingUtils_1.loadSharp)();
        const thumbnailBuffer = await sharp(sourceBuffer)
            .rotate()
            .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
            .webp({ quality: THUMBNAIL_QUALITY, effort: 4 })
            .toBuffer();
        const relativePath = `news-thumbnails/${safeSourceName(options.sourceUrl)}/${safeNewsId(options.newsId)}.webp`;
        const config = (0, hostingUtils_1.getHostingFtpConfig)();
        const remotePath = `${config.basePath}/${relativePath}`.replace(/\/+/g, '/');
        const remoteDir = remotePath.slice(0, remotePath.lastIndexOf('/'));
        const { Client } = await (0, hostingUtils_1.loadFtpClient)();
        const ftpClient = new Client(30000);
        ftpClient.ftp.verbose = false;
        try {
            await ftpClient.access({
                host: config.host,
                user: config.user,
                password: config.password,
                port: config.port,
                secure: false
            });
            await ftpClient.ensureDir(remoteDir);
            await ftpClient.uploadFrom(node_stream_1.Readable.from(thumbnailBuffer), remotePath);
        }
        finally {
            ftpClient.close();
        }
        console.log('Official news thumbnail generated', {
            newsId: options.newsId,
            sourceHost: new URL(options.sourceUrl).hostname,
            sizeBytes: thumbnailBuffer.length,
            relativePath
        });
        return `${config.publicBaseUrl}/${relativePath}`;
    }
    catch (error) {
        console.error('Official news thumbnail generation failed', {
            newsId: options.newsId,
            sourceUrl: options.sourceUrl,
            error
        });
        return null;
    }
};
exports.createOfficialNewsThumbnail = createOfficialNewsThumbnail;
//# sourceMappingURL=officialNewsThumbnailRuntimeUtils.js.map