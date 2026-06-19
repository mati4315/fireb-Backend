"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onCommunityPostsReceivedInternal = exports.getContentFingerprint = exports.onOfficialNewsReceivedInternal = void 0;
const admin = require("firebase-admin");
const contentUtils_1 = require("./contentUtils");
const parseDateCandidate = (value) => {
    if (!value)
        return null;
    if (value instanceof admin.firestore.Timestamp)
        return value;
    if (value instanceof Date && !isNaN(value.getTime())) {
        return admin.firestore.Timestamp.fromDate(value);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        const asMs = value > 1e12 ? value : value * 1000;
        const parsedNumeric = new Date(asMs);
        if (!isNaN(parsedNumeric.getTime())) {
            return admin.firestore.Timestamp.fromDate(parsedNumeric);
        }
        return null;
    }
    if (typeof value !== 'string')
        return null;
    const raw = value.trim();
    if (!raw)
        return null;
    const parsedNative = new Date(raw);
    if (!isNaN(parsedNative.getTime())) {
        return admin.firestore.Timestamp.fromDate(parsedNative);
    }
    const isoLike = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (isoLike) {
        const [, y, m, d, h, min, s] = isoLike;
        const parsedIsoLike = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s || '0'));
        if (!isNaN(parsedIsoLike.getTime())) {
            return admin.firestore.Timestamp.fromDate(parsedIsoLike);
        }
    }
    const latamLike = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (latamLike) {
        const [, d, m, y, h, min, s] = latamLike;
        const parsedLatam = new Date(Number(y), Number(m) - 1, Number(d), Number(h || '0'), Number(min || '0'), Number(s || '0'));
        if (!isNaN(parsedLatam.getTime())) {
            return admin.firestore.Timestamp.fromDate(parsedLatam);
        }
    }
    return null;
};
const normalizeUrlCandidate = (value) => {
    if (typeof value !== 'string')
        return '';
    return value.trim().slice(0, 2400);
};
const onOfficialNewsReceivedInternal = async (db, change, context) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    const { newsId } = context.params;
    const afterData = change.after.val();
    if (!afterData) {
        console.log(`News ${newsId} was deleted from RTDB. Ignoring in Firestore. (Idempotency)`);
        return null;
    }
    try {
        const contentRef = db.collection('content').doc(newsId);
        const existingSnap = await contentRef.get();
        const existingCreatedAt = existingSnap.exists ? (_a = existingSnap.data()) === null || _a === void 0 ? void 0 : _a.createdAt : null;
        const createdCandidates = [
            afterData.createdAt,
            afterData.created_at,
            afterData.date,
            afterData.postDate,
            afterData.post_date,
            (_b = afterData.custom_fields) === null || _b === void 0 ? void 0 : _b.createdAt,
            (_c = afterData.custom_fields) === null || _c === void 0 ? void 0 : _c.date
        ];
        const updatedCandidates = [
            afterData.updatedAt,
            afterData.updated_at,
            afterData.modified,
            afterData.modifiedAt,
            (_d = afterData.custom_fields) === null || _d === void 0 ? void 0 : _d.updatedAt,
            (_e = afterData.custom_fields) === null || _e === void 0 ? void 0 : _e.modified
        ];
        let parsedCreatedAt = null;
        for (const candidate of createdCandidates) {
            parsedCreatedAt = parseDateCandidate(candidate);
            if (parsedCreatedAt)
                break;
        }
        let parsedUpdatedAt = null;
        for (const candidate of updatedCandidates) {
            parsedUpdatedAt = parseDateCandidate(candidate);
            if (parsedUpdatedAt)
                break;
        }
        const createdAtTs = parsedCreatedAt ||
            (existingCreatedAt instanceof admin.firestore.Timestamp
                ? existingCreatedAt
                : admin.firestore.FieldValue.serverTimestamp());
        const updatedAtTs = parsedUpdatedAt || admin.firestore.FieldValue.serverTimestamp();
        const normalizedPostId = (0, contentUtils_1.extractNewsPublicIdFromPayload)(afterData);
        const postIdNumber = normalizedPostId ? Number(normalizedPostId) : null;
        const coverThumbnailUrl = [
            normalizeUrlCandidate(afterData.img_miniatura),
            normalizeUrlCandidate(afterData.imgMiniatura),
            normalizeUrlCandidate(afterData.thumbnail),
            normalizeUrlCandidate(afterData.thumbnailUrl),
            normalizeUrlCandidate(afterData.coverThumbnailUrl),
            normalizeUrlCandidate((_f = afterData.custom_fields) === null || _f === void 0 ? void 0 : _f.img_miniatura),
            normalizeUrlCandidate((_g = afterData.custom_fields) === null || _g === void 0 ? void 0 : _g.thumbnail),
            normalizeUrlCandidate((_h = afterData.custom_fields) === null || _h === void 0 ? void 0 : _h.thumbnailUrl)
        ].find((value) => value.length > 0) || '';
        const rawImages = Array.isArray(afterData.images)
            ? afterData.images
            : [afterData.image, afterData.imageUrl, afterData.coverImage, (_j = afterData.custom_fields) === null || _j === void 0 ? void 0 : _j.image];
        const normalizedImages = Array.from(new Set(rawImages
            .map((value) => normalizeUrlCandidate(value))
            .filter((value) => value.length > 0)));
        if (normalizedImages.length === 0 && coverThumbnailUrl) {
            normalizedImages.push(coverThumbnailUrl);
        }
        const imagesV2 = normalizedImages.map((url, index) => ({
            url,
            thumbUrl: index === 0 && coverThumbnailUrl ? coverThumbnailUrl : url
        }));
        const firestorePayload = {
            type: 'news',
            source: 'wordpress',
            module: 'news',
            externalId: newsId,
            externalSource: 'wordpress_plugin',
            postId: postIdNumber,
            publicId: normalizedPostId,
            titulo: afterData.titulo || 'Sin Titulo',
            descripcion: afterData.descripcion || '',
            images: normalizedImages,
            imagesV2,
            imgMiniatura: coverThumbnailUrl,
            userId: afterData.userId || 'wp_official',
            userName: afterData.userName || 'Redaccion CdeluAR',
            userProfilePicUrl: afterData.userProfilePicUrl || '',
            stats: {
                likesCount: ((_k = afterData.stats) === null || _k === void 0 ? void 0 : _k.likesCount) || 0,
                commentsCount: ((_l = afterData.stats) === null || _l === void 0 ? void 0 : _l.commentsCount) || 0,
                viewsCount: ((_m = afterData.stats) === null || _m === void 0 ? void 0 : _m.viewsCount) || 0
            },
            createdAt: createdAtTs,
            updatedAt: updatedAtTs,
            deletedAt: null,
            isOficial: true,
            originalUrl: afterData.originalUrl || '',
            category: afterData.category || '',
            tags: Array.isArray(afterData.tags) ? afterData.tags : [],
            custom_fields: afterData.custom_fields || {},
            ingestedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('content').doc(newsId).set(firestorePayload, { merge: true });
        if (normalizedPostId) {
            const publicKey = (0, contentUtils_1.buildContentPublicIdKey)('news', normalizedPostId);
            await db.collection('_content_public_ids').doc(publicKey).set({
                contentId: newsId,
                module: 'news',
                publicId: normalizedPostId,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
        return null;
    }
    catch (error) {
        console.error(`Failed RTDB news sync for ${newsId}:`, error);
        return null;
    }
};
exports.onOfficialNewsReceivedInternal = onOfficialNewsReceivedInternal;
const getContentFingerprint = (text) => {
    if (!text)
        return '';
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // remove accents / diacritics
        .replace(/[^a-z0-9]/g, '') // keep only alphanumeric
        .substring(0, 60); // first 60 characters
};
exports.getContentFingerprint = getContentFingerprint;
const onCommunityPostsReceivedInternal = async (db, change, context) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    const { postId } = context.params;
    const afterData = change.after.val();
    if (!afterData)
        return null;
    if (postId.startsWith('__') && postId.endsWith('__'))
        return null;
    // Deduplication check:
    // If there's an existing post with similar normalized content and same userName, discard this one as a duplicate.
    const checkContent = (afterData.content || '').trim();
    const checkUserName = (afterData.author_name || '').trim();
    if (checkContent.length > 10 && checkUserName) {
        try {
            const fingerprint = (0, exports.getContentFingerprint)(checkContent);
            // 1. Query by normalized fingerprint
            let existingQuery = await db.collection('content')
                .where('module', '==', 'community')
                .where('userName', '==', checkUserName)
                .where('contentFingerprint', '==', fingerprint)
                .get();
            // Fallback: query by exact content if fingerprint query yielded nothing
            // (ensures compatibility with historical posts that don't have the fingerprint field yet)
            if (existingQuery.empty) {
                existingQuery = await db.collection('content')
                    .where('module', '==', 'community')
                    .where('userName', '==', checkUserName)
                    .where('descripcion', '==', checkContent)
                    .get();
            }
            const parsedCreatedAt = parseDateCandidate(afterData.createdAt);
            const incomingMs = parsedCreatedAt ? parsedCreatedAt.toMillis() : Date.now();
            const duplicateDocs = existingQuery.docs.filter(doc => {
                if (doc.id === postId)
                    return false;
                // Time window check: only count as duplicate if created within 7 days of each other
                const docData = doc.data();
                const parsedDocCreatedAt = parseDateCandidate(docData.createdAt);
                if (parsedDocCreatedAt) {
                    const docMs = parsedDocCreatedAt.toMillis();
                    if (Math.abs(docMs - incomingMs) > 7 * 24 * 60 * 60 * 1000) {
                        return false; // outside 7-day window
                    }
                }
                return true;
            });
            if (duplicateDocs.length > 0) {
                console.log(`[Deduplication] Detected duplicate community post for postId: ${postId} (existing ID: ${duplicateDocs[0].id}). Cleaning up RTDB and ignoring.`);
                // Remove duplicate from RTDB
                await change.after.ref.remove();
                // Also delete from Firestore if it exists
                await db.collection('content').doc(postId).delete();
                return null;
            }
        }
        catch (e) {
            console.error('[Deduplication] Error querying duplicates:', e);
        }
    }
    try {
        const contentRef = db.collection('content').doc(postId);
        const existingSnap = await contentRef.get();
        const existingCreatedAt = existingSnap.exists ? (_a = existingSnap.data()) === null || _a === void 0 ? void 0 : _a.createdAt : null;
        const parsedCreatedAt = parseDateCandidate(afterData.createdAt);
        const parsedUpdatedAt = parseDateCandidate(afterData.updatedAt);
        const createdAtTs = parsedCreatedAt ||
            (existingCreatedAt instanceof admin.firestore.Timestamp
                ? existingCreatedAt
                : admin.firestore.FieldValue.serverTimestamp());
        const updatedAtTs = parsedUpdatedAt || admin.firestore.FieldValue.serverTimestamp();
        const normalizeImageEntry = (entry) => {
            if (typeof entry === 'string') {
                const url = normalizeUrlCandidate(entry);
                return url ? { url, thumbUrl: null } : null;
            }
            if (!entry || typeof entry !== 'object')
                return null;
            const imageEntry = entry;
            const url = normalizeUrlCandidate(imageEntry.url);
            if (!url)
                return null;
            const thumbCandidate = normalizeUrlCandidate(imageEntry.thumbUrl) ||
                normalizeUrlCandidate(imageEntry.thumbnailUrl) ||
                normalizeUrlCandidate(imageEntry.thumbnail) ||
                normalizeUrlCandidate(imageEntry.imgMiniatura) ||
                normalizeUrlCandidate(imageEntry.img_miniatura) ||
                null;
            return { url, thumbUrl: thumbCandidate && thumbCandidate !== url ? thumbCandidate : null };
        };
        const explicitImagesV2 = Array.isArray(afterData.imagesV2)
            ? afterData.imagesV2
                .map((entry) => normalizeImageEntry(entry))
                .filter((entry) => Boolean(entry))
            : [];
        const fallbackImageEntries = [
            ...(Array.isArray(afterData.images) ? afterData.images : []),
            afterData.image,
            afterData.imageUrl,
            afterData.coverImage,
            afterData.imgMiniatura,
            afterData.img_miniatura,
            afterData.thumbnail,
            afterData.thumbnailUrl,
            afterData.coverThumbnailUrl,
            (_b = afterData.custom_fields) === null || _b === void 0 ? void 0 : _b.image,
            (_c = afterData.custom_fields) === null || _c === void 0 ? void 0 : _c.imgMiniatura,
            (_d = afterData.custom_fields) === null || _d === void 0 ? void 0 : _d.img_miniatura,
            (_e = afterData.custom_fields) === null || _e === void 0 ? void 0 : _e.thumbnail,
            (_f = afterData.custom_fields) === null || _f === void 0 ? void 0 : _f.thumbnailUrl
        ]
            .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
            .map((entry) => normalizeImageEntry(entry))
            .filter((entry) => Boolean(entry));
        const mergedImages = [...explicitImagesV2, ...fallbackImageEntries];
        const normalizedImages = Array.from(new Set(mergedImages.map((entry) => entry.url))).filter((value) => value.length > 0);
        const legacyMiniThumb = normalizeUrlCandidate(afterData.imgMiniatura) ||
            normalizeUrlCandidate(afterData.img_miniatura) ||
            normalizeUrlCandidate(afterData.thumbnailUrl) ||
            normalizeUrlCandidate(afterData.coverThumbnailUrl) ||
            normalizeUrlCandidate((_g = afterData.custom_fields) === null || _g === void 0 ? void 0 : _g.imgMiniatura) ||
            normalizeUrlCandidate((_h = afterData.custom_fields) === null || _h === void 0 ? void 0 : _h.img_miniatura) ||
            normalizeUrlCandidate((_j = afterData.custom_fields) === null || _j === void 0 ? void 0 : _j.thumbnailUrl) ||
            '';
        const imagesV2 = normalizedImages.map((url, index) => {
            const matched = mergedImages.find((entry) => entry.url === url);
            const thumbUrl = (matched === null || matched === void 0 ? void 0 : matched.thumbUrl) || (index === 0 && legacyMiniThumb ? legacyMiniThumb : null) || url;
            return { url, thumbUrl };
        });
        const imgMiniatura = legacyMiniThumb || ((_k = imagesV2[0]) === null || _k === void 0 ? void 0 : _k.thumbUrl) || normalizedImages[0] || '';
        const firestorePayload = {
            type: 'post',
            source: 'scraping',
            module: 'community',
            externalId: postId,
            id_unico: afterData.id_unico || postId,
            titulo: afterData.author_name || 'Comunidad',
            descripcion: afterData.content || '',
            contentFingerprint: (0, exports.getContentFingerprint)(afterData.content || ''),
            images: normalizedImages,
            imagesV2,
            imgMiniatura,
            userId: afterData.author_id || 'community_user',
            userName: afterData.author_name || 'Usuario Comunidad',
            userProfilePicUrl: '',
            group_name: afterData.group_name || '',
            group_url: afterData.group_url || '',
            video_links: Array.isArray(afterData.video_links) ? afterData.video_links : [],
            stats: {
                likesCount: ((_l = afterData.stats) === null || _l === void 0 ? void 0 : _l.likesCount) || 0,
                commentsCount: ((_m = afterData.stats) === null || _m === void 0 ? void 0 : _m.commentsCount) || 0,
                viewsCount: ((_o = afterData.stats) === null || _o === void 0 ? void 0 : _o.viewsCount) || 0
            },
            createdAt: createdAtTs,
            updatedAt: updatedAtTs,
            deletedAt: afterData.deletedAt || null,
            isOficial: false,
            originalUrl: afterData.post_url || '',
            category: afterData.group_name || 'Comunidad',
            tags: Array.isArray(afterData.tags) ? afterData.tags : [],
            custom_fields: afterData.custom_fields || {},
            ingestedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('content').doc(postId).set(firestorePayload, { merge: true });
        return null;
    }
    catch (error) {
        console.error(`Failed community sync for ${postId}:`, error);
        return null;
    }
};
exports.onCommunityPostsReceivedInternal = onCommunityPostsReceivedInternal;
//# sourceMappingURL=contentSyncRuntimeUtils.js.map