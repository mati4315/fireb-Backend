import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { Readable } from 'stream';
import * as ftp from 'basic-ftp';
import sharp = require('sharp');

admin.initializeApp();
const db = admin.firestore();

type SurveyStatus = 'active' | 'inactive' | 'completed';

type SurveyOption = {
  id: string;
  text: string;
  voteCount: number;
  active: boolean;
};

const MAX_SURVEY_OPTIONS_SELECTED = 10;
const SURVEY_COMPLETE_BATCH_SIZE = 200;
const COMMUNITY_THUMB_MAX_SIDE = 480;
const MAX_HOSTING_UPLOAD_BYTES = 6 * 1024 * 1024;
const USER_PROPAGATION_QUERY_PAGE_SIZE = 100;
const USER_PROPAGATION_BATCH_WRITE_LIMIT = 450;

const buildCommentRef = (contentId: string, commentId: string) =>
  db.collection('content').doc(contentId).collection('comments').doc(commentId);

const propagateUserFields = async (
  target: 'content' | 'comments' | 'replies',
  userId: string,
  updateData: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>
) => {
  let baseQuery: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>;
  if (target === 'content') {
    baseQuery = db.collection('content').where('userId', '==', userId);
  } else {
    baseQuery = db.collectionGroup(target).where('userId', '==', userId);
  }

  let snapshot = await baseQuery.limit(USER_PROPAGATION_QUERY_PAGE_SIZE).get();
  let batch = db.batch();
  let batchCount = 0;
  let totalUpdated = 0;

  while (!snapshot.empty) {
    for (const targetDoc of snapshot.docs) {
      batch.update(targetDoc.ref, updateData);
      batchCount += 1;
      totalUpdated += 1;

      if (batchCount >= USER_PROPAGATION_BATCH_WRITE_LIMIT) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    }

    const lastDoc = snapshot.docs[snapshot.docs.length - 1];
    snapshot = await baseQuery.startAfter(lastDoc).limit(USER_PROPAGATION_QUERY_PAGE_SIZE).get();
  }

  if (batchCount > 0) {
    await batch.commit();
  }

  return totalUpdated;
};

const normalizeOptionIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const deduped = new Set<string>();

  for (const item of value) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim();
    if (!cleaned) continue;
    deduped.add(cleaned);
  }

  return Array.from(deduped);
};

const normalizeSurveyOptions = (value: unknown): SurveyOption[] => {
  if (!Array.isArray(value)) return [];
  const normalized: SurveyOption[] = [];

  for (const rawOption of value) {
    if (!rawOption || typeof rawOption !== 'object') continue;
    const optionData = rawOption as Record<string, unknown>;

    const id = typeof optionData.id === 'string' ? optionData.id.trim() : '';
    const text = typeof optionData.text === 'string' ? optionData.text.trim() : '';
    const voteCountRaw = Number(optionData.voteCount ?? 0);

    if (!id || !text) continue;

    normalized.push({
      id,
      text,
      voteCount: Number.isFinite(voteCountRaw)
        ? Math.max(0, Math.floor(voteCountRaw))
        : 0,
      active: optionData.active !== false
    });
  }

  return normalized;
};

const isExpired = (value: unknown): boolean => {
  if (!value) return false;
  if (value instanceof admin.firestore.Timestamp) {
    return value.toMillis() <= Date.now();
  }

  if (value instanceof Date) {
    return value.getTime() <= Date.now();
  }

  return false;
};

const ensureImageMime = (value: unknown): string => {
  const mime = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!mime.startsWith('image/')) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Formato de archivo invalido.'
    );
  }
  return mime;
};

const decodeBase64Payload = (value: unknown): Buffer => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'No se recibio imagen.'
    );
  }

  const sanitized = value.replace(/^data:[^;]+;base64,/, '').trim();
  const buffer = Buffer.from(sanitized, 'base64');
  if (buffer.length === 0) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'No se pudo decodificar la imagen.'
    );
  }
  if (buffer.length > MAX_HOSTING_UPLOAD_BYTES) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'La imagen supera el limite permitido.'
    );
  }
  return buffer;
};

