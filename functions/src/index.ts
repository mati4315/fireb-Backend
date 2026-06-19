import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import {
  buildContentPublicIdKey,
  buildContentSlugBase,
  buildContentSlugKey,
  extractNewsPublicIdFromPayload,
  inferContentModule,
  normalizeContentSlug
} from './contentUtils';
import {
  buildProfileTargetPath,
  sanitizeNotificationDeviceId,
  type NotificationPlatform
} from './notificationUtils';
import {
  buildSecretFingerprintHash,
  createSecretAlias,
  hasMeaningfulSecretText,
  computeSecretRank,
  normalizeSecretAge,
  normalizeSecretCategory,
  normalizeSecretReportReason,
  normalizeSecretModerationAction,
  normalizeSecretModerationStatusFilter,
  normalizeSecretSex,
  normalizeSecretZone,
  refreshSecretRankingsInternal,
  resolveSecretRuntimeSettings,
  sanitizeSecretText,
  SECRET_COMMENT_MIN_LENGTH,
  SECRET_COMMENT_MAX_LENGTH,
  SECRET_FINGERPRINT_TTL_MS,
  SECRET_NUMERIC_ID_START,
  SECRET_TEXT_MAX_ABSOLUTE,
  timestampToMillisOrZero
} from './secretUtils';
import {
  clampInteger
} from './lotteryUtils';
import {
  assertAdminUser,
  assertStaffUser,
  buildPublicUserProfile,
  ensureNotificationTypeSettings,
  ensureUserSettings,
  ensureUserStats,
  normalizeUsernameLoose,
  normalizeUsernameStrict,
  propagateUserFields,
  sanitizeBoundedString,
} from './userUtils';
import {
  isLikeModuleEnabledForContent,
  isSecretsModuleEnabled
} from './moduleUtils';
import {
  sanitizeOptionalUrl
} from './hostingUtils';
import { buildCommentRef } from './commentUtils';
import {
  onContentCreatedInternal,
  onContentDeletedInternal
} from './contentRuntimeUtils';
import {
  onCommunityPostImageFinalizedInternal,
  uploadCommunityImageToHostingInternal
} from './contentImageRuntimeUtils';
import {
  onOfficialNewsReceivedInternal,
  onCommunityPostsReceivedInternal
} from './contentSyncRuntimeUtils';
import { submitSurveyVoteInternal, completeExpiredSurveysInternal } from './surveyRuntimeUtils';
import { handleAdEventCreatedInternal } from './adRuntimeUtils';
import {
  getLotteryUserTicketExtrasInternal,
  listLotteriesForAdminInternal,
  grantLotteryUserExtraTicketsInternal
} from './lotteryAdminRuntimeUtils';
import {
  updateUserManagementInternal,
  getUsersSocialConnectionsInternal
} from './userAdminRuntimeUtils';
import {
  enterLotteryInternal,
  drawLotteryWinnerInternal
} from './lotteryRuntimeUtils';
import {
  buildContentTargetFromDoc,
  invalidateNotificationRecipientCache,
  loadNotificationActorIdentity,
  purgeOldNotificationsInternal,
  subscribeTokenToPushTopics,
  unsubscribeTokenFromPushTopics,
  writeNotificationEvent
} from './notificationRuntimeUtils';
import { sendTestPushToAllUsersInternal } from './notificationRuntimeUtils';

admin.initializeApp();
const db = admin.firestore();

const LIKE_WRITER_CALLABLE = 'callable_toggle_v1';
const COMMUNITY_THUMBNAIL_BUCKET = process.env.COMMUNITY_IMAGES_BUCKET || 'cdeluar-ddefc-storage';
const CONTENT_SLUG_MAX_LENGTH = 96;
const NOTIFICATION_PAGE_SIZE = 300;
const NOTIFICATION_RETENTION_DAYS = 30;
const NOTIFICATION_DEVICE_ID_MAX_LENGTH = 120;

// 1. Likes
export const onLikeAdded = functions.firestore
  .document('content/{contentId}/likes/{userId}')
  .onCreate(async (snap, context) => {
    const { contentId, userId: actorUserId } = context.params;
    const likeData = snap.data() || {};
    try {
      const contentRef = db.collection('content').doc(contentId);
      const contentSnap = await contentRef.get();
      if (!contentSnap.exists) return;

      const contentData = contentSnap.data() || {};
      if (contentData.deletedAt != null) return;

      if (likeData.writer !== LIKE_WRITER_CALLABLE) {
        await contentRef.update({
          'stats.likesCount': admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      const recipientUserId = sanitizeBoundedString(contentData.userId, 128);
      if (!recipientUserId) return;

      const actor = await loadNotificationActorIdentity(db, actorUserId);
      const contentTarget = buildContentTargetFromDoc(contentId, contentData);
      await writeNotificationEvent(db, {
        type: 'like',
        recipientUserId,
        actor,
        notificationId: `like_${actorUserId}_${contentId}`,
        contentTarget,
        targetPath: contentTarget.targetPath
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

// 2. Secrets
export const createSecretCallable = functions.https.onCall(async (data, context) => {
  const textRaw = sanitizeSecretText(data?.text, SECRET_TEXT_MAX_ABSOLUTE);

  const sex = normalizeSecretSex(data?.sex);
  const age = normalizeSecretAge(data?.age);
  const category = normalizeSecretCategory(data?.category);
  const zone = normalizeSecretZone(data?.zone);
  const fingerprintHash = buildSecretFingerprintHash(data, context);
  const nowMs = Date.now();
  const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);
  const oneDayMs = 24 * 60 * 60 * 1000;

  const modulesConfigRef = db.collection('_config').doc('modules');
  const secretSettingsRef = db.collection('_config').doc('secret_settings');
  const secretCounterRef = db.collection('_counters').doc('secret_ids');
  const rateLimitRef = db.collection('secret_rate_limits').doc(fingerprintHash);
  const fingerprintRef = db.collection('secret_fingerprints').doc(fingerprintHash);

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, secretSettingsSnap, secretCounterSnap, rateLimitSnap, fingerprintSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(secretSettingsRef),
      tx.get(secretCounterRef),
      tx.get(rateLimitRef),
      tx.get(fingerprintRef)
    ]);

    if (!isSecretsModuleEnabled(modulesConfigSnap.data())) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El modulo de secretos esta deshabilitado.'
      );
    }

    const runtimeSettings = resolveSecretRuntimeSettings(secretSettingsSnap.data());
    const text = sanitizeSecretText(textRaw, runtimeSettings.maxTextLength);
    if (text.length < runtimeSettings.minTextLength) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        `El secreto debe tener al menos ${runtimeSettings.minTextLength} caracteres.`
      );
    }
    if (!hasMeaningfulSecretText(text)) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Escribe un texto real, no solo emojis o simbolos.'
      );
    }

    const rateLimitData = rateLimitSnap.data() || {};
    let burstWindowStartMs = timestampToMillisOrZero(rateLimitData.burstWindowStart);
    let burstCount = Number(rateLimitData.burstCount || 0);

    // Reiniciar ráfaga si ya pasó el tiempo
    if (!burstWindowStartMs || nowMs - burstWindowStartMs >= runtimeSettings.createCooldownMs) {
      burstWindowStartMs = nowMs;
      burstCount = 0;
    }

    if (burstCount >= 3) {
      const elapsed = nowMs - burstWindowStartMs;
      const remainingMin = Math.max(
        1,
        Math.ceil((runtimeSettings.createCooldownMs - elapsed) / (60 * 1000))
      );
      throw new functions.https.HttpsError(
        'failed-precondition',
        `Has publicado demasiados secretos rapido. Espera ${remainingMin} min para publicar otro.`
      );
    }

    let dailyWindowStartMs = timestampToMillisOrZero(rateLimitData.dailyWindowStart);
    let dailyCount = Number(rateLimitData.dailyCount || 0);
    if (!dailyWindowStartMs || nowMs - dailyWindowStartMs >= oneDayMs) {
      dailyWindowStartMs = nowMs;
      dailyCount = 0;
    }

    if (dailyCount >= runtimeSettings.dailyLimit) {
      throw new functions.https.HttpsError(
        'resource-exhausted',
        'Alcanzaste el limite diario de secretos anonimos.'
      );
    }

    const counterData = secretCounterSnap.data() || {};
    const lastIssuedId = Math.max(
      SECRET_NUMERIC_ID_START - 1,
      Math.floor(Number(counterData.lastIssuedId || 0))
    );
    let nextSecretNumericId = lastIssuedId + 1;
    let secretRef = db.collection('content').doc(String(nextSecretNumericId));
    let secretSnap = await tx.get(secretRef);
    while (secretSnap.exists) {
      nextSecretNumericId += 1;
      secretRef = db.collection('content').doc(String(nextSecretNumericId));
      secretSnap = await tx.get(secretRef);
    }

    tx.set(
      secretCounterRef,
      {
        lastIssuedId: nextSecretNumericId,
        startFrom: SECRET_NUMERIC_ID_START,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    const secretId = String(nextSecretNumericId);
    const alias = createSecretAlias(fingerprintHash, secretId);
    const initialRank = computeSecretRank(0, 0, 0, nowMs);

    tx.set(secretRef, {
      module: 'secrets',
      type: 'secret',
      source: 'anonymous',
      isOficial: false,
      titulo: '',
      descripcion: text,
      category: category || null,
      zone: zone || null,
      sex,
      age,
      anonAlias: alias,
      stats: {
        upVotesCount: 0,
        downVotesCount: 0,
        commentsCount: 0,
        reportsCount: 0,
        viewsCount: 0,
        totalVotesCount: 0
      },
      rank: {
        score: initialRank.score,
        hotScore: initialRank.hotScore,
        controversyScore: initialRank.controversyScore,
        trend: initialRank.trend
      },
      moderation: {
        status: 'active',
        reason: null,
        reviewedBy: null,
        reviewedAt: null
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedAt: null
    });

    const nextRateLimit: Record<string, unknown> = {
      lastSecretAt: nowTs,
      dailyCount: dailyCount + 1,
      dailyWindowStart: admin.firestore.Timestamp.fromMillis(dailyWindowStartMs),
      burstWindowStart: admin.firestore.Timestamp.fromMillis(burstWindowStartMs),
      burstCount: burstCount + 1,
      expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + SECRET_FINGERPRINT_TTL_MS),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const preservedLastCommentAt = rateLimitData.lastCommentAt;
    if (preservedLastCommentAt instanceof admin.firestore.Timestamp) {
      nextRateLimit.lastCommentAt = preservedLastCommentAt;
    }

    tx.set(rateLimitRef, nextRateLimit, { merge: true });

    const existingFirstSeenAt =
      (fingerprintSnap.data()?.firstSeenAt instanceof admin.firestore.Timestamp)
        ? fingerprintSnap.data()?.firstSeenAt
        : nowTs;

    tx.set(
      fingerprintRef,
      {
        firstSeenAt: existingFirstSeenAt,
        lastSeenAt: nowTs,
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + SECRET_FINGERPRINT_TTL_MS),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      status: 'ok',
      secretId,
      anonAlias: alias
    };
  });
});

