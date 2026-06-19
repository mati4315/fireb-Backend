import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { buildContentPublicIdKey, extractNewsPublicIdFromPayload } from './contentUtils';

const parseDateCandidate = (value: unknown): admin.firestore.Timestamp | null => {
  if (!value) return null;
  if (value instanceof admin.firestore.Timestamp) return value;
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
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;

  const parsedNative = new Date(raw);
  if (!isNaN(parsedNative.getTime())) {
    return admin.firestore.Timestamp.fromDate(parsedNative);
  }

  const isoLike = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (isoLike) {
    const [, y, m, d, h, min, s] = isoLike;
    const parsedIsoLike = new Date(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(h),
      Number(min),
      Number(s || '0')
    );
    if (!isNaN(parsedIsoLike.getTime())) {
      return admin.firestore.Timestamp.fromDate(parsedIsoLike);
    }
  }

  const latamLike = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (latamLike) {
    const [, d, m, y, h, min, s] = latamLike;
    const parsedLatam = new Date(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(h || '0'),
      Number(min || '0'),
      Number(s || '0')
    );
    if (!isNaN(parsedLatam.getTime())) {
      return admin.firestore.Timestamp.fromDate(parsedLatam);
    }
  }

  return null;
};

const normalizeUrlCandidate = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 2400);
};