const sanitizePathSegment = (value: string): string => {
  const sanitized = value
    .replace(/[^a-zA-Z0-9/_.-]/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/\/+/g, '/')
    .replace(/^\//, '')
    .replace(/\/$/, '');
  return sanitized;
};

const getHostingFtpConfig = () => {
  const host = process.env.HOSTING_FTP_HOST || '';
  const user = process.env.HOSTING_FTP_USER || '';
  const password = process.env.HOSTING_FTP_PASSWORD || '';
  const basePath = process.env.HOSTING_FTP_BASE_PATH || '/domains/cdelu.ar/public_html/imagenes';
  const publicBaseUrl = process.env.HOSTING_PUBLIC_BASE_URL || 'https://cdelu.ar/imagenes';
  const port = Number(process.env.HOSTING_FTP_PORT || 21);

  if (!host || !user || !password) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Falta configurar credenciales FTP del hosting.'
    );
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

// 1. Likes
export const onLikeAdded = functions.firestore
  .document('content/{contentId}/likes/{userId}')
  .onCreate(async (snap, context) => {
    const { contentId } = context.params;
    try {
      await db.collection('content').doc(contentId).update({
        'stats.likesCount': admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`âœ… Like +1 for ${contentId}`);
    } catch (error) {
      console.error(`âŒ Like increment failed: ${contentId}`, error);
    }
  });

export const onLikeRemoved = functions.firestore
  .document('content/{contentId}/likes/{userId}')
  .onDelete(async (snap, context) => {
    const { contentId } = context.params;
    try {
      await db.collection('content').doc(contentId).update({
        'stats.likesCount': admin.firestore.FieldValue.increment(-1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error(`âŒ Like decrement failed`, error);
    }
  });

// 2. Comments
export const onCommentCreated = functions.firestore
  .document('content/{contentId}/comments/{commentId}')
  .onCreate(async (snap, context) => {
    const { contentId } = context.params;
    const commentData = snap.data();
    if (!commentData || !commentData.userId || commentData.deletedAt != null) return;

    try {
      await db.collection('content').doc(contentId).set(
        {
          stats: {
            commentsCount: admin.firestore.FieldValue.increment(1)
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      console.log(`Comment +1 for ${contentId}`);
    } catch (error) {
      console.error(`Comment increment failed`, error);
    }
  });

export const onCommentUpdated = functions.firestore
  .document('content/{contentId}/comments/{commentId}')
  .onUpdate(async (change, context) => {
    const { contentId, commentId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();
    if (!beforeData || !afterData) return;

    const wasAlive = beforeData.deletedAt == null;
    const isAlive = afterData.deletedAt == null;
    if (wasAlive === isAlive) return;

    const delta = isAlive ? 1 : -1;
    try {
      await db.collection('content').doc(contentId).set(
        {
          stats: {
            commentsCount: admin.firestore.FieldValue.increment(delta)
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      console.log(`Comment ${commentId} visibility changed (delta ${delta})`);
    } catch (error) {
      console.error(`Comment visibility update failed`, error);
    }
  });

export const onReplyCreated = functions.firestore
  .document('content/{contentId}/comments/{commentId}/replies/{replyId}')
  .onCreate(async (snap, context) => {
    const { contentId, commentId } = context.params;
    const replyData = snap.data();
    if (!replyData || !replyData.userId || replyData.deletedAt != null) return;

    try {
      await buildCommentRef(contentId, commentId).set(
        {
          stats: {
            repliesCount: admin.firestore.FieldValue.increment(1)
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      console.log(`Reply +1 for comment ${commentId}`);
    } catch (error) {
      console.error(`Reply increment failed`, error);
    }
  });

export const onReplyUpdated = functions.firestore
  .document('content/{contentId}/comments/{commentId}/replies/{replyId}')
  .onUpdate(async (change, context) => {
    const { contentId, commentId, replyId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();
    if (!beforeData || !afterData) return;

    const wasAlive = beforeData.deletedAt == null;
    const isAlive = afterData.deletedAt == null;
    if (wasAlive === isAlive) return;

    const delta = isAlive ? 1 : -1;
    try {
      await buildCommentRef(contentId, commentId).set(
        {
          stats: {
            repliesCount: admin.firestore.FieldValue.increment(delta)
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      console.log(`Reply ${replyId} visibility changed (delta ${delta})`);
    } catch (error) {
      console.error(`Reply visibility update failed`, error);
    }
  });

// 2. Follows
// Trigger source of truth:
// relationships/{userId}/followers/{followerId}
// -> followerId follows userId
export const onFollowAdded = functions.firestore
  .document('relationships/{userId}/followers/{followerId}')
  .onCreate(async (snap, context) => {
    const { userId, followerId } = context.params;
    try {
      const batch = db.batch();
      batch.update(db.collection('users').doc(userId), {
        'stats.followersCount': admin.firestore.FieldValue.increment(1)
      });
      batch.update(db.collection('users').doc(followerId), {
        'stats.followingCount': admin.firestore.FieldValue.increment(1)
      });
      await batch.commit();
      console.log(`Follow +1: ${followerId} -> ${userId}`);
    } catch (error) {
      console.error(`Follow increment failed`, error);
    }
  });

export const onFollowRemoved = functions.firestore
  .document('relationships/{userId}/followers/{followerId}')
  .onDelete(async (snap, context) => {
    const { userId, followerId } = context.params;
    try {
      const batch = db.batch();
      batch.update(db.collection('users').doc(userId), {
        'stats.followersCount': admin.firestore.FieldValue.increment(-1)
      });
      batch.update(db.collection('users').doc(followerId), {
        'stats.followingCount': admin.firestore.FieldValue.increment(-1)
      });
      await batch.commit();
      console.log(`Follow -1: ${followerId} -> ${userId}`);
    } catch (error) {
      console.error(`Unfollow decrement failed`, error);
    }
  });

// 3. User Updates (PropagaciÃ³n desnormalizada)
export const onUserUpdated = functions.firestore
  .document('users/{userId}')
  .onUpdate(async (change, context) => {
    const { userId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();

    try {
      const nameChanged = beforeData.nombre !== afterData.nombre;
      const pictureChanged = beforeData.profilePictureUrl !== afterData.profilePictureUrl;

      if (!nameChanged && !pictureChanged) return;

      const postUpdateData: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {};
      const commentsUpdateData: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {};
      if (nameChanged) {
        postUpdateData.userName = afterData.nombre || '';
        commentsUpdateData.userName = afterData.nombre || '';
      }
      if (pictureChanged) {
        postUpdateData.userProfilePicUrl = afterData.profilePictureUrl || '';
        commentsUpdateData.userProfilePicUrl = afterData.profilePictureUrl || '';
      }

      const [postsUpdated, commentsUpdated, repliesUpdated] = await Promise.all([
        Object.keys(postUpdateData).length > 0
          ? propagateUserFields('content', userId, postUpdateData)
          : Promise.resolve(0),
        Object.keys(commentsUpdateData).length > 0
          ? propagateUserFields('comments', userId, commentsUpdateData)
          : Promise.resolve(0),
        Object.keys(commentsUpdateData).length > 0
          ? propagateUserFields('replies', userId, commentsUpdateData)
          : Promise.resolve(0)
      ]);

      console.log(
        `User profile updated for ${userId}: posts=${postsUpdated}, comments=${commentsUpdated}, replies=${repliesUpdated}`
      );
    } catch (error) {
      console.error(`âŒ User update propagation failed:`, error);
    }
  });

// 4. Content Tracking
export const onContentCreated = functions.firestore
  .document('content/{contentId}')
  .onCreate(async (snap, context) => {
    const contentData = snap.data();
    if (!contentData) return;

    const isCommunityPost =
      contentData.module === 'community' || contentData.type === 'post';
    if (!isCommunityPost || !contentData.userId) return;
    
    try {
      await db.collection('users').doc(contentData.userId).update({
        'stats.postsCount': admin.firestore.FieldValue.increment(1)
      });
    } catch (error) {
      console.error(`âŒ Content created increment failed:`, error);
    }
  });

export const onContentDeleted = functions.firestore
  .document('content/{contentId}')
  .onUpdate(async (change, context) => {
    const { contentId } = context.params;
    const beforeData = change.before.data();
    const afterData = change.after.data();

    const isCommunityPost =
      afterData.module === 'community' || afterData.type === 'post';
    if (!isCommunityPost || !afterData.userId) return;

    try {
      const wasAlive = beforeData.deletedAt == null;
      const isNowDeleted = afterData.deletedAt != null;

      if (wasAlive && isNowDeleted) {
        const userId = afterData.userId;
        await db.collection('users').doc(userId).update({
          'stats.postsCount': admin.firestore.FieldValue.increment(-1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`âœ… Content soft-deleted: ${contentId}, postsCount decremented`);
      } else if (!wasAlive && !isNowDeleted) {
        const userId = afterData.userId;
        await db.collection('users').doc(userId).update({
          'stats.postsCount': admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`âœ… Content restored: ${contentId}, postsCount incremented`);
      }
    } catch (error) {
      console.error(`âŒ Content deletion handling failed:`, error);
    }
  });

// 5. IntegraciÃ³n Oficial de Noticias desde WordPress via Realtime Database
export const onOfficialNewsReceived = functions.database
  .ref('/news/{newsId}')
  .onWrite(async (change, context) => {
    const { newsId } = context.params;
    const afterData = change.after.val();

    // Si data es null, significa que fue borrada de RTDB (no borramos de Firestore por seguridad)
    if (!afterData) {
      console.log(`â„¹ï¸ News ${newsId} was deleted from RTDB. Ignoring in Firestore. (Idempotency)`);
      return null;
    }

    try {
      // Parsear la fecha createdAt si es string (ej: "2024-01-15 10:30:00")
      // Si no hay fecha o es invÃ¡lida, se usarÃ¡ el Timestamp del servidor.
      let createdAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp = admin.firestore.FieldValue.serverTimestamp();
      let updatedAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp = admin.firestore.FieldValue.serverTimestamp();
      
      if (afterData.createdAt) {
        const parsedCreate = new Date(afterData.createdAt);
        if (!isNaN(parsedCreate.getTime())) createdAtTs = admin.firestore.Timestamp.fromDate(parsedCreate);
      }
      
      if (afterData.updatedAt) {
         const parsedUpdate = new Date(afterData.updatedAt);
         if (!isNaN(parsedUpdate.getTime())) updatedAtTs = admin.firestore.Timestamp.fromDate(parsedUpdate);
      }

      // Payload purificado e idempotente
      const firestorePayload = {
        type: 'news',
        source: 'wordpress',
        module: 'news',
        externalId: newsId,
        externalSource: 'wordpress_plugin',
        
        titulo: afterData.titulo || 'Sin TÃ­tulo',
        descripcion: afterData.descripcion || '',
        images: Array.isArray(afterData.images) ? afterData.images : [],
        
        userId: afterData.userId || 'wp_official',
        userName: afterData.userName || 'RedacciÃ³n CdeluAR',
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

      // Set con merge asegura idempotencia (crea si no existe, actualiza si existe)
      await db.collection('content').doc(newsId).set(firestorePayload, { merge: true });
      console.log(`âœ… Noticia sincronizada en Firestore: ${newsId}`);

      return null;
    } catch (error) {
      console.error(`âŒ FallÃ³ la sincronizaciÃ³n de RTDB a Firestore para ${newsId}:`, error);
      return null;
    }
  });

// 6. Community image thumbnails
export const onCommunityPostImageFinalized = functions.storage
  .object()
  .onFinalize(async (object) => {
    const filePath = object.name;
    const contentType = object.contentType || '';
    const bucketName = object.bucket;
    const metadata = object.metadata || {};

    if (!filePath || !bucketName) return null;
    if (!filePath.startsWith('posts/')) return null;
    if (!contentType.startsWith('image/')) return null;
    if (filePath.includes('/thumbs/')) return null;
    if (metadata.generatedBy === 'community-thumbnail') return null;

    const ext = path.posix.extname(filePath).toLowerCase();
    const baseName = path.posix.basename(filePath, ext);
    if (baseName.endsWith('_t') || baseName.endsWith('-thumb')) return null;

    const directory = path.posix.dirname(filePath);
    const thumbPath = `${directory}/thumbs/${baseName}.webp`;
    const bucket = admin.storage().bucket(bucketName);
    const thumbFile = bucket.file(thumbPath);
    const [alreadyExists] = await thumbFile.exists();
    if (alreadyExists) return null;

    const sourceTempFile = path.join(os.tmpdir(), `${Date.now()}-${path.basename(filePath)}`);
    const thumbTempFile = path.join(os.tmpdir(), `${Date.now()}-${baseName}.webp`);

    try {
      await bucket.file(filePath).download({ destination: sourceTempFile });

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
    } catch (error) {
      console.error('Thumbnail generation failed', { filePath, error });
    } finally {
      await Promise.all([
        fs.unlink(sourceTempFile).catch(() => undefined),
        fs.unlink(thumbTempFile).catch(() => undefined)
      ]);
    }

    return null;
  });

// 7. Hosting FTP image upload fallback for community posts
export const uploadCommunityImageToHosting = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para subir imagenes.'
    );
  }

  const relativePathRaw = typeof data?.path === 'string' ? data.path.trim() : '';
  const contentType = ensureImageMime(data?.contentType);
  const base64Data = decodeBase64Payload(data?.base64Data);

  if (!relativePathRaw) {
    throw new functions.https.HttpsError('invalid-argument', 'Ruta de imagen invalida.');
  }

  const relativePath = sanitizePathSegment(relativePathRaw).replace(/^imagenes\//, '');
  const allowedPrefix = `posts/${userId}/`;
  if (!relativePath.startsWith(allowedPrefix)) {
    throw new functions.https.HttpsError('permission-denied', 'Ruta de subida no permitida.');
  }

  const ext = path.posix.extname(relativePath).toLowerCase();
  const safeExt = ext && ext.length <= 6 ? ext : '.webp';
  const fileNameBase = path.posix.basename(relativePath, ext || undefined)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 80) || `${Date.now()}`;
  const targetRelativePath = `${path.posix.dirname(relativePath)}/${fileNameBase}${safeExt}`.replace(/\/+/g, '/');

  const ftpConfig = getHostingFtpConfig();
  const remoteFilePath = `${ftpConfig.basePath}/${targetRelativePath}`.replace(/\/+/g, '/');
  const remoteDir = path.posix.dirname(remoteFilePath);
  const publicUrl = `${ftpConfig.publicBaseUrl}/${targetRelativePath}`;

  const ftpClient = new ftp.Client(30_000);
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
    await ftpClient.uploadFrom(Readable.from(base64Data), remoteFilePath);
  } catch (error) {
    console.error('FTP hosting upload failed', { userId, relativePath: targetRelativePath, error });
    throw new functions.https.HttpsError(
      'internal',
      'No se pudo subir la imagen al hosting.'
    );
  } finally {
    ftpClient.close();
  }

  return {
    url: publicUrl,
    path: targetRelativePath,
    sizeBytes: base64Data.length,
    contentType
  };
});

// 8. Surveys vote callable (single vote per user/survey)
export const submitSurveyVote = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para votar.'
    );
  }

  const surveyId = typeof data?.surveyId === 'string' ? data.surveyId.trim() : '';
  const optionIds = normalizeOptionIds(data?.optionIds);
  const idempotencyKeyRaw = typeof data?.idempotencyKey === 'string'
    ? data.idempotencyKey.trim()
    : '';
  const idempotencyKey = idempotencyKeyRaw ? idempotencyKeyRaw.slice(0, 120) : null;

  if (!surveyId) {
    throw new functions.https.HttpsError('invalid-argument', 'surveyId es obligatorio.');
  }
  if (optionIds.length === 0) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Debes seleccionar al menos una opcion.'
    );
  }
  if (optionIds.length > MAX_SURVEY_OPTIONS_SELECTED) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Cantidad de opciones seleccionadas invalida.'
    );
  }

  const surveyRef = db.collection('surveys').doc(surveyId);
  const voteRef = db.collection('survey_votes').doc(`${surveyId}_${userId}`);
  const modulesConfigRef = db.collection('_config').doc('modules');

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, surveySnap, existingVoteSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(surveyRef),
      tx.get(voteRef)
    ]);

    const surveysEnabled = Boolean(modulesConfigSnap.data()?.surveys?.enabled ?? true);
    if (!surveysEnabled) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El modulo de encuestas esta deshabilitado.'
      );
    }

    if (!surveySnap.exists) {
      throw new functions.https.HttpsError('not-found', 'La encuesta no existe.');
    }

    const surveyData = surveySnap.data() || {};
    const surveyStatus = (surveyData.status || 'inactive') as SurveyStatus;
    if (surveyStatus !== 'active') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'La encuesta no esta activa.'
      );
    }
    if (isExpired(surveyData.expiresAt)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'La encuesta ya expiro.'
      );
    }

    const isMultipleChoice = Boolean(surveyData.isMultipleChoice);
    const maxVotesRaw = Number(surveyData.maxVotesPerUser ?? 1);
    const maxVotesPerUser = Number.isFinite(maxVotesRaw)
      ? (isMultipleChoice ? Math.max(2, Math.floor(maxVotesRaw)) : 1)
      : (isMultipleChoice ? 2 : 1);

    if (!isMultipleChoice && optionIds.length !== 1) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Esta encuesta permite solo una opcion.'
      );
    }
    if (optionIds.length > maxVotesPerUser) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Superaste el maximo de opciones permitidas.'
      );
    }

    const surveyOptions = normalizeSurveyOptions(surveyData.options);
    if (surveyOptions.length < 2) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'La encuesta no tiene opciones validas para votar.'
      );
    }

    const availableOptionIds = new Set<string>();
    for (const option of surveyOptions) {
      if (option.active) {
        availableOptionIds.add(option.id);
      }
    }

    for (const selectedOptionId of optionIds) {
      if (!availableOptionIds.has(selectedOptionId)) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'Seleccionaste una opcion invalida.'
        );
      }
    }

    if (existingVoteSnap.exists) {
      const existingVote = existingVoteSnap.data() || {};
      return {
        status: 'already_voted',
        surveyId,
        optionIds: normalizeOptionIds(existingVote.optionIds)
      };
    }

    const optionSelectionCounts = new Map<string, number>();
    for (const optionId of optionIds) {
      const previousCount = optionSelectionCounts.get(optionId) || 0;
      optionSelectionCounts.set(optionId, previousCount + 1);
    }

    const nextOptions = surveyOptions.map((option) => {
      const incrementBy = optionSelectionCounts.get(option.id) || 0;
      if (incrementBy <= 0) return option;

      return {
        ...option,
        voteCount: option.voteCount + incrementBy
      };
    });

    const votePayload: Record<string, unknown> = {
      surveyId,
      userId,
      optionIds,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (idempotencyKey) {
      votePayload.idempotencyKey = idempotencyKey;
    }

    tx.set(voteRef, votePayload);
    tx.update(surveyRef, {
      options: nextOptions,
      totalVotes: admin.firestore.FieldValue.increment(optionIds.length),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      status: 'ok',
      surveyId,
      optionIds
    };
  });
});

