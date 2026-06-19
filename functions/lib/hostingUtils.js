"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupCommunityPostHostingMedia = exports.cleanupHostingRelativePath = exports.deriveHostingThumbRelativePath = exports.markHostingDocPaths = exports.buildHostingPathSet = exports.extractHostedRelativePaths = exports.normalizeHostedRelativePath = exports.getHostingAvatarFtpConfig = exports.getHostingFtpConfig = exports.sanitizePathSegment = exports.decodeBase64Payload = exports.ensureImageMime = exports.sanitizeOptionalUrl = exports.loadSharp = exports.loadFtpClient = void 0;
const functions = require("firebase-functions");
const path = require("path");
const userUtils_1 = require("./userUtils");
const MAX_HOSTING_UPLOAD_BYTES = 6 * 1024 * 1024;
const loadFtpClient = async () => {
    const ftpModule = await Promise.resolve().then(() => require('basic-ftp'));
    return ftpModule.default
        ? ftpModule.default
        : ftpModule;
};
exports.loadFtpClient = loadFtpClient;
const loadSharp = async () => {
    var _a;
    const sharpModule = await Promise.resolve().then(() => require('sharp'));
    return (_a = sharpModule.default) !== null && _a !== void 0 ? _a : sharpModule;
};
exports.loadSharp = loadSharp;
const sanitizeOptionalUrl = (value, fieldName) => {
    const raw = (0, userUtils_1.sanitizeBoundedString)(value, 240);
    if (!raw)
        return '';
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
        const parsed = new URL(withProtocol);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('unsupported-protocol');
        }
        return parsed.toString().slice(0, 240);
    }
    catch (_a) {
        throw new functions.https.HttpsError('invalid-argument', `${fieldName} debe ser una URL valida (http/https).`);
    }
};
exports.sanitizeOptionalUrl = sanitizeOptionalUrl;
const ensureImageMime = (value) => {
    const mime = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!mime.startsWith('image/')) {
        throw new functions.https.HttpsError('invalid-argument', 'Formato de archivo invalido.');
    }
    return mime;
};
exports.ensureImageMime = ensureImageMime;
const decodeBase64Payload = (value) => {
    if (typeof value !== 'string' || !value.trim()) {
        throw new functions.https.HttpsError('invalid-argument', 'No se recibio imagen.');
    }
    const sanitized = value.replace(/^data:[^;]+;base64,/, '').trim();
    const buffer = Buffer.from(sanitized, 'base64');
    if (buffer.length === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'No se pudo decodificar la imagen.');
    }
    if (buffer.length > MAX_HOSTING_UPLOAD_BYTES) {
        throw new functions.https.HttpsError('invalid-argument', 'La imagen supera el limite permitido.');
    }
    return buffer;
};
exports.decodeBase64Payload = decodeBase64Payload;
const sanitizePathSegment = (value) => {
    return value
        .replace(/[^a-zA-Z0-9/_.-]/g, '-')
        .replace(/\.\.+/g, '.')
        .replace(/\/+/g, '/')
        .replace(/^\//, '')
        .replace(/\/$/, '');
};
exports.sanitizePathSegment = sanitizePathSegment;
const getHostingFtpConfig = () => {
    const host = process.env.HOSTING_FTP_HOST || '';
    const user = process.env.HOSTING_FTP_USER || '';
    const password = process.env.HOSTING_FTP_PASSWORD || '';
    const basePath = process.env.HOSTING_FTP_BASE_PATH || '/domains/bot.cdelu.io/public_html/images';
    const publicBaseUrl = process.env.HOSTING_PUBLIC_BASE_URL || 'https://bot.cdelu.io/images';
    const port = Number(process.env.HOSTING_FTP_PORT || 21);
    if (!host || !user || !password) {
        throw new functions.https.HttpsError('failed-precondition', 'Falta configurar credenciales FTP del hosting.');
    }
    return {
        host,
        user,
        password,
        port: Number.isFinite(port) ? port : 21,
        basePath,
        publicBaseUrl: publicBaseUrl.replace(/\/$/, '')
    };
};
exports.getHostingFtpConfig = getHostingFtpConfig;
const getHostingAvatarFtpConfig = () => {
    const host = process.env.HOSTING_FTP_HOST || '';
    const user = process.env.HOSTING_FTP_USER || '';
    const password = process.env.HOSTING_FTP_PASSWORD || '';
    const basePath = process.env.HOSTING_FTP_AVATAR_BASE_PATH || '/domains/bot.cdelu.io/public_html';
    const publicBaseUrl = process.env.HOSTING_AVATAR_PUBLIC_BASE_URL || 'https://bot.cdelu.io';
    const port = Number(process.env.HOSTING_FTP_PORT || 21);
    if (!host || !user || !password) {
        throw new functions.https.HttpsError('failed-precondition', 'Falta configurar credenciales FTP del hosting.');
    }
    return {
        host,
        user,
        password,
        port: Number.isFinite(port) ? port : 21,
        basePath,
        publicBaseUrl: publicBaseUrl.replace(/\/$/, '')
    };
};
exports.getHostingAvatarFtpConfig = getHostingAvatarFtpConfig;
const normalizeHostedRelativePath = (value) => {
    return value
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+/g, '/')
        .trim();
};
exports.normalizeHostedRelativePath = normalizeHostedRelativePath;
const extractHostedRelativePaths = (value, publicBaseUrl) => {
    const results = new Set();
    const publicBase = publicBaseUrl.replace(/\/+$/, '');
    const pushPath = (candidate) => {
        const normalized = (0, exports.normalizeHostedRelativePath)(candidate);
        if (!normalized || normalized.includes('..'))
            return;
        results.add(normalized.replace(/^avatars\//i, 'AVATAR/'));
    };
    const pushFromString = (raw) => {
        const value = raw.trim();
        if (!value)
            return;
        const directPath = (0, exports.normalizeHostedRelativePath)(value);
        if (/^(posts|AVATAR|avatars)\//i.test(directPath)) {
            pushPath(directPath);
            return;
        }
        if (/^https?:\/\//i.test(value)) {
            try {
                const urlObj = new URL(value);
                const baseObj = new URL(publicBase);
                if (urlObj.origin !== baseObj.origin)
                    return;
                const basePath = (0, exports.normalizeHostedRelativePath)(baseObj.pathname);
                let relativePath = (0, exports.normalizeHostedRelativePath)(urlObj.pathname);
                if (basePath && relativePath.toLowerCase().startsWith(`${basePath.toLowerCase()}/`)) {
                    relativePath = relativePath.slice(basePath.length + 1);
                }
                else if (relativePath.toLowerCase().startsWith('images/')) {
                    relativePath = relativePath.slice('images/'.length);
                }
                else if (relativePath.toLowerCase().startsWith('imagenes/')) {
                    relativePath = relativePath.slice('imagenes/'.length);
                }
                if (relativePath) {
                    pushPath(decodeURIComponent(relativePath));
                }
            }
            catch (_a) {
                const base = publicBase.replace(/\/+$/, '');
                if (value.startsWith(`${base}/`)) {
                    pushPath(decodeURIComponent(value.slice(base.length + 1)));
                }
            }
        }
    };
    const visit = (entry) => {
        if (!entry)
            return;
        if (typeof entry === 'string') {
            pushFromString(entry);
            return;
        }
        if (Array.isArray(entry)) {
            for (const item of entry)
                visit(item);
            return;
        }
        if (typeof entry === 'object') {
            const imageEntry = entry;
            if (typeof imageEntry.path === 'string') {
                pushPath(imageEntry.path);
            }
            if (typeof imageEntry.thumbPath === 'string') {
                pushPath(imageEntry.thumbPath);
            }
            if (typeof imageEntry.url === 'string') {
                pushFromString(imageEntry.url);
            }
            for (const value of Object.values(imageEntry)) {
                visit(value);
            }
        }
    };
    visit(value);
    return Array.from(results);
};
exports.extractHostedRelativePaths = extractHostedRelativePaths;
const buildHostingPathSet = (entries) => {
    return new Set(entries.filter((entry) => typeof entry === 'string' && !!entry));
};
exports.buildHostingPathSet = buildHostingPathSet;
const markHostingDocPaths = (set, docData) => {
    if (typeof docData.path === 'string')
        set.add((0, exports.normalizeHostedRelativePath)(docData.path));
    if (typeof docData.thumbPath === 'string')
        set.add((0, exports.normalizeHostedRelativePath)(docData.thumbPath));
};
exports.markHostingDocPaths = markHostingDocPaths;
const deriveHostingThumbRelativePath = (relativePath) => {
    const normalized = (0, exports.normalizeHostedRelativePath)(relativePath);
    if (!normalized)
        return null;
    const ext = path.posix.extname(normalized);
    if (!ext)
        return null;
    const dir = path.posix.dirname(normalized);
    const baseName = path.posix.basename(normalized, ext);
    if (baseName.endsWith('_t') || baseName.endsWith('_') || baseName.endsWith('-thumb')) {
        return normalized;
    }
    if (baseName.endsWith('_o')) {
        return path.posix.join(dir, `${baseName.slice(0, -2)}_t${ext}`);
    }
    return path.posix.join(dir, `${baseName}_${ext}`);
};
exports.deriveHostingThumbRelativePath = deriveHostingThumbRelativePath;
const cleanupHostingRelativePath = async (ftpClient, ftpConfig, relativePath) => {
    const cleaned = (0, exports.normalizeHostedRelativePath)(relativePath);
    if (!cleaned || cleaned.includes('..'))
        return false;
    const remotePath = `${ftpConfig.basePath}/${cleaned}`.replace(/\/+/g, '/');
    try {
        await ftpClient.remove(remotePath);
        return true;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not found|no such file|550/i.test(message)) {
            console.warn(`No se pudo borrar archivo remoto ${cleaned}:`, error);
        }
        return false;
    }
};
exports.cleanupHostingRelativePath = cleanupHostingRelativePath;
const cleanupCommunityPostHostingMedia = async (postData) => {
    var _a, _b, _c, _d, _e;
    const publicBaseUrl = process.env.HOSTING_PUBLIC_BASE_URL || 'https://bot.cdelu.io/images';
    const ftpConfig = (0, exports.getHostingFtpConfig)();
    const paths = new Set();
    const addPaths = (value) => {
        for (const candidate of (0, exports.extractHostedRelativePaths)(value, publicBaseUrl)) {
            paths.add(candidate);
        }
    };
    addPaths(postData.imagesV2);
    addPaths(postData.images);
    addPaths(postData.imgMiniatura);
    addPaths(postData.img_miniatura);
    addPaths(postData.thumbnail);
    addPaths(postData.thumbnailUrl);
    addPaths(postData.coverThumbnailUrl);
    addPaths((_a = postData.custom_fields) === null || _a === void 0 ? void 0 : _a.image);
    addPaths((_b = postData.custom_fields) === null || _b === void 0 ? void 0 : _b.imgMiniatura);
    addPaths((_c = postData.custom_fields) === null || _c === void 0 ? void 0 : _c.img_miniatura);
    addPaths((_d = postData.custom_fields) === null || _d === void 0 ? void 0 : _d.thumbnail);
    addPaths((_e = postData.custom_fields) === null || _e === void 0 ? void 0 : _e.thumbnailUrl);
    for (const imageEntry of Array.isArray(postData.imagesV2) ? postData.imagesV2 : []) {
        if (!imageEntry || typeof imageEntry !== 'object')
            continue;
        const entry = imageEntry;
        if (typeof entry.path === 'string')
            paths.add((0, exports.normalizeHostedRelativePath)(entry.path));
        if (typeof entry.thumbPath === 'string')
            paths.add((0, exports.normalizeHostedRelativePath)(entry.thumbPath));
    }
    const derivedThumbs = Array.from(paths)
        .map((relativePath) => (0, exports.deriveHostingThumbRelativePath)(relativePath))
        .filter((relativePath) => Boolean(relativePath));
    for (const relativePath of derivedThumbs) {
        paths.add(relativePath);
    }
    const { Client } = await (0, exports.loadFtpClient)();
    const ftpClient = new Client(30000);
    ftpClient.ftp.verbose = false;
    try {
        await ftpClient.access({
            host: ftpConfig.host,
            user: ftpConfig.user,
            password: ftpConfig.password,
            port: ftpConfig.port,
            secure: false
        });
        for (const relativePath of paths) {
            await (0, exports.cleanupHostingRelativePath)(ftpClient, ftpConfig, relativePath);
        }
    }
    finally {
        ftpClient.close();
    }
};
exports.cleanupCommunityPostHostingMedia = cleanupCommunityPostHostingMedia;
//# sourceMappingURL=hostingUtils.js.map