export const onOfficialNewsReceivedInternal = async (
  db: FirebaseFirestore.Firestore,
  change: functions.Change<admin.database.DataSnapshot>,
  context: functions.EventContext
): Promise<null> => {
  const { newsId } = context.params as { newsId: string };
  const afterData = change.after.val();

  if (!afterData) {
    console.log(`News ${newsId} was deleted from RTDB. Ignoring in Firestore. (Idempotency)`);
    return null;
  }

  try {
    const contentRef = db.collection('content').doc(newsId);
    const existingSnap = await contentRef.get();
    const existingCreatedAt = existingSnap.exists ? existingSnap.data()?.createdAt : null;

    const createdCandidates: unknown[] = [
      afterData.createdAt,
      afterData.created_at,
      afterData.date,
      afterData.postDate,
      afterData.post_date,
      afterData.custom_fields?.createdAt,
      afterData.custom_fields?.date
    ];
    const updatedCandidates: unknown[] = [
      afterData.updatedAt,
      afterData.updated_at,
      afterData.modified,
      afterData.modifiedAt,
      afterData.custom_fields?.updatedAt,
      afterData.custom_fields?.modified
    ];

    let parsedCreatedAt: admin.firestore.Timestamp | null = null;
    for (const candidate of createdCandidates) {
      parsedCreatedAt = parseDateCandidate(candidate);
      if (parsedCreatedAt) break;
    }

    let parsedUpdatedAt: admin.firestore.Timestamp | null = null;
    for (const candidate of updatedCandidates) {
      parsedUpdatedAt = parseDateCandidate(candidate);
      if (parsedUpdatedAt) break;
    }

    const createdAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp =
      parsedCreatedAt ||
      (existingCreatedAt instanceof admin.firestore.Timestamp
        ? existingCreatedAt
        : admin.firestore.FieldValue.serverTimestamp());
    const updatedAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp =
      parsedUpdatedAt || admin.firestore.FieldValue.serverTimestamp();

    const normalizedPostId = extractNewsPublicIdFromPayload(afterData);
    const postIdNumber = normalizedPostId ? Number(normalizedPostId) : null;
    const coverThumbnailUrl = [
      normalizeUrlCandidate(afterData.img_miniatura),
      normalizeUrlCandidate(afterData.imgMiniatura),
      normalizeUrlCandidate(afterData.thumbnail),
      normalizeUrlCandidate(afterData.thumbnailUrl),
      normalizeUrlCandidate(afterData.coverThumbnailUrl),
      normalizeUrlCandidate(afterData.custom_fields?.img_miniatura),
      normalizeUrlCandidate(afterData.custom_fields?.thumbnail),
      normalizeUrlCandidate(afterData.custom_fields?.thumbnailUrl)
    ].find((value) => value.length > 0) || '';

    const rawImages = Array.isArray(afterData.images)
      ? afterData.images
      : [afterData.image, afterData.imageUrl, afterData.coverImage, afterData.custom_fields?.image];
    const normalizedImages = Array.from(
      new Set(
        rawImages
          .map((value: unknown) => normalizeUrlCandidate(value))
          .filter((value: string) => value.length > 0)
      )
    );
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
        likesCount: afterData.stats?.likesCount || 0,
        commentsCount: afterData.stats?.commentsCount || 0,
        viewsCount: afterData.stats?.viewsCount || 0
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
      const publicKey = buildContentPublicIdKey('news', normalizedPostId);
      await db.collection('_content_public_ids').doc(publicKey).set(
        {
          contentId: newsId,
          module: 'news',
          publicId: normalizedPostId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }

    return null;
  } catch (error) {
    console.error(`Failed RTDB news sync for ${newsId}:`, error);
    return null;
  }
};

export const onCommunityPostsReceivedInternal = async (
  db: FirebaseFirestore.Firestore,
  change: functions.Change<admin.database.DataSnapshot>,
  context: functions.EventContext
): Promise<null> => {
  const { postId } = context.params as { postId: string };
  const afterData = change.after.val();

  if (!afterData) return null;
  if (postId.startsWith('__') && postId.endsWith('__')) return null;

  // Deduplication check:
  // If there's an existing post with the same description and userName, discard this one as a duplicate.
  const checkContent = (afterData.content || '').trim();
  const checkUserName = (afterData.author_name || '').trim();
  if (checkContent.length > 10 && checkUserName) {
    try {
      const existingQuery = await db.collection('content')
        .where('module', '==', 'community')
        .where('userName', '==', checkUserName)
        .where('descripcion', '==', checkContent)
        .get();

      const duplicateDocs = existingQuery.docs.filter(doc => doc.id !== postId);
      if (duplicateDocs.length > 0) {
        console.log(`[Deduplication] Detected duplicate community post for postId: ${postId} (existing ID: ${duplicateDocs[0].id}). Cleaning up RTDB and ignoring.`);
        
        // Remove duplicate from RTDB
        await change.after.ref.remove();

        // Also delete from Firestore if it exists
        await db.collection('content').doc(postId).delete();
        
        return null;
      }
    } catch (e) {
      console.error('[Deduplication] Error querying duplicates:', e);
    }
  }

  try {
    const contentRef = db.collection('content').doc(postId);
    const existingSnap = await contentRef.get();
    const existingCreatedAt = existingSnap.exists ? existingSnap.data()?.createdAt : null;

    const parsedCreatedAt = parseDateCandidate(afterData.createdAt);
    const parsedUpdatedAt = parseDateCandidate(afterData.updatedAt);

    const createdAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp =
      parsedCreatedAt ||
      (existingCreatedAt instanceof admin.firestore.Timestamp
        ? existingCreatedAt
        : admin.firestore.FieldValue.serverTimestamp());
    const updatedAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp =
      parsedUpdatedAt || admin.firestore.FieldValue.serverTimestamp();

    const normalizeImageEntry = (entry: unknown): { url: string; thumbUrl: string | null } | null => {
      if (typeof entry === 'string') {
        const url = normalizeUrlCandidate(entry);
        return url ? { url, thumbUrl: null } : null;
      }
      if (!entry || typeof entry !== 'object') return null;
      const imageEntry = entry as Record<string, unknown>;
      const url = normalizeUrlCandidate(imageEntry.url);
      if (!url) return null;
      const thumbCandidate =
        normalizeUrlCandidate(imageEntry.thumbUrl) ||
        normalizeUrlCandidate(imageEntry.thumbnailUrl) ||
        normalizeUrlCandidate(imageEntry.thumbnail) ||
        normalizeUrlCandidate(imageEntry.imgMiniatura) ||
        normalizeUrlCandidate(imageEntry.img_miniatura) ||
        null;
      return { url, thumbUrl: thumbCandidate && thumbCandidate !== url ? thumbCandidate : null };
    };

    const explicitImagesV2 = Array.isArray(afterData.imagesV2)
      ? afterData.imagesV2
          .map((entry: unknown) => normalizeImageEntry(entry))
          .filter(
            (entry: { url: string; thumbUrl: string | null } | null): entry is {
              url: string;
              thumbUrl: string | null;
            } => Boolean(entry)
          )
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
      afterData.custom_fields?.image,
      afterData.custom_fields?.imgMiniatura,
      afterData.custom_fields?.img_miniatura,
      afterData.custom_fields?.thumbnail,
      afterData.custom_fields?.thumbnailUrl
    ]
      .flatMap((entry: unknown) => (Array.isArray(entry) ? entry : [entry]))
      .map((entry: unknown) => normalizeImageEntry(entry))
      .filter((entry): entry is { url: string; thumbUrl: string | null } => Boolean(entry));

    const mergedImages = [...explicitImagesV2, ...fallbackImageEntries];
    const normalizedImages = Array.from(new Set(mergedImages.map((entry) => entry.url))).filter(
      (value: string) => value.length > 0
    );
    const legacyMiniThumb =
      normalizeUrlCandidate(afterData.imgMiniatura) ||
      normalizeUrlCandidate(afterData.img_miniatura) ||
      normalizeUrlCandidate(afterData.thumbnailUrl) ||
      normalizeUrlCandidate(afterData.coverThumbnailUrl) ||
      normalizeUrlCandidate(afterData.custom_fields?.imgMiniatura) ||
      normalizeUrlCandidate(afterData.custom_fields?.img_miniatura) ||
      normalizeUrlCandidate(afterData.custom_fields?.thumbnailUrl) ||
      '';
    const imagesV2 = normalizedImages.map((url, index) => {
      const matched = mergedImages.find((entry: { url: string; thumbUrl: string | null }) => entry.url === url);
      const thumbUrl = matched?.thumbUrl || (index === 0 && legacyMiniThumb ? legacyMiniThumb : null) || url;
      return { url, thumbUrl };
    });
    const imgMiniatura = legacyMiniThumb || imagesV2[0]?.thumbUrl || normalizedImages[0] || '';

    const firestorePayload = {
      type: 'post',
      source: 'scraping',
      module: 'community',
      externalId: postId,
      id_unico: afterData.id_unico || postId,
      titulo: afterData.author_name || 'Comunidad',
      descripcion: afterData.content || '',
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
        likesCount: afterData.stats?.likesCount || 0,
        commentsCount: afterData.stats?.commentsCount || 0,
        viewsCount: afterData.stats?.viewsCount || 0
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
  } catch (error) {
    console.error(`Failed community sync for ${postId}:`, error);
    return null;
  }
};