export const voteSecretCallable = functions.https.onCall(async (data, context) => {
  const secretId = typeof data?.secretId === 'string' ? data.secretId.trim() : '';
  const voteRaw = Number(data?.vote);
  const vote = voteRaw === -1 ? -1 : 1;
  if (!secretId) {
    throw new functions.https.HttpsError('invalid-argument', 'secretId es obligatorio.');
  }
  if (voteRaw !== 1 && voteRaw !== -1) {
    throw new functions.https.HttpsError('invalid-argument', 'vote debe ser 1 o -1.');
  }

  const fingerprintHash = buildSecretFingerprintHash(data, context);
  const nowMs = Date.now();
  const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);

  const modulesConfigRef = db.collection('_config').doc('modules');
  const secretRef = db.collection('content').doc(secretId);
  const voteRef = secretRef.collection('secret_votes').doc(fingerprintHash);
  const fingerprintRef = db.collection('secret_fingerprints').doc(fingerprintHash);

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, secretSnap, voteSnap, fingerprintSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(secretRef),
      tx.get(voteRef),
      tx.get(fingerprintRef)
    ]);

    if (!isSecretsModuleEnabled(modulesConfigSnap.data())) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El modulo de secretos esta deshabilitado.'
      );
    }
    if (!secretSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'El secreto no existe.');
    }

    const secretData = secretSnap.data() || {};
    if (secretData.module !== 'secrets' || secretData.deletedAt != null) {
      throw new functions.https.HttpsError('failed-precondition', 'El secreto no esta disponible.');
    }
    const moderationStatus = sanitizeBoundedString(secretData?.moderation?.status, 40) || 'active';
    if (moderationStatus !== 'active') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Este secreto no acepta interacciones por moderacion.'
      );
    }

    const previousVote = voteSnap.exists
      ? Number(voteSnap.data()?.vote || 0)
      : 0;
    if (previousVote === vote) {
      return {
        status: 'ok',
        secretId,
        unchanged: true,
        vote
      };
    }

    let upVotesCount = Math.max(0, Math.floor(Number(secretData?.stats?.upVotesCount || 0)));
    let downVotesCount = Math.max(0, Math.floor(Number(secretData?.stats?.downVotesCount || 0)));
    const commentsCount = Math.max(0, Math.floor(Number(secretData?.stats?.commentsCount || 0)));

    if (previousVote === 1) upVotesCount = Math.max(0, upVotesCount - 1);
    if (previousVote === -1) downVotesCount = Math.max(0, downVotesCount - 1);

    if (vote === 1) upVotesCount += 1;
    if (vote === -1) downVotesCount += 1;

    const createdAtMs = timestampToMillisOrZero(secretData.createdAt) || nowMs;
    const rank = computeSecretRank(upVotesCount, downVotesCount, commentsCount, createdAtMs);

    const existingVoteCreatedAt = voteSnap.data()?.createdAt;
    tx.set(
      voteRef,
      {
        vote,
        createdAt: existingVoteCreatedAt instanceof admin.firestore.Timestamp
          ? existingVoteCreatedAt
          : admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    tx.update(secretRef, {
      'stats.upVotesCount': upVotesCount,
      'stats.downVotesCount': downVotesCount,
      'stats.totalVotesCount': upVotesCount + downVotesCount,
      'rank.score': rank.score,
      'rank.hotScore': rank.hotScore,
      'rank.controversyScore': rank.controversyScore,
      'rank.trend': rank.trend,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const existingFirstSeenAt =
      (fingerprintSnap.data()?.firstSeenAt instanceof admin.firestore.Timestamp)
        ? fingerprintSnap.data()?.firstSeenAt
        : nowTs;

    tx.set(
      fingerprintRef,
      {
        firstSeenAt: existingFirstSeenAt,
        lastSeenAt: nowTs,
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + SECRET_FINGERPRINT_TTL_MS),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      status: 'ok',
      secretId,
      vote,
      upVotesCount,
      downVotesCount,
      score: rank.score,
      trend: rank.trend
    };
  });
});

