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

type LotteryStatus = 'draft' | 'active' | 'closed' | 'completed';
type LotteryMigrationStatus = 'pending' | 'running' | 'done' | 'failed';

const MAX_SURVEY_OPTIONS_SELECTED = 10;
const SURVEY_COMPLETE_BATCH_SIZE = 200;
const COMMUNITY_THUMB_MAX_SIDE = 480;
const MAX_HOSTING_UPLOAD_BYTES = 6 * 1024 * 1024;
const USER_PROPAGATION_QUERY_PAGE_SIZE = 100;
const USER_PROPAGATION_BATCH_WRITE_LIMIT = 450;
const LIKE_WRITER_CALLABLE = 'callable_toggle_v1';
const LOTTERY_DEFAULT_MAX_NUMBER = 100;
const LOTTERY_MIN_MAX_NUMBER = 10;
const LOTTERY_MAX_MAX_NUMBER = 200;
const LOTTERY_DEFAULT_MAX_TICKETS_PER_USER = 1;
const LOTTERY_MIN_TICKETS_PER_USER = 1;
const LOTTERY_MAX_TICKETS_PER_USER = 5;
const LOTTERY_ENTRY_SCHEMA_VERSION = 2;
const LOTTERY_ENTRY_DOC_PREFIX = 'n_';
const LOTTERY_MIGRATION_PAGE_SIZE = 400;
const LOTTERY_MIGRATION_BATCH_SIZE = 400;
const MAX_LOTTERY_DRAW_ENTRIES = 5000;
const COMMUNITY_THUMBNAIL_BUCKET = process.env.COMMUNITY_IMAGES_BUCKET || 'cdeluar-ddefc-storage';

const buildCommentRef = (contentId: string, commentId: string) =>
  db.collection('content').doc(contentId).collection('comments').doc(commentId);

const inferContentModule = (
  contentData: FirebaseFirestore.DocumentData
): 'news' | 'community' => {
  if (contentData?.module === 'news' || contentData?.type === 'news') {
    return 'news';
  }
  return 'community';
};

const isLikeModuleEnabledForContent = (
  modulesConfig: FirebaseFirestore.DocumentData | undefined,
  moduleName: 'news' | 'community'
): boolean => {
  const likesConfig = modulesConfig?.likes ?? {};
  const likesEnabled = likesConfig.enabled ?? true;
  const likesNewsEnabled = likesConfig.newsEnabled ?? true;
  const likesCommunityEnabled = likesConfig.communityEnabled ?? true;

  if (!likesEnabled) return false;
  return moduleName === 'news' ? likesNewsEnabled : likesCommunityEnabled;
};

const isLotteryModuleEnabled = (
  modulesConfig: FirebaseFirestore.DocumentData | undefined
): boolean => {
  const lotteryConfig = modulesConfig?.lottery ?? {};
  return lotteryConfig.enabled ?? true;
};

const clampInteger = (value: unknown, min: number, max: number, fallback: number): number => {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const parsed = Math.floor(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

const normalizeLotteryMaxNumber = (value: unknown): number => {
  return clampInteger(
    value,
    LOTTERY_MIN_MAX_NUMBER,
    LOTTERY_MAX_MAX_NUMBER,
    LOTTERY_DEFAULT_MAX_NUMBER
  );
};

const normalizeLotteryMaxTicketsPerUser = (value: unknown): number => {
  return clampInteger(
    value,
    LOTTERY_MIN_TICKETS_PER_USER,
    LOTTERY_MAX_TICKETS_PER_USER,
    LOTTERY_DEFAULT_MAX_TICKETS_PER_USER
  );
};

const parseSelectedLotteryNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  if (!Number.isFinite(normalized) || normalized !== parsed) return null;
  if (normalized <= 0) return null;
  return normalized;
};

const toLotteryEntryDocId = (selectedNumber: number): string => {
  return `${LOTTERY_ENTRY_DOC_PREFIX}${selectedNumber}`;
};

const extractSelectedNumberFromEntryDoc = (
  entryDoc: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>
): number | null => {
  const data = entryDoc.data() || {};
  const selectedRaw = parseSelectedLotteryNumber(data.selectedNumber);
  if (selectedRaw != null) return selectedRaw;

  const matches = entryDoc.id.match(/^n_(\d+)$/);
  if (!matches) return null;
  return parseSelectedLotteryNumber(matches[1]);
};

const normalizeRoleAlias = (value: unknown): string => {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s_-]+/g, '')
    : '';
};

