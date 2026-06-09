"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishLotteryBallToOBS = exports.ensureLotteryEntriesSchemaV2 = exports.listAllLotteryEntries = exports.extractSelectedNumberFromEntryDoc = exports.toLotteryEntryDocId = exports.parseSelectedLotteryNumber = exports.getLotteryEffectiveMaxTickets = exports.toLotteryUserExtraDocId = exports.normalizeLotteryExtraTickets = exports.normalizeLotteryMaxTicketsPerUser = exports.normalizeLotteryMaxNumber = exports.clampInteger = exports.MAX_LOTTERY_DRAW_ENTRIES = exports.LOTTERY_MIGRATION_BATCH_SIZE = exports.LOTTERY_MIGRATION_PAGE_SIZE = exports.LOTTERY_ENTRY_DOC_PREFIX = exports.LOTTERY_ENTRY_SCHEMA_VERSION = exports.LOTTERY_USER_EXTRA_TICKETS_COLLECTION = exports.LOTTERY_MAX_EXTRA_TICKETS_PER_USER = exports.LOTTERY_MAX_TICKETS_PER_USER = exports.LOTTERY_MIN_TICKETS_PER_USER = exports.LOTTERY_DEFAULT_MAX_TICKETS_PER_USER = exports.LOTTERY_MAX_MAX_NUMBER = exports.LOTTERY_MIN_MAX_NUMBER = exports.LOTTERY_DEFAULT_MAX_NUMBER = void 0;
const admin = require("firebase-admin");
const functions = require("firebase-functions");
exports.LOTTERY_DEFAULT_MAX_NUMBER = 100;
exports.LOTTERY_MIN_MAX_NUMBER = 10;
exports.LOTTERY_MAX_MAX_NUMBER = 200;
exports.LOTTERY_DEFAULT_MAX_TICKETS_PER_USER = 1;
exports.LOTTERY_MIN_TICKETS_PER_USER = 1;
exports.LOTTERY_MAX_TICKETS_PER_USER = 5;
exports.LOTTERY_MAX_EXTRA_TICKETS_PER_USER = exports.LOTTERY_MAX_MAX_NUMBER;
exports.LOTTERY_USER_EXTRA_TICKETS_COLLECTION = 'lottery_user_ticket_extras';
exports.LOTTERY_ENTRY_SCHEMA_VERSION = 2;
exports.LOTTERY_ENTRY_DOC_PREFIX = 'n_';
exports.LOTTERY_MIGRATION_PAGE_SIZE = 400;
exports.LOTTERY_MIGRATION_BATCH_SIZE = 400;
exports.MAX_LOTTERY_DRAW_ENTRIES = 5000;
const clampInteger = (value, min, max, fallback) => {
    const raw = Number(value);
    if (!Number.isFinite(raw))
        return fallback;
    const parsed = Math.floor(raw);
    if (!Number.isFinite(parsed))
        return fallback;
    if (parsed < min)
        return min;
    if (parsed > max)
        return max;
    return parsed;
};
exports.clampInteger = clampInteger;
const normalizeLotteryMaxNumber = (value) => {
    return (0, exports.clampInteger)(value, exports.LOTTERY_MIN_MAX_NUMBER, exports.LOTTERY_MAX_MAX_NUMBER, exports.LOTTERY_DEFAULT_MAX_NUMBER);
};
exports.normalizeLotteryMaxNumber = normalizeLotteryMaxNumber;
const normalizeLotteryMaxTicketsPerUser = (value) => {
    return (0, exports.clampInteger)(value, exports.LOTTERY_MIN_TICKETS_PER_USER, exports.LOTTERY_MAX_TICKETS_PER_USER, exports.LOTTERY_DEFAULT_MAX_TICKETS_PER_USER);
};
exports.normalizeLotteryMaxTicketsPerUser = normalizeLotteryMaxTicketsPerUser;
const normalizeLotteryExtraTickets = (value) => {
    return (0, exports.clampInteger)(value, 0, exports.LOTTERY_MAX_EXTRA_TICKETS_PER_USER, 0);
};
exports.normalizeLotteryExtraTickets = normalizeLotteryExtraTickets;
const toLotteryUserExtraDocId = (lotteryId, userId) => {
    return `${lotteryId}__${userId}`;
};
exports.toLotteryUserExtraDocId = toLotteryUserExtraDocId;
const getLotteryEffectiveMaxTickets = (lotteryMaxTicketsPerUser, extraTickets, lotteryMaxNumber) => {
    const base = (0, exports.normalizeLotteryMaxTicketsPerUser)(lotteryMaxTicketsPerUser);
    const extra = (0, exports.normalizeLotteryExtraTickets)(extraTickets);
    const maxNumber = (0, exports.normalizeLotteryMaxNumber)(lotteryMaxNumber);
    return Math.max(1, Math.min(maxNumber, base + extra));
};
exports.getLotteryEffectiveMaxTickets = getLotteryEffectiveMaxTickets;
const parseSelectedLotteryNumber = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return null;
    const normalized = Math.floor(parsed);
    if (!Number.isFinite(normalized) || normalized !== parsed)
        return null;
    if (normalized <= 0)
        return null;
    return normalized;
};
exports.parseSelectedLotteryNumber = parseSelectedLotteryNumber;
const toLotteryEntryDocId = (selectedNumber) => {
    return `${exports.LOTTERY_ENTRY_DOC_PREFIX}${selectedNumber}`;
};
exports.toLotteryEntryDocId = toLotteryEntryDocId;
const extractSelectedNumberFromEntryDoc = (entryDoc) => {
    const data = entryDoc.data() || {};
    const selectedRaw = (0, exports.parseSelectedLotteryNumber)(data.selectedNumber);
    if (selectedRaw != null)
        return selectedRaw;
    const matches = entryDoc.id.match(/^n_(\d+)$/);
    if (!matches)
        return null;
    return (0, exports.parseSelectedLotteryNumber)(matches[1]);
};
exports.extractSelectedNumberFromEntryDoc = extractSelectedNumberFromEntryDoc;
const listAllLotteryEntries = async (lotteryRef) => {
    const docs = [];
    let lastDocId = null;
    while (true) {
        let pageQuery = lotteryRef
            .collection('entries')
            .orderBy(admin.firestore.FieldPath.documentId())
            .limit(exports.LOTTERY_MIGRATION_PAGE_SIZE);
        if (lastDocId) {
            pageQuery = pageQuery.startAfter(lastDocId);
        }
        const pageSnap = await pageQuery.get();
        if (pageSnap.empty)
            break;
        docs.push(...pageSnap.docs);
        if (pageSnap.size < exports.LOTTERY_MIGRATION_PAGE_SIZE)
            break;
        lastDocId = pageSnap.docs[pageSnap.docs.length - 1].id;
    }
    return docs;
};
exports.listAllLotteryEntries = listAllLotteryEntries;
const ensureLotteryEntriesSchemaV2 = async (lotteryId) => {
    const firestore = admin.firestore();
    const lotteryRef = firestore.collection('lotteries').doc(lotteryId);
    let maxNumber = exports.LOTTERY_DEFAULT_MAX_NUMBER;
    let maxTicketsPerUser = exports.LOTTERY_DEFAULT_MAX_TICKETS_PER_USER;
    let mustRunMigration = false;
    let needsDefaultsPatch = false;
    await firestore.runTransaction(async (tx) => {
        const lotterySnap = await tx.get(lotteryRef);
        if (!lotterySnap.exists) {
            throw new functions.https.HttpsError('not-found', 'La loteria no existe.');
        }
        const lotteryData = lotterySnap.data() || {};
        maxNumber = (0, exports.normalizeLotteryMaxNumber)(lotteryData.maxNumber);
        maxTicketsPerUser = (0, exports.normalizeLotteryMaxTicketsPerUser)(lotteryData.maxTicketsPerUser);
        const schemaRaw = Number(lotteryData.entrySchemaVersion || 0);
        const schemaVersion = Number.isFinite(schemaRaw) ? Math.floor(schemaRaw) : 0;
        const migrationStatusRaw = typeof lotteryData.migrationStatus === 'string'
            ? lotteryData.migrationStatus
            : '';
        const migrationStatus = migrationStatusRaw;
        const isAlreadyV2 = schemaVersion >= exports.LOTTERY_ENTRY_SCHEMA_VERSION;
        if (isAlreadyV2 && migrationStatus !== 'failed') {
            const hasValidDefaults = lotteryData.maxNumber === maxNumber &&
                lotteryData.maxTicketsPerUser === maxTicketsPerUser &&
                migrationStatus === 'done';
            needsDefaultsPatch = !hasValidDefaults;
            return;
        }
        if (migrationStatus === 'running') {
            throw new functions.https.HttpsError('failed-precondition', 'migration-in-progress: La loteria esta migrando entradas, intenta nuevamente en unos segundos.');
        }
        mustRunMigration = true;
        tx.set(lotteryRef, {
            migrationStatus: 'running',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    });
    if (!mustRunMigration) {
        if (needsDefaultsPatch) {
            await lotteryRef.set({
                maxNumber,
                maxTicketsPerUser,
                migrationStatus: 'done',
                entrySchemaVersion: exports.LOTTERY_ENTRY_SCHEMA_VERSION,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }
        return;
    }
    try {
        const allEntries = await (0, exports.listAllLotteryEntries)(lotteryRef);
        const usedNumbers = new Set();
        const nextAvailableNumber = (() => {
            let cursor = 1;
            return () => {
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
        const plannedEntries = [];
        const deferredEntries = [];
        for (const entryDoc of allEntries) {
            const parsedSelected = (0, exports.extractSelectedNumberFromEntryDoc)(entryDoc);
            const isSelectable = parsedSelected != null && parsedSelected >= 1 && parsedSelected <= maxNumber;
            if (!isSelectable || usedNumbers.has(parsedSelected)) {
                deferredEntries.push(entryDoc);
                continue;
            }
            usedNumbers.add(parsedSelected);
            plannedEntries.push({
                source: entryDoc,
                selectedNumber: parsedSelected,
                targetId: (0, exports.toLotteryEntryDocId)(parsedSelected)
            });
        }
        for (const entryDoc of deferredEntries) {
            const assigned = nextAvailableNumber();
            if (assigned == null) {
                throw new functions.https.HttpsError('failed-precondition', 'No hay suficientes numeros disponibles para migrar las entradas legacy. Aumenta maxNumber.');
            }
            plannedEntries.push({
                source: entryDoc,
                selectedNumber: assigned,
                targetId: (0, exports.toLotteryEntryDocId)(assigned)
            });
        }
        let batch = firestore.batch();
        let writes = 0;
        const flush = async () => {
            if (writes === 0)
                return;
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
            const payload = {
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
            if (writes >= exports.LOTTERY_MIGRATION_BATCH_SIZE) {
                await flush();
            }
        }
        batch.set(lotteryRef, {
            maxNumber,
            maxTicketsPerUser,
            participantsCount: plannedEntries.length,
            entrySchemaVersion: exports.LOTTERY_ENTRY_SCHEMA_VERSION,
            migrationStatus: 'done',
            migrationError: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        writes += 1;
        await flush();
    }
    catch (error) {
        await lotteryRef.set({
            migrationStatus: 'failed',
            migrationError: typeof (error === null || error === void 0 ? void 0 : error.message) === 'string'
                ? error.message.slice(0, 300)
                : 'migration-failed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        throw error;
    }
};
exports.ensureLotteryEntriesSchemaV2 = ensureLotteryEntriesSchemaV2;
const loadWebSocket = async () => {
    var _a;
    const wsModule = await Promise.resolve().then(() => require('ws'));
    return ((_a = wsModule.default) !== null && _a !== void 0 ? _a : wsModule);
};
const publishLotteryBallToOBS = (number, name, profilePicUrl = '') => {
    void publishLotteryBallToOBSAsync(number, name, profilePicUrl);
};
exports.publishLotteryBallToOBS = publishLotteryBallToOBS;
const publishLotteryBallToOBSAsync = async (number, name, profilePicUrl = '') => {
    const wsUrl = process.env.WS_LOTTERY_URL || 'ws://localhost:688';
    const wsToken = process.env.WS_LOTTERY_TOKEN || '';
    if (!wsUrl)
        return;
    try {
        const WebSocket = await loadWebSocket();
        const ws = new WebSocket(wsUrl);
        let settled = false;
        const done = () => {
            if (settled)
                return;
            settled = true;
            try {
                ws.close();
            }
            catch (_a) { }
        };
        const timeout = setTimeout(() => {
            console.warn('[lottery] OBS WS publish timed out');
            done();
        }, 3000);
        ws.on('open', () => {
            clearTimeout(timeout);
            const payload = {
                type: 'TRIGGER_BALL',
                number,
                name,
                profilePicUrl,
                eventId: `entry_${number}_${Date.now()}`
            };
            if (wsToken)
                payload.token = wsToken;
            ws.send(JSON.stringify(payload));
            done();
        });
        ws.on('error', (err) => {
            clearTimeout(timeout);
            console.warn('[lottery] OBS WS publish error:', err.message);
            done();
        });
    }
    catch (err) {
        console.warn('[lottery] OBS WS publish not available:', err.message);
    }
};
//# sourceMappingURL=lotteryUtils.js.map