// 9. Auto-complete expired surveys
export const completeExpiredSurveys = functions.pubsub
  .schedule('every 1 minutes')
  .onRun(async () => {
    let completedCount = 0;

    while (true) {
      const snapshot = await db.collection('surveys')
        .where('status', '==', 'active')
        .where('expiresAt', '<=', admin.firestore.Timestamp.now())
        .orderBy('expiresAt', 'asc')
        .limit(SURVEY_COMPLETE_BATCH_SIZE)
        .get();

      if (snapshot.empty) break;

      const batch = db.batch();
      for (const surveyDoc of snapshot.docs) {
        batch.update(surveyDoc.ref, {
          status: 'completed',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      await batch.commit();
      completedCount += snapshot.size;

      if (snapshot.size < SURVEY_COMPLETE_BATCH_SIZE) break;
    }

    console.log(`Expired surveys completed: ${completedCount}`);
    return null;
  });

// 10. Ads metrics aggregation
export const onAdEventCreated = functions.firestore
  .document('ad_events/{eventId}')
  .onCreate(async (snap) => {
    const eventData = snap.data();
    if (!eventData) return null;

    const adId = eventData.adId as string | undefined;
    const eventType = eventData.eventType as 'impression' | 'click' | undefined;
    const countRaw = Number(eventData.count ?? 1);
    const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(Math.floor(countRaw), 20)) : 1;

    if (!adId || (eventType !== 'impression' && eventType !== 'click')) {
      console.log('Ignoring invalid ad event payload', { adId, eventType });
      return null;
    }

    const adRef = db.collection('ads').doc(adId);

    try {
      await db.runTransaction(async (tx) => {
        const adSnap = await tx.get(adRef);
        if (!adSnap.exists) {
          console.log(`Ad ${adId} does not exist. Event ignored.`);
          return;
        }

        const adData = adSnap.data() || {};
        const stats = adData.stats || {};
        const currentImpressions = Number(stats.impressionsTotal || 0);
        const currentClicks = Number(stats.clicksTotal || 0);

        const impressionIncrement = eventType === 'impression' ? count : 0;
        const clickIncrement = eventType === 'click' ? count : 0;

        const nextImpressions = currentImpressions + impressionIncrement;
        const nextClicks = currentClicks + clickIncrement;
        const ctr = nextImpressions > 0
          ? Number(((nextClicks / nextImpressions) * 100).toFixed(2))
          : 0;

        tx.set(
          adRef,
          {
            stats: {
              impressionsTotal: admin.firestore.FieldValue.increment(impressionIncrement),
              clicksTotal: admin.firestore.FieldValue.increment(clickIncrement),
              ctr,
              lastEventAt: admin.firestore.FieldValue.serverTimestamp()
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      });

      return null;
    } catch (error) {
      console.error(`Failed to aggregate ad event for ad ${adId}`, error);
      return null;
    }
  });