export const createSecretCommentCallable = functions.https.onCall(async (data, context) => {
  const secretId = typeof data?.secretId === 'string' ? data.secretId.trim() : '';
  if (!secretId) {
    throw new functions.https.HttpsError('invalid-argument', 'secretId es obligatorio.');
  }

  const text = sanitizeSecretText(data?.text, SECRET_COMMENT_MAX_LENGTH);
  if (text.length < SECRET_COMMENT_MIN_LENGTH) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      `El comentario debe tener al menos ${SECRET_COMMENT_MIN_LENGTH} caracteres.`
    );
  }
  if (!hasMeaningfulSecretText(text)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Escribe un comentario valido.'
    );
  }

  const fingerprintHash = buildSecretFingerprintHash(data, context);
  const nowMs = Date.now();
  const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);

  const modulesConfigRef = db.collection('_config').doc('modules');
  const secretSettingsRef = db.collection('_config').doc('secret_settings');
  const secretRef = db.collection('content').doc(secretId);
  const rateLimitRef = db.collection('secret_rate_limits').doc(fingerprintHash);
  const fingerprintRef = db.collection('secret_fingerprints').doc(fingerprintHash);

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, secretSettingsSnap, secretSnap, rateLimitSnap, fingerprintSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(secretSettingsRef),
      tx.get(secretRef),
      tx.get(rateLimitRef),
      tx.get(fingerprintRef)
    ]);

    if (!isSecretsModuleEnabled(modulesConfigSnap.data())) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El modulo de secretos esta deshabilitado.'
      );
    }
    if (!secretSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'El secreto no existe.');
    }

    const secretData = secretSnap.data() || {};
    if (secretData.module !== 'secrets' || secretData.deletedAt != null) {
      throw new functions.https.HttpsError('failed-precondition', 'El secreto no esta disponible.');
    }
    const moderationStatus = sanitizeBoundedString(secretData?.moderation?.status, 40) || 'active';
    if (moderationStatus !== 'active') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Este secreto no permite comentarios.'
      );
    }

    const runtimeSettings = resolveSecretRuntimeSettings(secretSettingsSnap.data());
    const rateLimitData = rateLimitSnap.data() || {};
    const lastCommentAtMs = timestampToMillisOrZero(rateLimitData.lastCommentAt);
    if (lastCommentAtMs > 0) {
      const elapsed = nowMs - lastCommentAtMs;
      if (elapsed < runtimeSettings.commentCooldownMs) {
        const remaining = Math.max(1, Math.ceil((runtimeSettings.commentCooldownMs - elapsed) / 1000));
        throw new functions.https.HttpsError(
          'failed-precondition',
          `Espera ${remaining}s antes de comentar de nuevo.`
        );
      }
    }

    const commentRef = secretRef.collection('secret_comments').doc();
    const alias = createSecretAlias(fingerprintHash, `${secretId}:${commentRef.id}`);

    const upVotesCount = Math.max(0, Math.floor(Number(secretData?.stats?.upVotesCount || 0)));
    const downVotesCount = Math.max(0, Math.floor(Number(secretData?.stats?.downVotesCount || 0)));
    const commentsCount = Math.max(0, Math.floor(Number(secretData?.stats?.commentsCount || 0))) + 1;
    const createdAtMs = timestampToMillisOrZero(secretData.createdAt) || nowMs;
    const rank = computeSecretRank(upVotesCount, downVotesCount, commentsCount, createdAtMs);

    tx.set(commentRef, {
      text,
      anonAlias: alias,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedAt: null,
      score: 0,
      reportsCount: 0
    });

    tx.update(secretRef, {
      'stats.commentsCount': commentsCount,
      'rank.score': rank.score,
      'rank.hotScore': rank.hotScore,
      'rank.controversyScore': rank.controversyScore,
      'rank.trend': rank.trend,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const nextRateLimit: Record<string, unknown> = {
      lastCommentAt: nowTs,
      expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + SECRET_FINGERPRINT_TTL_MS),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const preservedLastSecretAt = rateLimitData.lastSecretAt;
    const preservedDailyCount = Number(rateLimitData.dailyCount || 0);
    const preservedDailyWindowStart = rateLimitData.dailyWindowStart;
    if (preservedLastSecretAt instanceof admin.firestore.Timestamp) {
      nextRateLimit.lastSecretAt = preservedLastSecretAt;
    }
    if (preservedDailyCount > 0) {
      nextRateLimit.dailyCount = preservedDailyCount;
    }
    if (preservedDailyWindowStart instanceof admin.firestore.Timestamp) {
      nextRateLimit.dailyWindowStart = preservedDailyWindowStart;
    }

    tx.set(rateLimitRef, nextRateLimit, { merge: true });

    const existingFirstSeenAt =
      (fingerprintSnap.data()?.firstSeenAt instanceof admin.firestore.Timestamp)
        ? fingerprintSnap.data()?.firstSeenAt
        : nowTs;

    tx.set(
      fingerprintRef,
      {
        firstSeenAt: existingFirstSeenAt,
        lastSeenAt: nowTs,
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + SECRET_FINGERPRINT_TTL_MS),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      status: 'ok',
      secretId,
      commentId: commentRef.id,
      anonAlias: alias
    };
  });
});

export const reportSecretCallable = functions.https.onCall(async (data, context) => {
  const secretId = typeof data?.secretId === 'string' ? data.secretId.trim() : '';
  if (!secretId) {
    throw new functions.https.HttpsError('invalid-argument', 'secretId es obligatorio.');
  }

  const reason = normalizeSecretReportReason(data?.reason);
  const fingerprintHash = buildSecretFingerprintHash(data, context);
  const nowMs = Date.now();
  const nowTs = admin.firestore.Timestamp.fromMillis(nowMs);

  const modulesConfigRef = db.collection('_config').doc('modules');
  const secretSettingsRef = db.collection('_config').doc('secret_settings');
  const secretRef = db.collection('content').doc(secretId);
  const reportRef = secretRef.collection('secret_reports').doc(fingerprintHash);
  const fingerprintRef = db.collection('secret_fingerprints').doc(fingerprintHash);

  return db.runTransaction(async (tx) => {
    const [modulesConfigSnap, secretSettingsSnap, secretSnap, reportSnap, fingerprintSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(secretSettingsRef),
      tx.get(secretRef),
      tx.get(reportRef),
      tx.get(fingerprintRef)
    ]);

    if (!isSecretsModuleEnabled(modulesConfigSnap.data())) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El modulo de secretos esta deshabilitado.'
      );
    }
    if (!secretSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'El secreto no existe.');
    }

    const secretData = secretSnap.data() || {};
    if (secretData.module !== 'secrets' || secretData.deletedAt != null) {
      throw new functions.https.HttpsError('failed-precondition', 'El secreto no esta disponible.');
    }

    if (reportSnap.exists) {
      return {
        status: 'already_reported',
        secretId
      };
    }

    const runtimeSettings = resolveSecretRuntimeSettings(secretSettingsSnap.data());
    const reportsCount = Math.max(0, Math.floor(Number(secretData?.stats?.reportsCount || 0))) + 1;
    const currentStatus = sanitizeBoundedString(secretData?.moderation?.status, 40) || 'active';
    const currentReason = secretData?.moderation?.reason ?? null;

    let nextStatus = currentStatus;
    let nextReason = currentReason;
    if (currentStatus === 'active' && reportsCount >= runtimeSettings.autoHideReportsThreshold) {
      nextStatus = 'hidden_auto';
      nextReason = 'report_threshold';
    }

    tx.set(reportRef, {
      reason,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    tx.update(secretRef, {
      'stats.reportsCount': reportsCount,
      'moderation.status': nextStatus,
      'moderation.reason': nextReason,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const existingFirstSeenAt =
      (fingerprintSnap.data()?.firstSeenAt instanceof admin.firestore.Timestamp)
        ? fingerprintSnap.data()?.firstSeenAt
        : nowTs;

    tx.set(
      fingerprintRef,
      {
        firstSeenAt: existingFirstSeenAt,
        lastSeenAt: nowTs,
        expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + SECRET_FINGERPRINT_TTL_MS),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    return {
      status: 'ok',
      secretId,
      reportsCount,
      moderationStatus: nextStatus
    };
  });
});

export const getSecretModerationQueueCallable = functions.https.onCall(async (data, context) => {
  await assertAdminUser(db, context.auth);

  const statusFilter = normalizeSecretModerationStatusFilter(data?.status);
  const limitValue = clampInteger(data?.limit, 10, 200, 80);

  let moderationQuery: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = db
    .collection('content')
    .where('module', '==', 'secrets')
    .where('deletedAt', '==', null);

  if (statusFilter !== 'all') {
    moderationQuery = moderationQuery.where('moderation.status', '==', statusFilter);
  }

  moderationQuery = moderationQuery.orderBy('createdAt', 'desc').limit(limitValue);
  const snapshot = await moderationQuery.get();

  const items = snapshot.docs.map((docSnap) => {
    const data = docSnap.data() || {};
    return {
      secretId: docSnap.id,
      textPreview: sanitizeSecretText(data.descripcion, 280),
      category: sanitizeBoundedString(data.category, 40),
      zone: sanitizeBoundedString(data.zone, 60),
      createdAtMs: timestampToMillisOrZero(data.createdAt),
      updatedAtMs: timestampToMillisOrZero(data.updatedAt),
      moderation: {
        status: sanitizeBoundedString(data?.moderation?.status, 40) || 'active',
        reason: sanitizeBoundedString(data?.moderation?.reason, 180),
        reviewedBy: sanitizeBoundedString(data?.moderation?.reviewedBy, 128),
        reviewedAtMs: timestampToMillisOrZero(data?.moderation?.reviewedAt)
      },
      stats: {
        upVotesCount: Math.max(0, Math.floor(Number(data?.stats?.upVotesCount || 0))),
        downVotesCount: Math.max(0, Math.floor(Number(data?.stats?.downVotesCount || 0))),
        commentsCount: Math.max(0, Math.floor(Number(data?.stats?.commentsCount || 0))),
        reportsCount: Math.max(0, Math.floor(Number(data?.stats?.reportsCount || 0))),
        totalVotesCount: Math.max(0, Math.floor(Number(data?.stats?.totalVotesCount || 0)))
      }
    };
  });

  return {
    status: 'ok',
    filter: statusFilter,
    count: items.length,
    items,
    fetchedAtMs: Date.now()
  };
});

export const moderateSecretCallable = functions.https.onCall(async (data, context) => {
  await assertAdminUser(db, context.auth);

  const secretId = sanitizeBoundedString(data?.secretId, 128);
  if (!secretId) {
    throw new functions.https.HttpsError('invalid-argument', 'secretId es obligatorio.');
  }

  const action = normalizeSecretModerationAction(data?.action);
  const reasonInput = sanitizeSecretText(data?.reason, 180);
  const reviewerUid = context.auth?.uid || 'admin';

  const secretRef = db.collection('content').doc(secretId);

  return db.runTransaction(async (tx) => {
    const secretSnap = await tx.get(secretRef);
    if (!secretSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'El secreto no existe.');
    }
    const secretData = secretSnap.data() || {};
    if (secretData.module !== 'secrets' || secretData.deletedAt != null) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'El secreto no esta disponible para moderacion.'
      );
    }

    let moderationStatus: 'active' | 'hidden_admin' | 'blocked' = 'active';
    let moderationReason: string | null = null;

    if (action === 'hide') {
      moderationStatus = 'hidden_admin';
      moderationReason = reasonInput || 'hidden_by_admin';
    } else if (action === 'block') {
      moderationStatus = 'blocked';
      moderationReason = reasonInput || 'blocked_by_admin';
    } else {
      moderationStatus = 'active';
      moderationReason = null;
    }

    tx.update(secretRef, {
      'moderation.status': moderationStatus,
      'moderation.reason': moderationReason,
      'moderation.reviewedBy': reviewerUid,
      'moderation.reviewedAt': admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      status: 'ok',
      secretId,
      moderationStatus,
      action
    };
  });
});

