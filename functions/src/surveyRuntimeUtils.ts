import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { normalizeOptionIds, normalizeSurveyOptions } from './userUtils';
import { isExpired } from './timeUtils';
import {
  getSurveyMaxVotesPerUser,
  isSurveyActive,
  MAX_SURVEY_OPTIONS_SELECTED,
  SURVEY_COMPLETE_BATCH_SIZE,
  type SurveyStatus
} from './surveyUtils';

export const submitSurveyVoteInternal = async (
  db: FirebaseFirestore.Firestore,
  data: any,
  context: functions.https.CallableContext
) => {
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
    if (!isSurveyActive(surveyStatus)) {
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
    const maxVotesPerUser = getSurveyMaxVotesPerUser(isMultipleChoice, surveyData.maxVotesPerUser ?? 1);

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
      const optionRecord = option as { id: string; active: boolean };
      if (optionRecord.active) {
        availableOptionIds.add(optionRecord.id);
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
      const optionRecord = option as { id: string; voteCount: number };
      const incrementBy = optionSelectionCounts.get(optionRecord.id) || 0;
      if (incrementBy <= 0) return option;

      return {
        ...optionRecord,
        voteCount: Number(optionRecord.voteCount || 0) + incrementBy
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
};

export const completeExpiredSurveysInternal = async (db: FirebaseFirestore.Firestore): Promise<void> => {
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
};