const isAdminClaim = (token: Record<string, unknown>): boolean => {
  return token.admin === true ||
    token.superAdmin === true ||
    token.super_admin === true;
};

const isStaffRole = (role: unknown): boolean => {
  const normalized = normalizeRoleAlias(role);
  return normalized === 'colaborador' ||
    normalized === 'admin' ||
    normalized === 'administrador' ||
    normalized === 'superadmin';
};

const assertStaffUser = async (
  authContext: functions.https.CallableContext['auth']
): Promise<void> => {
  const uid = authContext?.uid || '';
  if (!uid) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para ejecutar esta accion.'
    );
  }

  const token = (authContext?.token || {}) as Record<string, unknown>;
  const email = typeof token.email === 'string' ? token.email.toLowerCase() : '';
  if (
    uid === 'Z4f5ogXDQaNhEY4iBf9jgkPnQMP2' ||
    email === 'matias4315@gmail.com' ||
    isAdminClaim(token)
  ) {
    return;
  }

  const userSnap = await db.collection('users').doc(uid).get();
  const role = userSnap.data()?.rol;
  if (isStaffRole(role)) return;

  throw new functions.https.HttpsError(
    'permission-denied',
    'Solo staff puede ejecutar esta accion.'
  );
};

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
    const likeData = snap.data() || {};
    if (likeData.writer === LIKE_WRITER_CALLABLE) return;
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
    const likeData = snap.data() || {};
    if (likeData.writer === LIKE_WRITER_CALLABLE) return;
    try {
      await db.collection('content').doc(contentId).update({
        'stats.likesCount': admin.firestore.FieldValue.increment(-1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error(`âŒ Like decrement failed`, error);
    }
  });

export const toggleContentLike = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para dar me gusta.'
    );
  }

  const contentId = typeof data?.contentId === 'string' ? data.contentId.trim() : '';
  if (!contentId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'contentId es obligatorio.'
    );
  }

  const contentRef = db.collection('content').doc(contentId);
  const likeRef = contentRef.collection('likes').doc(userId);
  const modulesConfigRef = db.collection('_config').doc('modules');

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, contentSnap, likeSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(contentRef),
      tx.get(likeRef)
    ]);

    if (!contentSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'El contenido no existe.');
    }

    const contentData = contentSnap.data() || {};
    if (contentData.deletedAt != null) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'No puedes dar me gusta a contenido eliminado.'
      );
    }

    const moduleName = inferContentModule(contentData);
    const isEnabled = isLikeModuleEnabledForContent(modulesConfigSnap.data(), moduleName);
    if (!isEnabled) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Los me gusta estan deshabilitados para este modulo.'
      );
    }

    if (likeSnap.exists) {
      const existingLike = likeSnap.data() || {};
      tx.delete(likeRef);

      // Legacy likes (sin writer callable) mantienen compatibilidad via trigger.
      if (existingLike.writer === LIKE_WRITER_CALLABLE) {
        tx.set(
          contentRef,
          {
            stats: {
              likesCount: admin.firestore.FieldValue.increment(-1)
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      }

      return {
        status: 'ok',
        liked: false,
        contentId
      };
    }

    tx.set(likeRef, {
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      writer: LIKE_WRITER_CALLABLE
    });

    tx.set(
      contentRef,
      {
        stats: {
          likesCount: admin.firestore.FieldValue.increment(1)
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      status: 'ok',
      liked: true,
      contentId
    };
  });
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
  .bucket(COMMUNITY_THUMBNAIL_BUCKET)
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

const listAllLotteryEntries = async (
  lotteryRef: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
): Promise<FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[]> => {
  const docs: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[] = [];
  let lastDocId: string | null = null;

  while (true) {
    let pageQuery = lotteryRef
      .collection('entries')
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(LOTTERY_MIGRATION_PAGE_SIZE);

    if (lastDocId) {
      pageQuery = pageQuery.startAfter(lastDocId);
    }

    const pageSnap = await pageQuery.get();
    if (pageSnap.empty) break;

    docs.push(...pageSnap.docs);
    if (pageSnap.size < LOTTERY_MIGRATION_PAGE_SIZE) break;
    lastDocId = pageSnap.docs[pageSnap.docs.length - 1].id;
  }

  return docs;
};

const ensureLotteryEntriesSchemaV2 = async (lotteryId: string): Promise<void> => {
  const lotteryRef = db.collection('lotteries').doc(lotteryId);
  let maxNumber = LOTTERY_DEFAULT_MAX_NUMBER;
  let maxTicketsPerUser = LOTTERY_DEFAULT_MAX_TICKETS_PER_USER;
  let mustRunMigration = false;
  let needsDefaultsPatch = false;

  await db.runTransaction(async (tx) => {
    const lotterySnap = await tx.get(lotteryRef);
    if (!lotterySnap.exists) {
      throw new functions.https.HttpsError('not-found', 'La loteria no existe.');
    }

    const lotteryData = lotterySnap.data() || {};
    maxNumber = normalizeLotteryMaxNumber(lotteryData.maxNumber);
    maxTicketsPerUser = normalizeLotteryMaxTicketsPerUser(lotteryData.maxTicketsPerUser);

    const schemaRaw = Number(lotteryData.entrySchemaVersion || 0);
    const schemaVersion = Number.isFinite(schemaRaw) ? Math.floor(schemaRaw) : 0;
    const migrationStatusRaw = typeof lotteryData.migrationStatus === 'string'
      ? lotteryData.migrationStatus
      : '';
    const migrationStatus = migrationStatusRaw as LotteryMigrationStatus;

    const isAlreadyV2 = schemaVersion >= LOTTERY_ENTRY_SCHEMA_VERSION;
    if (isAlreadyV2 && migrationStatus !== 'failed') {
      const hasValidDefaults = lotteryData.maxNumber === maxNumber &&
        lotteryData.maxTicketsPerUser === maxTicketsPerUser &&
        migrationStatus === 'done';
      needsDefaultsPatch = !hasValidDefaults;
      return;
    }

    if (migrationStatus === 'running') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'migration-in-progress: La loteria esta migrando entradas, intenta nuevamente en unos segundos.'
      );
    }

    mustRunMigration = true;
    tx.set(
      lotteryRef,
      {
        migrationStatus: 'running',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });

  if (!mustRunMigration) {
    if (needsDefaultsPatch) {
      await lotteryRef.set(
        {
          maxNumber,
          maxTicketsPerUser,
          migrationStatus: 'done',
          entrySchemaVersion: LOTTERY_ENTRY_SCHEMA_VERSION,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }
    return;
  }

  try {
    const allEntries = await listAllLotteryEntries(lotteryRef);
    const usedNumbers = new Set<number>();
    const nextAvailableNumber = (() => {
      let cursor = 1;
      return (): number | null => {
        while (cursor <= maxNumber) {
          const candidate = cursor;
          cursor += 1;
          if (!usedNumbers.has(candidate)) {
            usedNumbers.add(candidate);
            return candidate;
          }
        }
        return null;
      };
    })();

    type PlannedEntry = {
      source: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>;
      selectedNumber: number;
      targetId: string;
    };

    const plannedEntries: PlannedEntry[] = [];
    const deferredEntries: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>[] = [];

    for (const entryDoc of allEntries) {
      const parsedSelected = extractSelectedNumberFromEntryDoc(entryDoc);
      const isSelectable = parsedSelected != null && parsedSelected >= 1 && parsedSelected <= maxNumber;
      if (!isSelectable || usedNumbers.has(parsedSelected)) {
        deferredEntries.push(entryDoc);
        continue;
      }

      usedNumbers.add(parsedSelected);
      plannedEntries.push({
        source: entryDoc,
        selectedNumber: parsedSelected,
        targetId: toLotteryEntryDocId(parsedSelected)
      });
    }

    for (const entryDoc of deferredEntries) {
      const assigned = nextAvailableNumber();
      if (assigned == null) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'No hay suficientes numeros disponibles para migrar las entradas legacy. Aumenta maxNumber.'
        );
      }

      plannedEntries.push({
        source: entryDoc,
        selectedNumber: assigned,
        targetId: toLotteryEntryDocId(assigned)
      });
    }

    let batch = db.batch();
    let writes = 0;
    const flush = async () => {
      if (writes === 0) return;
      await batch.commit();
      batch = db.batch();
      writes = 0;
    };

    for (const planned of plannedEntries) {
      const sourceData = planned.source.data() || {};
      const userIdRaw = typeof sourceData.userId === 'string' ? sourceData.userId.trim() : '';
      const fallbackUserId = planned.source.id;
      const userId = userIdRaw || fallbackUserId;

      const userNameRaw = typeof sourceData.userName === 'string' ? sourceData.userName.trim() : '';
      const userName = userNameRaw || 'Usuario';
      const profilePicRaw = typeof sourceData.userProfilePicUrl === 'string'
        ? sourceData.userProfilePicUrl.trim()
        : '';

      const payload: Record<string, unknown> = {
        userId,
        userName: userName.slice(0, 120),
        userProfilePicUrl: profilePicRaw,
        lotteryId,
        selectedNumber: planned.selectedNumber,
        createdAt: sourceData.createdAt instanceof admin.firestore.Timestamp
          ? sourceData.createdAt
          : admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      const targetRef = lotteryRef.collection('entries').doc(planned.targetId);
      batch.set(targetRef, payload, { merge: true });
      writes += 1;

      if (planned.source.ref.path !== targetRef.path) {
        batch.delete(planned.source.ref);
        writes += 1;
      }

      if (writes >= LOTTERY_MIGRATION_BATCH_SIZE) {
        await flush();
      }
    }

    batch.set(
      lotteryRef,
      {
        maxNumber,
        maxTicketsPerUser,
        participantsCount: plannedEntries.length,
        entrySchemaVersion: LOTTERY_ENTRY_SCHEMA_VERSION,
        migrationStatus: 'done',
        migrationError: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    writes += 1;
    await flush();
  } catch (error: any) {
    await lotteryRef.set(
      {
        migrationStatus: 'failed',
        migrationError: typeof error?.message === 'string'
          ? error.message.slice(0, 300)
          : 'migration-failed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    throw error;
  }
};

// 8. Lottery entry callable (number-based entries, supports multiple tickets per user)
export const enterLottery = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para participar en la loteria.'
    );
  }

  const lotteryId = typeof data?.lotteryId === 'string' ? data.lotteryId.trim() : '';
  const selectedNumber = parseSelectedLotteryNumber(data?.selectedNumber);
  const idempotencyKeyRaw = typeof data?.idempotencyKey === 'string'
    ? data.idempotencyKey.trim()
    : '';

  if (!lotteryId) {
    throw new functions.https.HttpsError('invalid-argument', 'lotteryId es obligatorio.');
  }
  if (selectedNumber == null) {
    throw new functions.https.HttpsError('invalid-argument', 'selectedNumber es obligatorio.');
  }

  await ensureLotteryEntriesSchemaV2(lotteryId);

  const userDocSnap = await db.collection('users').doc(userId).get();
  const userData = userDocSnap.data() || {};
  const token = (context.auth?.token || {}) as Record<string, unknown>;

  const fallbackEmail = typeof token.email === 'string' ? token.email : '';
  const fallbackName = fallbackEmail ? fallbackEmail.split('@')[0] : 'Usuario';
  const userNameRaw = typeof userData.nombre === 'string' ? userData.nombre : fallbackName;
  const userProfilePicRaw = typeof userData.profilePictureUrl === 'string'
    ? userData.profilePictureUrl
    : '';

  const userName = userNameRaw.trim().slice(0, 120) || 'Usuario';
  const userProfilePicUrl = userProfilePicRaw.trim();

  const modulesConfigRef = db.collection('_config').doc('modules');
  const lotteryRef = db.collection('lotteries').doc(lotteryId);
  const entryRef = lotteryRef.collection('entries').doc(toLotteryEntryDocId(selectedNumber));
  const userEntriesQuery = lotteryRef
    .collection('entries')
    .where('userId', '==', userId)
    .limit(LOTTERY_MAX_TICKETS_PER_USER + 2);

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, lotterySnap, entrySnap, userEntriesSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(lotteryRef),
      tx.get(entryRef),
      tx.get(userEntriesQuery)
    ]);

    if (!isLotteryModuleEnabled(modulesConfigSnap.data())) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'module-disabled: El modulo de loteria esta deshabilitado.'
      );
    }

    if (!lotterySnap.exists) {
      throw new functions.https.HttpsError('not-found', 'La loteria no existe.');
    }

    const lotteryData = lotterySnap.data() || {};
    if (lotteryData.deletedAt != null) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'lottery-inactive: La loteria ya no esta disponible.'
      );
    }

    const lotteryStatus = (lotteryData.status || 'draft') as LotteryStatus;
    if (lotteryStatus !== 'active') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'lottery-inactive: La loteria no esta activa.'
      );
    }

    if (lotteryData.winner) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'lottery-inactive: La loteria ya tiene ganador.'
      );
    }

    const nowMs = Date.now();
    const startsAt = lotteryData.startsAt instanceof admin.firestore.Timestamp
      ? lotteryData.startsAt.toMillis()
      : null;
    const endsAt = lotteryData.endsAt instanceof admin.firestore.Timestamp
      ? lotteryData.endsAt.toMillis()
      : null;

    if (startsAt != null && startsAt > nowMs) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'lottery-inactive: La loteria aun no inicio.'
      );
    }
    if (endsAt != null && endsAt < nowMs) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'lottery-inactive: La loteria ya finalizo la etapa de participacion.'
      );
    }

    const currentParticipantsRaw = Number(lotteryData.participantsCount || 0);
    const currentParticipants = Number.isFinite(currentParticipantsRaw)
      ? Math.max(0, Math.floor(currentParticipantsRaw))
      : 0;

    const maxNumber = normalizeLotteryMaxNumber(lotteryData.maxNumber);
    const maxTicketsPerUser = normalizeLotteryMaxTicketsPerUser(lotteryData.maxTicketsPerUser);
    if (selectedNumber < 1 || selectedNumber > maxNumber) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `out-of-range: Debes seleccionar un numero entre 1 y ${maxNumber}.`
      );
    }

    const userTicketsCount = userEntriesSnap.size;

    if (entrySnap.exists) {
      const existingEntry = entrySnap.data() || {};
      const entryOwner = typeof existingEntry.userId === 'string' ? existingEntry.userId : '';
      if (entryOwner === userId) {
        return {
          status: 'already_selected',
          lotteryId,
          selectedNumber,
          participantsCount: currentParticipants,
          userTicketsCount: Math.max(1, userTicketsCount)
        };
      }
      throw new functions.https.HttpsError(
        'already-exists',
        'number-taken: El numero seleccionado ya esta ocupado.'
      );
    }

    if (userTicketsCount >= maxTicketsPerUser) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `limit-reached: Alcanzaste el maximo de ${maxTicketsPerUser} numeros para esta loteria.`
      );
    }

    const entryPayload: Record<string, unknown> = {
      userId,
      userName,
      userProfilePicUrl,
      lotteryId,
      selectedNumber,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (idempotencyKeyRaw) {
      entryPayload.idempotencyKey = idempotencyKeyRaw.slice(0, 120);
    }

    tx.set(entryRef, entryPayload);
    tx.set(
      lotteryRef,
      {
        participantsCount: admin.firestore.FieldValue.increment(1),
        maxNumber,
        maxTicketsPerUser,
        entrySchemaVersion: LOTTERY_ENTRY_SCHEMA_VERSION,
        migrationStatus: 'done',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      status: 'ok',
      lotteryId,
      selectedNumber,
      participantsCount: currentParticipants + 1,
      userTicketsCount: userTicketsCount + 1
    };
  });
});