export const refreshSecretRankingsCallable = functions.https.onCall(async (_data, context) => {
  await assertStaffUser(db, context.auth);
  const rankings = await refreshSecretRankingsInternal();
  const lists = (rankings.lists || {}) as Record<string, unknown[]>;

  return {
    status: 'ok',
    generatedAtMs: Number(rankings.generatedAtMs || Date.now()),
    sourceSampleSize: Number((rankings.source as any)?.sampleSize || 0),
    counts: {
      topDay: Array.isArray(lists.topDay) ? lists.topDay.length : 0,
      mostCommented: Array.isArray(lists.mostCommented) ? lists.mostCommented.length : 0,
      mostVoted: Array.isArray(lists.mostVoted) ? lists.mostVoted.length : 0,
      mostPolemic: Array.isArray(lists.mostPolemic) ? lists.mostPolemic.length : 0
    }
  };
});

export const refreshSecretRankings = functions.pubsub
  .schedule('every 5 minutes')
  .onRun(async () => {
    const rankings = await refreshSecretRankingsInternal();
    const sampleSize = Number((rankings.source as any)?.sampleSize || 0);
    console.log(`Secret rankings refreshed. sampleSize=${sampleSize}`);
    return null;
  });

// 2. Comments
export const onCommentCreated = functions.firestore
  .document('content/{contentId}/comments/{commentId}')
  .onCreate(async (snap, context) => {
    const { contentId, commentId } = context.params;
    const commentData = snap.data();
    if (!commentData || !commentData.userId || commentData.deletedAt != null) return;

    try {
      const contentRef = db.collection('content').doc(contentId);
      await contentRef.set(
        {
          stats: {
            commentsCount: admin.firestore.FieldValue.increment(1)
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      const contentSnap = await contentRef.get();
      if (!contentSnap.exists) return;
      const contentData = contentSnap.data() || {};
      if (contentData.deletedAt != null) return;

      const recipientUserId = sanitizeBoundedString(contentData.userId, 128);
      const actorUserId = sanitizeBoundedString(commentData.userId, 128);
      if (!recipientUserId || !actorUserId) return;

      const actor = await loadNotificationActorIdentity(db, actorUserId);
      const contentTarget = buildContentTargetFromDoc(contentId, contentData);
      await writeNotificationEvent(db, {
        type: 'comment',
        recipientUserId,
        actor,
        commentId,
        contentTarget,
        targetPath: contentTarget.targetPath
      });

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
    const { contentId, commentId, replyId } = context.params;
    const replyData = snap.data();
    if (!replyData || !replyData.userId || replyData.deletedAt != null) return;

    try {
      const commentRef = buildCommentRef(db, contentId, commentId);
      await commentRef.set(
        {
          stats: {
            repliesCount: admin.firestore.FieldValue.increment(1)
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      const [commentSnap, contentSnap] = await Promise.all([
        commentRef.get(),
        db.collection('content').doc(contentId).get()
      ]);
      if (!commentSnap.exists) return;

      const parentCommentData = commentSnap.data() || {};
      if (parentCommentData.deletedAt != null) return;

      const recipientUserId = sanitizeBoundedString(parentCommentData.userId, 128);
      const actorUserId = sanitizeBoundedString(replyData.userId, 128);
      if (!recipientUserId || !actorUserId) return;

      const actor = await loadNotificationActorIdentity(db, actorUserId);
      const fallbackModule: 'news' | 'community' = replyData.module === 'news'
        ? 'news'
        : 'community';
      const contentTarget = contentSnap.exists
        ? buildContentTargetFromDoc(contentId, contentSnap.data() || {})
        : {
          contentId,
          contentModule: fallbackModule,
          contentPublicRef: contentId,
          contentSlug: normalizeContentSlug(contentId),
          targetPath: `/c/${encodeURIComponent(contentId)}/${encodeURIComponent(normalizeContentSlug(contentId))}`
        };
      await writeNotificationEvent(db, {
        type: 'reply',
        recipientUserId,
        actor,
        commentId,
        replyId,
        contentTarget,
        targetPath: contentTarget.targetPath
      });

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
      await buildCommentRef(db, contentId, commentId).set(
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

      const actor = await loadNotificationActorIdentity(db, followerId);
      const targetPath = buildProfileTargetPath(actor.actorUsername, actor.userId);
      await writeNotificationEvent(db, {
        type: 'follow',
        recipientUserId: userId,
        actor,
        targetPath
      });

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

export const updateMyProfile = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para actualizar tu perfil.'
    );
  }

  const authToken = (context.auth?.token || {}) as Record<string, unknown>;
  const emailFromToken = typeof authToken.email === 'string' ? authToken.email : '';

  const { username, usernameLower } = normalizeUsernameStrict(data?.username);
  const nombre = sanitizeBoundedString(data?.nombre, 120);
  if (!nombre) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'nombre es obligatorio.'
    );
  }

  const bio = sanitizeBoundedString(data?.bio, 280);
  const location = sanitizeBoundedString(data?.location, 120);
  const website = sanitizeOptionalUrl(data?.website, 'website');
  const profilePictureUrl = sanitizeBoundedString(data?.profilePictureUrl, 1200);

  const userRef = db.collection('users').doc(userId);
  const userPublicRef = db.collection('users_public').doc(userId);
  const usernameRef = db.collection('usernames').doc(usernameLower);

  const result = await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const currentData = userSnap.exists
      ? (userSnap.data() || {})
      : ({} as FirebaseFirestore.DocumentData);

    const currentIdentity = normalizeUsernameLoose(userId, currentData);
    const previousUsernameLower = currentIdentity.usernameLower;
    const previousUsernameRef = db.collection('usernames').doc(previousUsernameLower);

    const usernameSnap = await tx.get(usernameRef);
    if (usernameSnap.exists && usernameSnap.data()?.uid !== userId) {
      throw new functions.https.HttpsError(
        'already-exists',
        'Ese username ya esta en uso.'
      );
    }

    if (previousUsernameLower !== usernameLower) {
      const previousUsernameSnap = await tx.get(previousUsernameRef);
      if (previousUsernameSnap.exists && previousUsernameSnap.data()?.uid === userId) {
        tx.delete(previousUsernameRef);
      }
    }

    const mergedStats = ensureUserStats(currentData.stats);
    const mergedSettings = ensureUserSettings(currentData.settings);

    const nextProfile: FirebaseFirestore.DocumentData = {
      id: userId,
      email: sanitizeBoundedString(currentData.email, 255) || emailFromToken,
      nombre,
      username,
      usernameLower,
      bio,
      location,
      website,
      profilePictureUrl,
      rol: typeof currentData.rol === 'string' ? currentData.rol : 'user',
      isVerified: currentData.isVerified === true,
      stats: mergedStats,
      settings: mergedSettings,
      createdAt: currentData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    tx.set(userRef, nextProfile, { merge: true });
    tx.set(
      usernameRef,
      {
        uid: userId,
        username,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    const publicProfile = buildPublicUserProfile(userId, nextProfile);
    tx.set(userPublicRef, publicProfile, { merge: true });

    return {
      profile: {
        id: userId,
        email: nextProfile.email,
        nombre,
        username,
        usernameLower,
        bio,
        location,
        website,
        profilePictureUrl,
        rol: nextProfile.rol,
        isVerified: nextProfile.isVerified,
        stats: mergedStats,
        settings: mergedSettings
      },
      publicProfile: {
        userId,
        username,
        usernameLower,
        nombre,
        bio,
        location,
        website,
        profilePictureUrl,
        isVerified: nextProfile.isVerified,
        stats: mergedStats
      }
    };
  });

  return {
    ok: true,
    ...result
  };
});

export const updateNotificationPreferences = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para configurar notificaciones.'
    );
  }

  const userRef = db.collection('users').doc(userId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError(
      'not-found',
      'No se encontro el perfil del usuario.'
    );
  }

  const currentSettings = ensureUserSettings(userSnap.data()?.settings);
  const currentTypes = ensureNotificationTypeSettings(currentSettings.notificationTypes);
  const hasNotificationsEnabled = Object.prototype.hasOwnProperty.call(data || {}, 'notificationsEnabled');
  const hasLikes = Object.prototype.hasOwnProperty.call(data || {}, 'likes');
  const hasComments = Object.prototype.hasOwnProperty.call(data || {}, 'comments');
  const hasReplies = Object.prototype.hasOwnProperty.call(data || {}, 'replies');
  const hasFollows = Object.prototype.hasOwnProperty.call(data || {}, 'follows');

  const nextSettings = {
    ...currentSettings,
    privateAccount: currentSettings.privateAccount === true,
    notificationsEnabled: hasNotificationsEnabled
      ? data.notificationsEnabled === true
      : currentSettings.notificationsEnabled !== false,
    notificationTypes: {
      likes: hasLikes ? data.likes === true : currentTypes.likes,
      comments: hasComments ? data.comments === true : currentTypes.comments,
      replies: hasReplies ? data.replies === true : currentTypes.replies,
      follows: hasFollows ? data.follows === true : currentTypes.follows
    }
  };

  await userRef.set(
    {
      settings: nextSettings,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  invalidateNotificationRecipientCache(userId);

  return {
    ok: true,
    settings: nextSettings
  };
});

export const updateHomeFeedPreference = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para configurar tu feed.'
    );
  }

  const rawDefaultFeedTab = sanitizeBoundedString(data?.defaultFeedTab, 40).toLowerCase();
  if (!['todo', 'news', 'post', 'surveys', 'lottery'].includes(rawDefaultFeedTab)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'defaultFeedTab invalido. Valores permitidos: todo, news, post, surveys, lottery.'
    );
  }

  const userRef = db.collection('users').doc(userId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError(
      'not-found',
      'No se encontro el perfil del usuario.'
    );
  }

  const currentSettings = ensureUserSettings(userSnap.data()?.settings);
  const nextSettings = {
    ...currentSettings,
    defaultFeedTab: rawDefaultFeedTab
  };

  await userRef.set(
    {
      settings: nextSettings,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return {
    ok: true,
    settings: nextSettings
  };
});

export const registerNotificationDevice = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para registrar un dispositivo.'
    );
  }

  const token = sanitizeBoundedString(data?.token, 4096);
  if (!token) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'token es obligatorio.'
    );
  }

  const platformRaw = sanitizeBoundedString(data?.platform, 20).toLowerCase();
  if (platformRaw !== 'web' && platformRaw !== 'android') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'platform debe ser "web" o "android".'
    );
  }
  const platform = platformRaw as NotificationPlatform;
  const deviceId = sanitizeNotificationDeviceId(data?.deviceId, token, platform);
  const locale = sanitizeBoundedString(data?.locale, 64);
  const timezone = sanitizeBoundedString(data?.timezone, 80);
  const userAgent = sanitizeBoundedString(data?.userAgent, 255);

  const devicesCollection = db.collection('users').doc(userId).collection('notification_devices');
  const deviceRef = devicesCollection.doc(deviceId);

  await db.runTransaction(async (tx) => {
    const deviceSnap = await tx.get(deviceRef);
    const previous = deviceSnap.data() || {};

    tx.set(
      deviceRef,
      {
        token,
        platform,
        enabled: true,
        locale,
        timezone,
        userAgent,
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: deviceSnap.exists
          ? (previous.createdAt || admin.firestore.FieldValue.serverTimestamp())
          : admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });

  const duplicatesSnap = await devicesCollection.where('token', '==', token).get();
  const duplicatesToDelete = duplicatesSnap.docs
    .filter((docSnap) => docSnap.id !== deviceId)
    .map((docSnap) => docSnap.ref);

  if (duplicatesToDelete.length > 0) {
    const batch = db.batch();
    for (const duplicateRef of duplicatesToDelete) {
      batch.delete(duplicateRef);
    }
    await batch.commit();
  }

  await subscribeTokenToPushTopics(token, platform);

  return {
    ok: true,
    deviceId,
    platform
  };
});

