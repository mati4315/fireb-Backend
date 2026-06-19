import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import {
  ANDROID_PUSH_CHANNEL_ID,
  buildPushTextForNotification,
  getNotificationTopicsForPlatform,
  safeNotificationPath,
  type NotificationPlatform,
  type NotificationType
} from './notificationUtils';
import {
  ensureNotificationTypeSettings,
  ensureUserSettings,
  assertAdminUser,
  isNotificationTypeEnabled,
  normalizeUsernameLoose,
  sanitizeBoundedString
} from './userUtils';
import {
  extractNewsPublicIdFromPayload,
  inferContentModule,
  normalizeContentSlug
} from './contentUtils';

export type NotificationActorIdentity = {
  userId: string;
  actorName: string;
  actorUsername: string;
  actorProfilePictureUrl: string;
};

export type ContentNotificationTarget = {
  contentId: string;
  contentModule: 'news' | 'community';
  contentPublicRef: string;
  contentSlug: string;
  targetPath: string;
};

export type NotificationWriteInput = {
  type: NotificationType;
  recipientUserId: string;
  actor: NotificationActorIdentity;
  targetPath: string;
  notificationId?: string;
  contentTarget?: ContentNotificationTarget;
  commentId?: string;
  replyId?: string;
};

const NOTIFICATION_ACTOR_CACHE_TTL_MS = 60_000;
const MODULES_CONFIG_CACHE_TTL_MS = 30_000;
const NOTIFICATION_RECIPIENT_CACHE_TTL_MS = 20_000;

const PERMANENT_FCM_TOKEN_ERROR_CODES = new Set<string>([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered'
]);

type NotificationActorCacheEntry = {
  expiresAt: number;
  value: NotificationActorIdentity;
};

type ModulesConfigCacheEntry = {
  expiresAt: number;
  value: FirebaseFirestore.DocumentData | undefined;
};

type NotificationRecipientCacheEntry = {
  expiresAt: number;
  exists: boolean;
  settings: Record<string, unknown> | null;
};

const notificationActorCache = new Map<string, NotificationActorCacheEntry>();
const modulesConfigCache = new Map<string, ModulesConfigCacheEntry>();
const notificationRecipientCache = new Map<string, NotificationRecipientCacheEntry>();

export const buildContentTargetFromDoc = (
  contentId: string,
  contentData: FirebaseFirestore.DocumentData
): ContentNotificationTarget => {
  const contentModule = inferContentModule(contentData);
  const contentSlug = normalizeContentSlug(contentData?.slug || contentData?.titulo || contentId);
  const contentPublicRef = contentModule === 'news'
    ? (extractNewsPublicIdFromPayload(contentData) || contentId)
    : contentId;

  const targetPath = contentModule === 'news'
    ? `/noticia/${encodeURIComponent(contentPublicRef)}/${encodeURIComponent(contentSlug)}`
    : `/c/${encodeURIComponent(contentId)}/${encodeURIComponent(contentSlug)}`;

  return {
    contentId,
    contentModule,
    contentPublicRef,
    contentSlug,
    targetPath
  };
};

