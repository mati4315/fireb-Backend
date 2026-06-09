import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

export type LotteryStatus = 'draft' | 'active' | 'closed' | 'completed';
export type LotteryMigrationStatus = 'pending' | 'running' | 'done' | 'failed';

export const LOTTERY_DEFAULT_MAX_NUMBER = 100;
export const LOTTERY_MIN_MAX_NUMBER = 10;
export const LOTTERY_MAX_MAX_NUMBER = 200;
export const LOTTERY_DEFAULT_MAX_TICKETS_PER_USER = 1;
export const LOTTERY_MIN_TICKETS_PER_USER = 1;
export const LOTTERY_MAX_TICKETS_PER_USER = 5;
export const LOTTERY_MAX_EXTRA_TICKETS_PER_USER = LOTTERY_MAX_MAX_NUMBER;
export const LOTTERY_USER_EXTRA_TICKETS_COLLECTION = 'lottery_user_ticket_extras';
export const LOTTERY_ENTRY_SCHEMA_VERSION = 2;
export const LOTTERY_ENTRY_DOC_PREFIX = 'n_';
export const LOTTERY_MIGRATION_PAGE_SIZE = 400;
export const LOTTERY_MIGRATION_BATCH_SIZE = 400;
export const MAX_LOTTERY_DRAW_ENTRIES = 5000;

export const clampInteger = (value: unknown, min: number, max: number, fallback: number): number => {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const parsed = Math.floor(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
};

export const normalizeLotteryMaxNumber = (value: unknown): number => {
  return clampInteger(
    value,
    LOTTERY_MIN_MAX_NUMBER,
    LOTTERY_MAX_MAX_NUMBER,
    LOTTERY_DEFAULT_MAX_NUMBER
  );
};

export const normalizeLotteryMaxTicketsPerUser = (value: unknown): number => {
  return clampInteger(
    value,
    LOTTERY_MIN_TICKETS_PER_USER,
    LOTTERY_MAX_TICKETS_PER_USER,
    LOTTERY_DEFAULT_MAX_TICKETS_PER_USER
  );
};

export const normalizeLotteryExtraTickets = (value: unknown): number => {
  return clampInteger(
    value,
    0,
    LOTTERY_MAX_EXTRA_TICKETS_PER_USER,
    0
  );
};

export const toLotteryUserExtraDocId = (lotteryId: string, userId: string): string => {
  return `${lotteryId}__${userId}`;
};

export const getLotteryEffectiveMaxTickets = (
  lotteryMaxTicketsPerUser: number,
  extraTickets: number,
  lotteryMaxNumber: number
): number => {
  const base = normalizeLotteryMaxTicketsPerUser(lotteryMaxTicketsPerUser);
  const extra = normalizeLotteryExtraTickets(extraTickets);
  const maxNumber = normalizeLotteryMaxNumber(lotteryMaxNumber);
  return Math.max(1, Math.min(maxNumber, base + extra));
};

export const parseSelectedLotteryNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.floor(parsed);
  if (!Number.isFinite(normalized) || normalized !== parsed) return null;
  if (normalized <= 0) return null;
  return normalized;
};

export const toLotteryEntryDocId = (selectedNumber: number): string => {
  return `${LOTTERY_ENTRY_DOC_PREFIX}${selectedNumber}`;
};

export const extractSelectedNumberFromEntryDoc = (
  entryDoc: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>
): number | null => {
  const data = entryDoc.data() || {};
  const selectedRaw = parseSelectedLotteryNumber(data.selectedNumber);
  if (selectedRaw != null) return selectedRaw;

  const matches = entryDoc.id.match(/^n_(\d+)$/);
  if (!matches) return null;
  return parseSelectedLotteryNumber(matches[1]);
};

export const listAllLotteryEntries = async (
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

export const ensureLotteryEntriesSchemaV2 = async (lotteryId: string): Promise<void> => {
  const firestore = admin.firestore();
  const lotteryRef = firestore.collection('lotteries').doc(lotteryId);
  let maxNumber = LOTTERY_DEFAULT_MAX_NUMBER;
  let maxTicketsPerUser = LOTTERY_DEFAULT_MAX_TICKETS_PER_USER;
  let mustRunMigration = false;
  let needsDefaultsPatch = false;

  await firestore.runTransaction(async (tx) => {
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

    let batch = firestore.batch();
    let writes = 0;
    const flush = async () => {
      if (writes === 0) return;
      await batch.commit();
      batch = firestore.batch();
      writes = 0;
    };

    for (const planned of plannedEntries) {
      const sourceData = planned.source.data() || {};
      const userIdRaw = typeof sourceData.userId === 'string' ? sourceData.userId.trim() : '';
      const fallbackUserId = planned.source.id;
      const userId = userIdRaw || fallbackUserId;

      const userUsernameRaw = typeof sourceData.userUsername === 'string' ? sourceData.userUsername.trim() : '';
      const userNameRaw = typeof sourceData.userName === 'string' ? sourceData.userName.trim() : '';
      const userName = userNameRaw || 'Usuario';
      const userUsername = userUsernameRaw.slice(0, 30);
      const profilePicRaw = typeof sourceData.userProfilePicUrl === 'string'
        ? sourceData.userProfilePicUrl.trim()
        : '';

      const payload: Record<string, unknown> = {
        userId,
        userName: userName.slice(0, 120),
        userUsername,
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

const loadWebSocket = async (): Promise<new (url: string) => {
  on(event: 'open', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  send(data: string): void;
  close(): void;
}> => {
  const wsModule = await import('ws');
  return ((wsModule as unknown as { default?: any }).default ?? wsModule) as any;
};

export const publishLotteryBallToOBS = (number: number, name: string, profilePicUrl = ''): void => {
  void publishLotteryBallToOBSAsync(number, name, profilePicUrl);
};

const publishLotteryBallToOBSAsync = async (
  number: number,
  name: string,
  profilePicUrl = ''
): Promise<void> => {
  const wsUrl = process.env.WS_LOTTERY_URL || 'ws://localhost:688';
  const wsToken = process.env.WS_LOTTERY_TOKEN || '';

  if (!wsUrl) return;

  try {
    const WebSocket = await loadWebSocket();
    const ws = new WebSocket(wsUrl);
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
    };

    const timeout = setTimeout(() => {
      console.warn('[lottery] OBS WS publish timed out');
      done();
    }, 3000);

    ws.on('open', () => {
      clearTimeout(timeout);
      const payload: Record<string, unknown> = {
        type: 'TRIGGER_BALL',
        number,
        name,
        profilePicUrl,
        eventId: `entry_${number}_${Date.now()}`
      };
      if (wsToken) payload.token = wsToken;
      ws.send(JSON.stringify(payload));
      done();
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      console.warn('[lottery] OBS WS publish error:', err.message);
      done();
    });
  } catch (err: any) {
    console.warn('[lottery] OBS WS publish not available:', err.message);
  }
};