export const unregisterNotificationDevice = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para eliminar un dispositivo.'
    );
  }

  const devicesCollection = db.collection('users').doc(userId).collection('notification_devices');
  const deviceId = sanitizeBoundedString(data?.deviceId, NOTIFICATION_DEVICE_ID_MAX_LENGTH);
  const token = sanitizeBoundedString(data?.token, 4096);

  if (!deviceId && !token) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Debes enviar deviceId o token.'
    );
  }

  const refsToDelete: FirebaseFirestore.DocumentReference[] = [];
  const devicesToUnsubscribe: Array<{ token: string; platform: NotificationPlatform }> = [];
  if (deviceId) {
    const targetRef = devicesCollection.doc(deviceId);
    const targetSnap = await targetRef.get();
    if (targetSnap.exists) {
      const targetData = targetSnap.data() || {};
      const targetToken = sanitizeBoundedString(targetData.token, 4096);
      const targetPlatformRaw = sanitizeBoundedString(targetData.platform, 20).toLowerCase();
      if (targetToken && (targetPlatformRaw === 'web' || targetPlatformRaw === 'android')) {
        devicesToUnsubscribe.push({
          token: targetToken,
          platform: targetPlatformRaw as NotificationPlatform
        });
      }
    }
    refsToDelete.push(targetRef);
  } else {
    const tokenMatches = await devicesCollection.where('token', '==', token).get();
    for (const docSnap of tokenMatches.docs) {
      const deviceData = docSnap.data() || {};
      const targetToken = sanitizeBoundedString(deviceData.token, 4096);
      const targetPlatformRaw = sanitizeBoundedString(deviceData.platform, 20).toLowerCase();
      if (targetToken && (targetPlatformRaw === 'web' || targetPlatformRaw === 'android')) {
        devicesToUnsubscribe.push({
          token: targetToken,
          platform: targetPlatformRaw as NotificationPlatform
        });
      }
      refsToDelete.push(docSnap.ref);
    }
  }

  if (refsToDelete.length > 0) {
    const batch = db.batch();
    for (const ref of refsToDelete) {
      batch.delete(ref);
    }
    await batch.commit();
  }

  if (devicesToUnsubscribe.length > 0) {
    await Promise.all(
      devicesToUnsubscribe.map((entry) => unsubscribeTokenFromPushTopics(entry.token, entry.platform))
    );
  }

  return {
    ok: true,
    removed: refsToDelete.length
  };
});