export const loadNotificationActorIdentity = async (
  db: FirebaseFirestore.Firestore,
  actorUserId: string
): Promise<NotificationActorIdentity> => {
  const now = Date.now();
  const cached = notificationActorCache.get(actorUserId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const userPublicSnap = await db.collection('users_public').doc(actorUserId).get();
  const sourceData = userPublicSnap.exists
    ? (userPublicSnap.data() || {})
    : (await db.collection('users').doc(actorUserId).get()).data() || {};
  const { usernameLower } = normalizeUsernameLoose(actorUserId, sourceData);
  const actorName = sanitizeBoundedString(sourceData?.nombre, 120) || 'Usuario';
  const actorProfilePictureUrl = sanitizeBoundedString(sourceData?.profilePictureUrl, 1200);

  const value = {
    userId: actorUserId,
    actorName,
    actorUsername: usernameLower,
    actorProfilePictureUrl
  };

  notificationActorCache.set(actorUserId, {
    expiresAt: now + NOTIFICATION_ACTOR_CACHE_TTL_MS,
    value
  });

  return value;
};

export const getModulesConfigData = async (
  db: FirebaseFirestore.Firestore
): Promise<FirebaseFirestore.DocumentData | undefined> => {
  const now = Date.now();
  const cacheKey = 'modules';
  const cached = modulesConfigCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const snap = await db.collection('_config').doc('modules').get();
  const value = snap.data();
  modulesConfigCache.set(cacheKey, {
    expiresAt: now + MODULES_CONFIG_CACHE_TTL_MS,
    value
  });
  return value;
};

export const invalidateNotificationRecipientCache = (userId: string): void => {
  notificationRecipientCache.delete(userId);
};

export const getNotificationRecipientData = async (
  db: FirebaseFirestore.Firestore,
  userId: string
): Promise<NotificationRecipientCacheEntry> => {
  const now = Date.now();
  const cached = notificationRecipientCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  const snap = await db.collection('users').doc(userId).get();
  const entry: NotificationRecipientCacheEntry = {
    expiresAt: now + NOTIFICATION_RECIPIENT_CACHE_TTL_MS,
    exists: snap.exists,
    settings: snap.exists ? (snap.data()?.settings || null) : null
  };
  notificationRecipientCache.set(userId, entry);
  return entry;
};

export const sendPushToNotificationDevices = async (
  db: FirebaseFirestore.Firestore,
  notificationRef: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>,
  recipientUserId: string,
  notificationType: NotificationType | 'system',
  actorName: string,
  targetPath: string
): Promise<void> => {
  const devicesSnap = await db.collection('users')
    .doc(recipientUserId)
    .collection('notification_devices')
    .where('enabled', '==', true)
    .get();
  if (devicesSnap.empty) return;

  const tokenToDeviceRefs = new Map<string, FirebaseFirestore.DocumentReference[]>();
  const uniqueTokens: string[] = [];

  for (const deviceDoc of devicesSnap.docs) {
    const token = sanitizeBoundedString(deviceDoc.data()?.token, 4096);
    if (!token) continue;

    const existing = tokenToDeviceRefs.get(token) || [];
    existing.push(deviceDoc.ref);
    tokenToDeviceRefs.set(token, existing);

    if (existing.length === 1) uniqueTokens.push(token);
  }

  if (uniqueTokens.length === 0) return;

  let title = '';
  let body = '';

  if (notificationType === 'system') {
    const snap = await notificationRef.get();
    const docData = snap.data() || {};
    title = 'Sorteo Ganado! ðŸ†';
    body = typeof docData.systemMessage === 'string' && docData.systemMessage ? docData.systemMessage : 'Felicidades! Has ganado un sorteo.';
  } else {
    const pushText = buildPushTextForNotification(notificationType, actorName);
    title = pushText.title;
    body = pushText.body;
  }

  const sendResult = await admin.messaging().sendEachForMulticast({
    tokens: uniqueTokens,
    notification: {
      title,
      body
    },
    data: {
      notificationId: notificationRef.id,
      type: notificationType,
      targetPath
    },
    android: {
      priority: 'high',
      notification: {
        channelId: ANDROID_PUSH_CHANNEL_ID,
        sound: 'default',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK'
      }
    },
    webpush: {
      fcmOptions: {
        link: targetPath
      }
    }
  });

  const refsToDelete: FirebaseFirestore.DocumentReference[] = [];
  sendResult.responses.forEach((response, index) => {
    if (response.success) return;
    const code = String(response.error?.code || '');
    if (!PERMANENT_FCM_TOKEN_ERROR_CODES.has(code)) return;
    const token = uniqueTokens[index];
    const linkedRefs = tokenToDeviceRefs.get(token) || [];
    refsToDelete.push(...linkedRefs);
  });

  if (refsToDelete.length === 0) return;

  const batch = db.batch();
  for (const ref of refsToDelete) {
    batch.delete(ref);
  }
  await batch.commit();
};

export const sendTestPushToAllUsersInternal = async (
  db: FirebaseFirestore.Firestore,
  data: any,
  context: functions.https.CallableContext
): Promise<Record<string, unknown>> => {
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
};

export const subscribeTokenToPushTopics = async (
  token: string,
  platform: NotificationPlatform
): Promise<void> => {
  const topics = getNotificationTopicsForPlatform(platform);
  await Promise.all(
    topics.map(async (topic) => {
      try {
        await admin.messaging().subscribeToTopic([token], topic);
      } catch (error) {
        console.warn(`No se pudo suscribir token a topic ${topic}:`, error);
      }
    })
  );
};

export const unsubscribeTokenFromPushTopics = async (
  token: string,
  platform: NotificationPlatform
): Promise<void> => {
  const topics = getNotificationTopicsForPlatform(platform);
  await Promise.all(
    topics.map(async (topic) => {
      try {
        await admin.messaging().unsubscribeFromTopic([token], topic);
      } catch (error) {
        console.warn(`No se pudo desuscribir token de topic ${topic}:`, error);
      }
    })
  );
};

export const writeNotificationEvent = async (
  db: FirebaseFirestore.Firestore,
  input: NotificationWriteInput
): Promise<void> => {
  if (input.recipientUserId === input.actor.userId) return;

  const [modulesConfigData, recipientData] = await Promise.all([
    getModulesConfigData(db),
    getNotificationRecipientData(db, input.recipientUserId)
  ]);

  if (!(modulesConfigData?.notifications?.enabled ?? true)) return;
  if (!recipientData.exists) return;

  const recipientSettings = ensureUserSettings(recipientData.settings);
  const notificationsEnabled = recipientSettings.notificationsEnabled !== false;
  if (!notificationsEnabled) return;

  const typeSettings = ensureNotificationTypeSettings(recipientSettings.notificationTypes);
  if (!isNotificationTypeEnabled(typeSettings, input.type)) return;

  const notificationsCollection = db.collection('users')
    .doc(input.recipientUserId)
    .collection('notifications');
  const notificationRef = input.notificationId
    ? notificationsCollection.doc(input.notificationId)
    : notificationsCollection.doc();

  if (input.notificationId) {
    await db.runTransaction(async (tx) => {
      const existingSnap = await tx.get(notificationRef);
      const existingData = existingSnap.data() || {};
      const currentCountRaw = Number(existingData.eventCount ?? 1);
      const currentCount = Number.isFinite(currentCountRaw) ? Math.max(1, Math.floor(currentCountRaw)) : 1;

      tx.set(
        notificationRef,
        {
          type: input.type,
          recipientUserId: input.recipientUserId,
          actorUserId: input.actor.userId,
          actorName: input.actor.actorName,
          actorUsername: input.actor.actorUsername,
          actorProfilePictureUrl: input.actor.actorProfilePictureUrl,
          contentId: input.contentTarget?.contentId || '',
          contentModule: input.contentTarget?.contentModule || '',
          contentPublicRef: input.contentTarget?.contentPublicRef || '',
          contentSlug: input.contentTarget?.contentSlug || '',
          commentId: input.commentId || '',
          replyId: input.replyId || '',
          targetPath: safeNotificationPath(input.targetPath, '/notificaciones'),
          isRead: false,
          readAt: null,
          eventCount: existingSnap.exists ? currentCount + 1 : 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastEventAt: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: existingSnap.exists
            ? (existingData.createdAt || admin.firestore.FieldValue.serverTimestamp())
            : admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });
  } else {
    await notificationRef.set({
      type: input.type,
      recipientUserId: input.recipientUserId,
      actorUserId: input.actor.userId,
      actorName: input.actor.actorName,
      actorUsername: input.actor.actorUsername,
      actorProfilePictureUrl: input.actor.actorProfilePictureUrl,
      contentId: input.contentTarget?.contentId || '',
      contentModule: input.contentTarget?.contentModule || '',
      contentPublicRef: input.contentTarget?.contentPublicRef || '',
      contentSlug: input.contentTarget?.contentSlug || '',
      commentId: input.commentId || '',
      replyId: input.replyId || '',
      targetPath: safeNotificationPath(input.targetPath, '/notificaciones'),
      isRead: false,
      readAt: null,
      eventCount: 1,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastEventAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  await sendPushToNotificationDevices(
    db,
    notificationRef,
    input.recipientUserId,
    input.type,
    input.actor.actorName,
    safeNotificationPath(input.targetPath, '/notificaciones')
  );
};

export const purgeOldNotificationsInternal = async (
  db: FirebaseFirestore.Firestore,
  retentionDays: number,
  pageSize: number
): Promise<number> => {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffTs = admin.firestore.Timestamp.fromDate(cutoffDate);
  let removedCount = 0;

  while (true) {
    const snapshot = await db.collectionGroup('notifications')
      .where('lastEventAt', '<=', cutoffTs)
      .limit(pageSize)
      .get();
    if (snapshot.empty) break;

    const batch = db.batch();
    for (const notificationDoc of snapshot.docs) {
      batch.delete(notificationDoc.ref);
    }
    await batch.commit();
    removedCount += snapshot.size;

    if (snapshot.size < pageSize) break;
  }

  return removedCount;
};