// 9. Lottery draw callable (staff-only)
export const drawLotteryWinner = functions.https.onCall(async (data, context) => {
  await assertStaffUser(context.auth);

  const lotteryId = typeof data?.lotteryId === 'string' ? data.lotteryId.trim() : '';
  if (!lotteryId) {
    throw new functions.https.HttpsError('invalid-argument', 'lotteryId es obligatorio.');
  }

  await ensureLotteryEntriesSchemaV2(lotteryId);

  const requesterUid = context.auth?.uid || 'system';
  const modulesConfigRef = db.collection('_config').doc('modules');
  const lotteryRef = db.collection('lotteries').doc(lotteryId);

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, lotterySnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(lotteryRef)
    ]);

    if (!isLotteryModuleEnabled(modulesConfigSnap.data())) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El modulo de loteria esta deshabilitado.'
      );
    }

    if (!lotterySnap.exists) {
      throw new functions.https.HttpsError('not-found', 'La loteria no existe.');
    }

    const lotteryData = lotterySnap.data() || {};
    if (lotteryData.deletedAt != null) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'La loteria ya no esta disponible.'
      );
    }

    if (lotteryData.winner) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'La loteria ya tiene ganador.'
      );
    }

    const lotteryStatus = (lotteryData.status || 'draft') as LotteryStatus;
    if (lotteryStatus !== 'closed') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'La loteria debe estar cerrada antes de sortear ganador.'
      );
    }

    const entriesQuery = lotteryRef
      .collection('entries')
      .orderBy('selectedNumber', 'asc')
      .limit(MAX_LOTTERY_DRAW_ENTRIES);
    const entriesSnap = await tx.get(entriesQuery);

    if (entriesSnap.empty) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'No hay participantes para sortear.'
      );
    }

    const randomIndex = Math.floor(Math.random() * entriesSnap.docs.length);
    const winnerDoc = entriesSnap.docs[randomIndex];
    const winnerData = winnerDoc.data() || {};

    const winnerUserId = typeof winnerData.userId === 'string' ? winnerData.userId : winnerDoc.id;
    const winnerUserName = typeof winnerData.userName === 'string'
      ? winnerData.userName
      : 'Usuario';
    const winnerProfilePic = typeof winnerData.userProfilePicUrl === 'string'
      ? winnerData.userProfilePicUrl
      : '';
    const winnerSelectedNumber = parseSelectedLotteryNumber(winnerData.selectedNumber) || null;

    const participantsRaw = Number(lotteryData.participantsCount || 0);
    const participantsCount = Number.isFinite(participantsRaw)
      ? Math.max(0, Math.floor(participantsRaw))
      : entriesSnap.docs.length;

    tx.set(
      lotteryRef,
      {
        status: 'completed',
        winner: {
          userId: winnerUserId,
          userName: winnerUserName,
          userProfilePicUrl: winnerProfilePic,
          selectedNumber: winnerSelectedNumber,
          selectedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        updatedBy: requesterUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      status: 'ok',
      lotteryId,
      winner: {
        userId: winnerUserId,
        userName: winnerUserName,
        userProfilePicUrl: winnerProfilePic,
        selectedNumber: winnerSelectedNumber
      },
      participantsCount
    };
  });
});

// 10. Surveys vote callable (single vote per user/survey)
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

// 11. Auto-complete expired surveys
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

// 12. Ads metrics aggregation
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