export const sendTestPushToAllUsers = functions.https.onCall(async (data, context) => {
  return sendTestPushToAllUsersInternal(db, data, context);

  /*
  await assertAdminUser(db, context.auth);

  const title = sanitizeBoundedString(data?.title, 120) || 'Prueba de notificaciones';
  const body = sanitizeBoundedString(data?.body, 220) || 'Este es un test push para todos los usuarios.';
  const targetPath = safeNotificationPath(data?.targetPath, '/notificaciones');
  const platformRaw = sanitizeBoundedString(data?.platform, 20).toLowerCase();

  const topic = platformRaw === 'android'
    ? 'android_users'
    : platformRaw === 'web'
      ? 'web_users'
      : 'all_users';

  if (platformRaw && platformRaw !== 'android' && platformRaw !== 'web' && platformRaw !== 'all') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'platform debe ser "all", "android" o "web".'
    );
  }

  const messageId = await admin.messaging().send({
    topic,
    notification: {
      title,
      body
    },
    data: {
      type: 'admin_broadcast_test',
      targetPath,
      sentAt: new Date().toISOString()
    },
    android: {
      priority: 'high',
      notification: {
        channelId: ANDROID_PUSH_CHANNEL_ID,
        sound: 'default'
      }
    },
    webpush: {
      fcmOptions: {
        link: targetPath
      }
    }
  });

  return {
    ok: true,
    topic,
    messageId
  };
  */
});

export const markNotificationRead = functions.https.onCall(async (data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para actualizar notificaciones.'
    );
  }

  const notificationId = sanitizeBoundedString(data?.notificationId, 200);
  if (!notificationId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'notificationId es obligatorio.'
    );
  }

  const notificationRef = db.collection('users').doc(userId).collection('notifications').doc(notificationId);
  const notificationSnap = await notificationRef.get();
  if (!notificationSnap.exists) {
    throw new functions.https.HttpsError(
      'not-found',
      'La notificacion no existe.'
    );
  }

  if (notificationSnap.data()?.isRead === true) {
    return {
      ok: true,
      updated: false
    };
  }

  await notificationRef.set(
    {
      isRead: true,
      readAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  return {
    ok: true,
    updated: true
  };
});

export const markAllNotificationsRead = functions.https.onCall(async (_data, context) => {
  const userId = context.auth?.uid;
  if (!userId) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para actualizar notificaciones.'
    );
  }

  const notificationsCollection = db.collection('users').doc(userId).collection('notifications');
  let updatedCount = 0;

  while (true) {
    const unreadSnap = await notificationsCollection
      .where('isRead', '==', false)
      .limit(NOTIFICATION_PAGE_SIZE)
      .get();
    if (unreadSnap.empty) break;

    const batch = db.batch();
    for (const unreadDoc of unreadSnap.docs) {
      batch.set(
        unreadDoc.ref,
        {
          isRead: true,
          readAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }
    await batch.commit();
    updatedCount += unreadSnap.size;

    if (unreadSnap.size < NOTIFICATION_PAGE_SIZE) break;
  }

  return {
    ok: true,
    updatedCount
  };
});

export const updateUserManagement = functions.https.onCall(async (data, context) => {
  return updateUserManagementInternal(db, data, context);
});

export const getUsersSocialConnections = functions.https.onCall(async (data, context) => {
  return getUsersSocialConnectionsInternal(db, data, context);
});

export const getLotteryUserTicketExtras = functions.https.onCall(async (data, context) => {
  return getLotteryUserTicketExtrasInternal(db, data, context);
});

export const listLotteriesForAdmin = functions.https.onCall(async (_data, context) => {
  return listLotteriesForAdminInternal(db, context);
});

export const grantLotteryUserExtraTickets = functions.https.onCall(async (data, context) => {
  return grantLotteryUserExtraTicketsInternal(db, data, context);
});

