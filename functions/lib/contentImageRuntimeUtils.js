"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadCommunityImageToHostingInternal = exports.onCommunityPostImageFinalizedInternal = void 0;
const admin = require("firebase-admin");
const functions = require("firebase-functions");
const path = require("path");
const stream_1 = require("stream");
const hostingUtils_1 = require("./hostingUtils");
const hostingUtils_2 = require("./hostingUtils");
const COMMUNITY_THUMB_MAX_SIDE = 480;
const COMMUNITY_THUMBNAIL_BUCKET = process.env.COMMUNITY_IMAGES_BUCKET || 'cdeluar-ddefc-storage';
const onCommunityPostImageFinalizedInternal = async (object) => {
    const filePath = object.name;
    const contentType = object.contentType || '';
    const bucketName = object.bucket;
    const metadata = object.metadata || {};
    if (!filePath || !bucketName)
        return null;
    if (!filePath.startsWith('posts/'))
        return null;
    if (!contentType.startsWith('image/'))
        return null;
    if (filePath.includes('/thumbs/'))
        return null;
    if (metadata.generatedBy === 'community-thumbnail')
        return null;
    const ext = filePath.split('.').pop() ? `.${String(filePath).split('.').pop()}` : '';
    const baseName = filePath
        .slice(filePath.lastIndexOf('/') + 1)
        .replace(new RegExp(`${ext}$`), '');
    if (baseName.endsWith('_t') || baseName.endsWith('-thumb'))
        return null;
    const directory = filePath.slice(0, filePath.lastIndexOf('/'));
    const thumbPath = `${directory}/thumbs/${baseName}.webp`;
    const bucket = admin.storage().bucket(bucketName || COMMUNITY_THUMBNAIL_BUCKET);
    const thumbFile = bucket.file(thumbPath);
    const [alreadyExists] = await thumbFile.exists();
    if (alreadyExists)
        return null;
    const sourceTempFile = `${process.env.TMP || process.env.TEMP || 'C:\\tmp'}\\${Date.now()}-${baseName}`;
    const thumbTempFile = `${process.env.TMP || process.env.TEMP || 'C:\\tmp'}\\${Date.now()}-${baseName}.webp`;
    try {
        await bucket.file(filePath).download({ destination: sourceTempFile });
        const sharp = await (0, hostingUtils_2.loadSharp)();
        await sharp(sourceTempFile)
            .rotate()
            .resize(COMMUNITY_THUMB_MAX_SIDE, COMMUNITY_THUMB_MAX_SIDE, {
            fit: 'inside',
            withoutEnlargement: true
        })
            .webp({ quality: 78, effort: 4 })
            .toFile(thumbTempFile);
        await bucket.upload(thumbTempFile, {
            destination: thumbPath,
            metadata: {
                contentType: 'image/webp',
                cacheControl: 'public,max-age=604800',
                metadata: {
                    generatedBy: 'community-thumbnail',
                    sourcePath: filePath
                }
            }
        });
    }
    catch (error) {
        console.error('Thumbnail generation failed', { filePath, error });
    }
    finally {
        await Promise.allSettled([
            Promise.resolve().then(() => require('node:fs/promises')).then((fs) => fs.unlink(sourceTempFile)).catch(() => undefined),
            Promise.resolve().then(() => require('node:fs/promises')).then((fs) => fs.unlink(thumbTempFile)).catch(() => undefined)
        ]);
    }
    return null;
};
exports.onCommunityPostImageFinalizedInternal = onCommunityPostImageFinalizedInternal;
const uploadCommunityImageToHostingInternal = async (data, context) => {
    var _a;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para subir imagenes.');
    }
    const relativePathRaw = typeof (data === null || data === void 0 ? void 0 : data.path) === 'string' ? data.path.trim() : '';
    const contentType = (0, hostingUtils_1.ensureImageMime)(data === null || data === void 0 ? void 0 : data.contentType);
    const base64Data = (0, hostingUtils_1.decodeBase64Payload)(data === null || data === void 0 ? void 0 : data.base64Data);
    if (!relativePathRaw) {
        throw new functions.https.HttpsError('invalid-argument', 'Ruta de imagen invalida.');
    }
    const relativePath = (0, hostingUtils_1.sanitizePathSegment)(relativePathRaw).replace(/^(?:imagenes|images)\//, '');
    const allowedPrefix = `posts/${userId}/`;
    const allowedAvatarPrefix = `AVATAR/${userId}/`;
    const legacyAvatarPrefix = `avatars/${userId}/`;
    if (!relativePath.startsWith(allowedPrefix) &&
        !relativePath.startsWith(allowedAvatarPrefix) &&
        !relativePath.startsWith(legacyAvatarPrefix)) {
        throw new functions.https.HttpsError('permission-denied', 'Ruta de subida no permitida.');
    }
    const ext = path.posix.extname(relativePath).toLowerCase();
    const safeExt = ext && ext.length <= 6 ? ext : '.webp';
    const fileNameBase = path.posix.basename(relativePath, ext || undefined)
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .slice(0, 80) || `${Date.now()}`;
    const normalizedUploadPath = relativePath.startsWith(legacyAvatarPrefix)
        ? relativePath.replace(/^avatars\//, 'AVATAR/')
        : relativePath;
    const targetRelativePath = `${path.posix.dirname(normalizedUploadPath)}/${fileNameBase}${safeExt}`.replace(/\/+/g, '/');
    const isAvatarUpload = normalizedUploadPath.startsWith(allowedAvatarPrefix) ||
        normalizedUploadPath.startsWith('AVATAR/');
    const ftpConfig = isAvatarUpload ? (0, hostingUtils_1.getHostingAvatarFtpConfig)() : (0, hostingUtils_1.getHostingFtpConfig)();
    const remoteFilePath = `${ftpConfig.basePath}/${targetRelativePath}`.replace(/\/+/g, '/');
    const remoteDir = path.posix.dirname(remoteFilePath);
    const publicUrl = `${ftpConfig.publicBaseUrl}/${targetRelativePath}`;
    const { Client } = await (0, hostingUtils_1.loadFtpClient)();
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
        await ftpClient.ensureDir(remoteDir);
        await ftpClient.uploadFrom(stream_1.Readable.from(base64Data), remoteFilePath);
    }
    catch (error) {
        console.error('FTP hosting upload failed', { userId, relativePath: targetRelativePath, error });
        throw new functions.https.HttpsError('internal', 'No se pudo subir la imagen al hosting.');
    }
    finally {
        ftpClient.close();
    }
    return {
        url: publicUrl,
        path: targetRelativePath,
        sizeBytes: base64Data.length,
        contentType
    };
};
exports.uploadCommunityImageToHostingInternal = uploadCommunityImageToHostingInternal;
//# sourceMappingURL=contentImageRuntimeUtils.js.map