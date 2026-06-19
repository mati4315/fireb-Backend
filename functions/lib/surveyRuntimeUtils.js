"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.completeExpiredSurveysInternal = exports.submitSurveyVoteInternal = void 0;
const admin = require("firebase-admin");
const functions = require("firebase-functions");
const userUtils_1 = require("./userUtils");
const timeUtils_1 = require("./timeUtils");
const surveyUtils_1 = require("./surveyUtils");
const submitSurveyVoteInternal = async (db, data, context) => {
    var _a;
    const userId = (_a = context.auth) === null || _a === void 0 ? void 0 : _a.uid;
    if (!userId) {
        throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion para votar.');
    }
    const surveyId = typeof (data === null || data === void 0 ? void 0 : data.surveyId) === 'string' ? data.surveyId.trim() : '';
    const optionIds = (0, userUtils_1.normalizeOptionIds)(data === null || data === void 0 ? void 0 : data.optionIds);
    const idempotencyKeyRaw = typeof (data === null || data === void 0 ? void 0 : data.idempotencyKey) === 'string'
        ? data.idempotencyKey.trim()
        : '';
    const idempotencyKey = idempotencyKeyRaw ? idempotencyKeyRaw.slice(0, 120) : null;
    if (!surveyId) {
        throw new functions.https.HttpsError('invalid-argument', 'surveyId es obligatorio.');
    }
    if (optionIds.length === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'Debes seleccionar al menos una opcion.');
    }
    if (optionIds.length > surveyUtils_1.MAX_SURVEY_OPTIONS_SELECTED) {
        throw new functions.https.HttpsError('invalid-argument', 'Cantidad de opciones seleccionadas invalida.');
    }
    const surveyRef = db.collection('surveys').doc(surveyId);
    const voteRef = db.collection('survey_votes').doc(`${surveyId}_${userId}`);
    const modulesConfigRef = db.collection('_config').doc('modules');
    return db.runTransaction(async (tx) => {
        var _a, _b, _c, _d;
        const [modulesConfigSnap, surveySnap, existingVoteSnap] = await Promise.all([
            tx.get(modulesConfigRef),
            tx.get(surveyRef),
            tx.get(voteRef)
        ]);
        const surveysEnabled = Boolean((_c = (_b = (_a = modulesConfigSnap.data()) === null || _a === void 0 ? void 0 : _a.surveys) === null || _b === void 0 ? void 0 : _b.enabled) !== null && _c !== void 0 ? _c : true);
        if (!surveysEnabled) {
            throw new functions.https.HttpsError('failed-precondition', 'El modulo de encuestas esta deshabilitado.');
        }
        if (!surveySnap.exists) {
            throw new functions.https.HttpsError('not-found', 'La encuesta no existe.');
        }
        const surveyData = surveySnap.data() || {};
        const surveyStatus = (surveyData.status || 'inactive');
        if (!(0, surveyUtils_1.isSurveyActive)(surveyStatus)) {
            throw new functions.https.HttpsError('failed-precondition', 'La encuesta no esta activa.');
        }
        if ((0, timeUtils_1.isExpired)(surveyData.expiresAt)) {
            throw new functions.https.HttpsError('failed-precondition', 'La encuesta ya expiro.');
        }
        const isMultipleChoice = Boolean(surveyData.isMultipleChoice);
        const maxVotesPerUser = (0, surveyUtils_1.getSurveyMaxVotesPerUser)(isMultipleChoice, (_d = surveyData.maxVotesPerUser) !== null && _d !== void 0 ? _d : 1);
        if (!isMultipleChoice && optionIds.length !== 1) {
            throw new functions.https.HttpsError('invalid-argument', 'Esta encuesta permite solo una opcion.');
        }
        if (optionIds.length > maxVotesPerUser) {
            throw new functions.https.HttpsError('invalid-argument', 'Superaste el maximo de opciones permitidas.');
        }
        const surveyOptions = (0, userUtils_1.normalizeSurveyOptions)(surveyData.options);
        if (surveyOptions.length < 2) {
            throw new functions.https.HttpsError('failed-precondition', 'La encuesta no tiene opciones validas para votar.');
        }
        const availableOptionIds = new Set();
        for (const option of surveyOptions) {
            const optionRecord = option;
            if (optionRecord.active) {
                availableOptionIds.add(optionRecord.id);
            }
        }
        for (const selectedOptionId of optionIds) {
            if (!availableOptionIds.has(selectedOptionId)) {
                throw new functions.https.HttpsError('invalid-argument', 'Seleccionaste una opcion invalida.');
            }
        }
        if (existingVoteSnap.exists) {
            const existingVote = existingVoteSnap.data() || {};
            return {
                status: 'already_voted',
                surveyId,
                optionIds: (0, userUtils_1.normalizeOptionIds)(existingVote.optionIds)
            };
        }
        const optionSelectionCounts = new Map();
        for (const optionId of optionIds) {
            const previousCount = optionSelectionCounts.get(optionId) || 0;
            optionSelectionCounts.set(optionId, previousCount + 1);
        }
        const nextOptions = surveyOptions.map((option) => {
            const optionRecord = option;
            const incrementBy = optionSelectionCounts.get(optionRecord.id) || 0;
            if (incrementBy <= 0)
                return option;
            return Object.assign(Object.assign({}, optionRecord), { voteCount: Number(optionRecord.voteCount || 0) + incrementBy });
        });
        const votePayload = {
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
};
exports.submitSurveyVoteInternal = submitSurveyVoteInternal;
const completeExpiredSurveysInternal = async (db) => {
    let completedCount = 0;
    while (true) {
        const snapshot = await db.collection('surveys')
            .where('status', '==', 'active')
            .where('expiresAt', '<=', admin.firestore.Timestamp.now())
            .orderBy('expiresAt', 'asc')
            .limit(surveyUtils_1.SURVEY_COMPLETE_BATCH_SIZE)
            .get();
        if (snapshot.empty)
            break;
        const batch = db.batch();
        for (const surveyDoc of snapshot.docs) {
            batch.update(surveyDoc.ref, {
                status: 'completed',
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        await batch.commit();
        completedCount += snapshot.size;
        if (snapshot.size < surveyUtils_1.SURVEY_COMPLETE_BATCH_SIZE)
            break;
    }
    console.log(`Expired surveys completed: ${completedCount}`);
};
exports.completeExpiredSurveysInternal = completeExpiredSurveysInternal;
//# sourceMappingURL=surveyRuntimeUtils.js.map