export const syncPublicUserProfile = functions.firestore
  .document('users/{userId}')
  .onWrite(async (change, context) => {
    const { userId } = context.params;

    if (!change.after.exists) {
      const beforeData = change.before.data() || {};
      const previousIdentity = normalizeUsernameLoose(userId, beforeData);
      const previousUsernameRef = db.collection('usernames').doc(previousIdentity.usernameLower);

      await db.runTransaction(async (tx) => {
        const previousUsernameSnap = await tx.get(previousUsernameRef);
        if (previousUsernameSnap.exists && previousUsernameSnap.data()?.uid === userId) {
          tx.delete(previousUsernameRef);
        }
        tx.delete(db.collection('users_public').doc(userId));
      });
      return null;
    }

    const afterData = change.after.data() || {};
    const beforeData = change.before.exists ? (change.before.data() || {}) : {};
    const currentIdentity = normalizeUsernameLoose(userId, afterData);
    const previousIdentity = normalizeUsernameLoose(userId, beforeData);
    const publicProfile = buildPublicUserProfile(userId, afterData);

    const currentUsernameRef = db.collection('usernames').doc(currentIdentity.usernameLower);
    const previousUsernameRef = db.collection('usernames').doc(previousIdentity.usernameLower);
    const usersPublicRef = db.collection('users_public').doc(userId);

    await db.runTransaction(async (tx) => {
      const currentUsernameSnap = await tx.get(currentUsernameRef);
      if (!currentUsernameSnap.exists || currentUsernameSnap.data()?.uid === userId) {
        tx.set(
          currentUsernameRef,
          {
            uid: userId,
            username: currentIdentity.username,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      } else {
        console.warn(
          `Username collision detected for ${currentIdentity.usernameLower}. Keeping existing owner.`
        );
      }

      if (previousIdentity.usernameLower !== currentIdentity.usernameLower) {
        const previousUsernameSnap = await tx.get(previousUsernameRef);
        if (previousUsernameSnap.exists && previousUsernameSnap.data()?.uid === userId) {
          tx.delete(previousUsernameRef);
        }
      }

      tx.set(usersPublicRef, publicProfile, { merge: true });
    });

    return null;
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
      const usernameChanged = beforeData.username !== afterData.username;

      if (!nameChanged && !pictureChanged && !usernameChanged) return;

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
      if (usernameChanged) {
        const normalizedIdentity = normalizeUsernameLoose(userId, afterData);
        postUpdateData.userUsername = normalizedIdentity.usernameLower;
      }

      const [postsUpdated, commentsUpdated, repliesUpdated] = await Promise.all([
        Object.keys(postUpdateData).length > 0
          ? propagateUserFields(db, 'content', userId, postUpdateData)
          : Promise.resolve(0),
        Object.keys(commentsUpdateData).length > 0
          ? propagateUserFields(db, 'comments', userId, commentsUpdateData)
          : Promise.resolve(0),
        Object.keys(commentsUpdateData).length > 0
          ? propagateUserFields(db, 'replies', userId, commentsUpdateData)
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
export const onContentSlugSync = functions.firestore
  .document('content/{contentId}')
  .onWrite(async (change, context) => {
    if (!change.after.exists) return null;

    const contentRef = change.after.ref;
    const beforeData = change.before.exists ? change.before.data() || {} : {};
    const afterData = change.after.data() || {};

    const beforeSlug = typeof beforeData.slug === 'string' ? beforeData.slug.trim() : '';
    const afterSlug = typeof afterData.slug === 'string' ? afterData.slug.trim() : '';
    const beforeModule = change.before.exists ? inferContentModule(beforeData) : null;
    const afterModule = inferContentModule(afterData);
    const beforePublicId =
      beforeModule === 'news'
        ? extractNewsPublicIdFromPayload(beforeData)
        : '';
    const afterPublicId =
      afterModule === 'news'
        ? extractNewsPublicIdFromPayload(afterData)
        : '';

    const shouldSync =
      !change.before.exists ||
      !afterSlug ||
      beforeSlug !== afterSlug ||
      beforeModule !== afterModule ||
      beforePublicId !== afterPublicId;

    if (!shouldSync) return null;

    try {
      await db.runTransaction(async (transaction) => {
        const freshSnapshot = await transaction.get(contentRef);
        if (!freshSnapshot.exists) return;

        const freshData = freshSnapshot.data() || {};
        const freshModule = inferContentModule(freshData);
        const freshPublicId =
          freshModule === 'news'
            ? extractNewsPublicIdFromPayload(freshData)
            : '';
        const existingSlugRaw =
          typeof freshData.slug === 'string' ? freshData.slug.trim() : '';

        if (existingSlugRaw) {
          const normalizedExistingSlug = normalizeContentSlug(existingSlugRaw);
          const existingSlugKey = buildContentSlugKey(freshModule, normalizedExistingSlug);

          transaction.set(
            db.collection('_content_slugs').doc(existingSlugKey),
            {
              contentId: freshSnapshot.id,
              module: freshModule,
              slug: normalizedExistingSlug,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            { merge: true }
          );

          const normalizedBase = buildContentSlugBase(freshData);
          const syncUpdate: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {};
          if (freshData.slug !== normalizedExistingSlug) syncUpdate.slug = normalizedExistingSlug;
          if (freshData.slugBase !== normalizedBase) syncUpdate.slugBase = normalizedBase;
          if (freshData.slugModule !== freshModule) syncUpdate.slugModule = freshModule;

          if (freshModule === 'news' && freshPublicId) {
            const numericPublicId = Number(freshPublicId);
            if (freshData.publicId !== freshPublicId) syncUpdate.publicId = freshPublicId;
            if (freshData.postId !== numericPublicId) syncUpdate.postId = numericPublicId;

            transaction.set(
              db.collection('_content_public_ids').doc(buildContentPublicIdKey(freshModule, freshPublicId)),
              {
                contentId: freshSnapshot.id,
                module: freshModule,
                publicId: freshPublicId,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              },
              { merge: true }
            );
          }

          if (Object.keys(syncUpdate).length > 0) {
            transaction.set(contentRef, syncUpdate, { merge: true });
          }
          return;
        }

        const slugBase = buildContentSlugBase(freshData);
        let nextSlug = slugBase;
        let attempt = 2;

        while (true) {
          const slugKey = buildContentSlugKey(freshModule, nextSlug);
          const slugRef = db.collection('_content_slugs').doc(slugKey);
          const slugSnapshot = await transaction.get(slugRef);

          if (!slugSnapshot.exists) {
            transaction.set(
              contentRef,
              {
                slug: nextSlug,
                slugBase,
                slugModule: freshModule,
                ...(freshModule === 'news' && freshPublicId
                  ? { publicId: freshPublicId, postId: Number(freshPublicId) }
                  : {})
              },
              { merge: true }
            );

            transaction.set(
              slugRef,
              {
                contentId: freshSnapshot.id,
                module: freshModule,
                slug: nextSlug,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              },
              { merge: true }
            );

            if (freshModule === 'news' && freshPublicId) {
              transaction.set(
                db.collection('_content_public_ids').doc(buildContentPublicIdKey(freshModule, freshPublicId)),
                {
                  contentId: freshSnapshot.id,
                  module: freshModule,
                  publicId: freshPublicId,
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                },
                { merge: true }
              );
            }
            return;
          }

          const mappedId = String(slugSnapshot.data()?.contentId || '').trim();
          if (mappedId === freshSnapshot.id) {
            transaction.set(
              contentRef,
              {
                slug: nextSlug,
                slugBase,
                slugModule: freshModule,
                ...(freshModule === 'news' && freshPublicId
                  ? { publicId: freshPublicId, postId: Number(freshPublicId) }
                  : {})
              },
              { merge: true }
            );

            if (freshModule === 'news' && freshPublicId) {
              transaction.set(
                db.collection('_content_public_ids').doc(buildContentPublicIdKey(freshModule, freshPublicId)),
                {
                  contentId: freshSnapshot.id,
                  module: freshModule,
                  publicId: freshPublicId,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                },
                { merge: true }
              );
            }
            return;
          }

          const suffix = `-${attempt}`;
          const allowedBaseLength = Math.max(1, CONTENT_SLUG_MAX_LENGTH - suffix.length);
          const shortenedBase = slugBase.slice(0, allowedBaseLength).replace(/-+$/g, '') || 'contenido';
          nextSlug = `${shortenedBase}${suffix}`;
          attempt += 1;
        }
      });
    } catch (error) {
      console.error(`Slug sync failed for content ${context.params.contentId}:`, error);
    }

    return null;
  });

export const onContentCreated = functions.firestore
  .document('content/{contentId}')
  .onCreate(async (snap, context) => {
    return onContentCreatedInternal(db, snap);

    /*
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
    */
  });

export const onContentDeleted = functions.firestore
  .document('content/{contentId}')
  .onUpdate(async (change, context) => {
    return onContentDeletedInternal(db, change, context);

    /*
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
        try {
          await cleanupCommunityPostHostingMedia(afterData);
          console.log(`🧹 Community media deleted for ${contentId}`);
        } catch (mediaError) {
          console.error(`⚠️ Failed to delete community media for ${contentId}:`, mediaError);
        }

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
    */
  });

// 5. IntegraciÃ³n Oficial de Noticias desde WordPress via Realtime Database
export const onOfficialNewsReceived = functions.database
  .ref('/news/{newsId}')
  .onWrite(async (change, context) => {
    return onOfficialNewsReceivedInternal(db, change, context);

    /*
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

        const isoLike = raw.match(
          /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
        );
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

        const latamLike = raw.match(
          /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/
        );
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
      const normalizeUrlCandidate = (value: unknown): string => {
        if (typeof value !== 'string') return '';
        return value.trim().slice(0, 2400);
      };
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
        : [
          afterData.image,
          afterData.imageUrl,
          afterData.coverImage,
          afterData.custom_fields?.image
        ];
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

      // Payload purificado e idempotente
      const firestorePayload = {
        type: 'news',
        source: 'wordpress',
        module: 'news',
        externalId: newsId,
        externalSource: 'wordpress_plugin',
        postId: postIdNumber,
        publicId: normalizedPostId,

        titulo: afterData.titulo || 'Sin TÃ­tulo',
        descripcion: afterData.descripcion || '',
        images: normalizedImages,
        imagesV2,
        imgMiniatura: coverThumbnailUrl,

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
      if (normalizedPostId) {
        const publicKey = buildContentPublicIdKey('news', normalizedPostId);
        await db
          .collection('_content_public_ids')
          .doc(publicKey)
          .set(
            {
              contentId: newsId,
              module: 'news',
              publicId: normalizedPostId,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            { merge: true }
          );
      }
      if (!normalizedPostId) {
        console.warn(`News ${newsId} synced without postId/publicId`);
      }
      console.log(`✅ Noticia sincronizada en Firestore: ${newsId}`);

      return null;
    } catch (error) {
      console.error(`❌ Falló la sincronización de RTDB a Firestore para ${newsId}:`, error);
      return null;
    }
    */
  });

// 5.5 Integración de Publicaciones Scraping a la Comunidad via Realtime Database
export const onCommunityPostsReceived = functions.database
  .ref('/c/{postId}')
  .onWrite(async (change, context) => {
    return onCommunityPostsReceivedInternal(db, change, context);

    /*
    const { postId } = context.params;
    const afterData = change.after.val();

    if (!afterData) {
      console.log(`ℹ️ Community post ${postId} was deleted from RTDB. Ignoring in Firestore.`);
      return null;
    }

    // Skip reserved IDs that would fail in Firestore
    if (postId.startsWith('__') && postId.endsWith('__')) {
      console.log(`⚠️ Skipping reserved test ID: ${postId}`);
      return null;
    }

    try {
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

        const isoLike = raw.match(
          /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
        );
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

        const latamLike = raw.match(
          /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/
        );
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

      const contentRef = db.collection('content').doc(postId);
      const existingSnap = await contentRef.get();
      const existingCreatedAt = existingSnap.exists ? existingSnap.data()?.createdAt : null;

      const parsedCreatedAt = parseDateCandidate(afterData.createdAt);
      const parsedUpdatedAt = parseDateCandidate(afterData.updatedAt);

      const createdAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp =
        parsedCreatedAt || (existingCreatedAt instanceof admin.firestore.Timestamp ? existingCreatedAt : admin.firestore.FieldValue.serverTimestamp());
      const updatedAtTs: admin.firestore.FieldValue | admin.firestore.Timestamp =
        parsedUpdatedAt || admin.firestore.FieldValue.serverTimestamp();

      const normalizeUrlCandidate = (value: unknown): string => {
        if (typeof value !== 'string') return '';
        return value.trim().slice(0, 2400);
      };

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

        return {
          url,
          thumbUrl: thumbCandidate && thumbCandidate !== url ? thumbCandidate : null
        };
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
        .flatMap((entry: unknown) => {
          if (Array.isArray(entry)) return entry;
          return [entry];
        })
        .map((entry: unknown) => normalizeImageEntry(entry))
        .filter(
          (entry: { url: string; thumbUrl: string | null } | null): entry is {
            url: string;
            thumbUrl: string | null;
          } => Boolean(entry)
        );

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
        const thumbUrl =
          matched?.thumbUrl ||
          (index === 0 && legacyMiniThumb ? legacyMiniThumb : null) ||
          url;
        return {
          url,
          thumbUrl
        };
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
      console.log(`✅ Publicación de la comunidad sincronizada en Firestore: ${postId}`);

      return null;
    } catch (error) {
      console.error(`❌ Falló la sincronización de comunidad a Firestore para ${postId}:`, error);
      return null;
    }
    */
  });

// 6. Community image thumbnails
export const onCommunityPostImageFinalized = functions.storage
  .bucket(COMMUNITY_THUMBNAIL_BUCKET)
  .object()
  .onFinalize(async (object) => {
    return onCommunityPostImageFinalizedInternal(object);
  });

// 7. Hosting FTP image upload fallback for community posts
export const uploadCommunityImageToHosting = functions.https.onCall(async (data, context) => {
  return uploadCommunityImageToHostingInternal(data, context);
});

// 8. Lottery entry callable (number-based entries, supports multiple tickets per user)
export const enterLottery = functions.https.onCall(async (data, context) => {
  return enterLotteryInternal(db, data, context);

  /*
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
  const userRecord = await admin.auth().getUser(userId);
  const providerIds = (userRecord.providerData || []).map((provider) => provider.providerId);
  const hasSocialAccount = providerIds.includes('google.com') || providerIds.includes('facebook.com');
  const isVerifiedUser = userData.isVerified === true;
  const token = (context.auth?.token || {}) as Record<string, unknown>;

  const fallbackEmail = typeof token.email === 'string' ? token.email : '';
  const fallbackName = fallbackEmail ? fallbackEmail.split('@')[0] : 'Usuario';
  const userNameRaw = typeof userData.nombre === 'string' ? userData.nombre : fallbackName;
  const userProfilePicRaw = typeof userData.profilePictureUrl === 'string'
    ? userData.profilePictureUrl
    : '';

  const userUsernameRaw = typeof userData.username === 'string' ? userData.username : '';
  const userName = userNameRaw.trim().slice(0, 120) || 'Usuario';
  const userUsername = userUsernameRaw.trim().slice(0, 30);
  const userProfilePicUrl = userProfilePicRaw.trim();

  const modulesConfigRef = db.collection('_config').doc('modules');
  const lotteryRef = db.collection('lotteries').doc(lotteryId);
  const entryRef = lotteryRef.collection('entries').doc(toLotteryEntryDocId(selectedNumber));
  const extraTicketsRef = db
    .collection(LOTTERY_USER_EXTRA_TICKETS_COLLECTION)
    .doc(toLotteryUserExtraDocId(lotteryId, userId));
  const userEntriesQuery = lotteryRef
    .collection('entries')
    .where('userId', '==', userId)
    .limit(LOTTERY_MAX_MAX_NUMBER + 2);

  const entryResult = await db.runTransaction(async (tx) => {
    const [modulesConfigSnap, lotterySnap, entrySnap, userEntriesSnap, extraTicketsSnap] = await Promise.all([
      tx.get(modulesConfigRef),
      tx.get(lotteryRef),
      tx.get(entryRef),
      tx.get(userEntriesQuery),
      tx.get(extraTicketsRef)
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

    const isFree = lotteryData.isFree !== false;
    if (isFree && !hasSocialAccount && !isVerifiedUser) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'unverified-account: Solo los usuarios con al menos una cuenta social vinculada y verificada (Google o Facebook) pueden participar en las loterías gratuitas.'
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
    const extraTickets = normalizeLotteryExtraTickets(extraTicketsSnap.data()?.extraTickets);
    const effectiveMaxTicketsPerUser = getLotteryEffectiveMaxTickets(
      maxTicketsPerUser,
      extraTickets,
      maxNumber
    );
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
          userTicketsCount: Math.max(1, userTicketsCount),
          effectiveMaxTicketsPerUser
        };
      }
      throw new functions.https.HttpsError(
        'already-exists',
        'number-taken: El numero seleccionado ya esta ocupado.'
      );
    }

    if (userTicketsCount >= effectiveMaxTicketsPerUser) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `limit-reached: Alcanzaste el maximo de ${effectiveMaxTicketsPerUser} numeros para esta loteria.`
      );
    }

    const entryPayload: Record<string, unknown> = {
      userId,
      userName,
      userUsername,
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
      userTicketsCount: userTicketsCount + 1,
      effectiveMaxTicketsPerUser
    };
  });

  if (entryResult.status === 'ok') {
    publishLotteryBallToOBS(entryResult.selectedNumber, userName, userProfilePicUrl);
  }
  return entryResult;
  */
});

// 9. Lottery draw callable (staff-only)
export const drawLotteryWinner = functions.https.onCall(async (data, context) => {
  return drawLotteryWinnerInternal(db, data, context);

  /*
  await assertStaffUser(db, context.auth);

  const lotteryId = typeof data?.lotteryId === 'string' ? data.lotteryId.trim() : '';
  if (!lotteryId) {
    throw new functions.https.HttpsError('invalid-argument', 'lotteryId es obligatorio.');
  }

  await ensureLotteryEntriesSchemaV2(lotteryId);

  const requesterUid = context.auth?.uid || 'system';
  const modulesConfigRef = db.collection('_config').doc('modules');
  const lotteryRef = db.collection('lotteries').doc(lotteryId);

  const result = await db.runTransaction(async (tx) => {
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
      participantsCount,
      lotteryTitle: lotteryData.title || lotteryData.nombre || 'Sorteo',
      hasPremio: lotteryData.hasPremio !== false,
      premioType: lotteryData.premioType || 'dinero',
      premioDinero: typeof lotteryData.premioDinero === 'number' ? lotteryData.premioDinero : null,
      premioOtros: typeof lotteryData.premioOtros === 'string' ? lotteryData.premioOtros : ''
    };
  });

  // Emitir notificación del sistema y push al ganador fuera de la transacción
  try {
    const winnerUserId = result.winner.userId;
    const lotteryTitle = result.lotteryTitle;
    const winnerSelectedNumber = result.winner.selectedNumber;

    let premioMsg = '';
    if (result.hasPremio) {
      if (result.premioType === 'dinero' && result.premioDinero !== null) {
        premioMsg = `un premio de $${result.premioDinero} ARS`;
      } else if (result.premioType === 'otros' && result.premioOtros) {
        premioMsg = `el premio "${result.premioOtros}"`;
      } else {
        premioMsg = 'el premio mayor';
      }
    } else {
      premioMsg = 'el premio mayor';
    }

    const systemMessage = `🏆 ¡Felicidades! Has ganado el sorteo "${lotteryTitle}" con el número #${winnerSelectedNumber}. Tu premio es ${premioMsg}.`;

    const notificationRef = db.collection('users')
      .doc(winnerUserId)
      .collection('notifications')
      .doc();

    await notificationRef.set({
      type: 'system',
      recipientUserId: winnerUserId,
      actorUserId: 'system',
      actorName: 'Sorteos Bot',
      actorUsername: 'system',
      actorProfilePictureUrl: 'https://bot.cdelu.io/images/logo.png',
      contentId: lotteryId,
      contentModule: '',
      contentPublicRef: '',
      contentSlug: '',
      commentId: '',
      replyId: '',
      targetPath: '/perfil',
      isRead: false,
      readAt: null,
      eventCount: 1,
      systemMessage,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastEventAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Enviar alerta push
    await sendPushToNotificationDevices(db, 
      notificationRef,
      winnerUserId,
      'system',
      'Sorteos Bot',
      '/perfil'
    ).catch((err) => console.warn('Error sending winner push notification:', err));

  } catch (error) {
    console.error('Error recording winner notification:', error);
  }

  return {
    status: result.status,
    lotteryId: result.lotteryId,
    winner: result.winner,
    participantsCount: result.participantsCount
  };
  */
});

// 10. Surveys vote callable (single vote per user/survey)
export const submitSurveyVote = functions.https.onCall(async (data, context) => {
  return submitSurveyVoteInternal(db, data, context);
});

// 11. Auto-complete expired surveys
export const completeExpiredSurveys = functions.pubsub
  .schedule('every 1 minutes')
  .onRun(async () => {
    await completeExpiredSurveysInternal(db);
    return null;
  });

export const purgeOldNotifications = functions.pubsub
  .schedule('every day 03:00')
  .timeZone('Etc/UTC')
  .onRun(async () => {
    const removedCount = await purgeOldNotificationsInternal(
      db,
      NOTIFICATION_RETENTION_DAYS,
      NOTIFICATION_PAGE_SIZE
    );
    console.log(`Old notifications removed: ${removedCount}`);
    return null;
  });

// 12. Ads metrics aggregation
export const onAdEventCreated = functions.firestore
  .document('ad_events/{eventId}')
  .onCreate(async (snap) => {
    await handleAdEventCreatedInternal(db, snap);
    return null;
  });
