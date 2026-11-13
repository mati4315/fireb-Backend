import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { assertAdminUser } from './userUtils';

const getShortLinkOneConfigRef = () => admin.firestore().collection('short_link_config').doc('one');

const normalizeShortLinkTarget = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 2048) return null;

  try {
    const target = new URL(candidate);
    if (target.protocol !== 'https:' || !target.hostname || target.username || target.password) return null;
    return target.toString();
  } catch {
    return null;
  }
};

export const getShortLinkOneConfig = functions.https.onCall(async (_data, context) => {
  const db = admin.firestore();
  await assertAdminUser(db, context.auth);
  const snapshot = await getShortLinkOneConfigRef().get();
  const url = normalizeShortLinkTarget(snapshot.get('url')) || '';
  const updatedAt = snapshot.get('updatedAt');
  return {
    url,
    updatedAt: updatedAt?.toDate?.()?.toISOString?.() || null
  };
});

export const setShortLinkOneConfig = functions.https.onCall(async (data, context) => {
  const db = admin.firestore();
  await assertAdminUser(db, context.auth);
  const url = normalizeShortLinkTarget(data?.url);
  if (!url) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Ingresa una URL HTTPS válida de hasta 2048 caracteres.'
    );
  }

  await getShortLinkOneConfigRef().set({
    url,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: context.auth?.uid || ''
  });
  return { url };
});

export const getShortLinkOnePublic = functions.https.onCall(async () => {
  const snapshot = await getShortLinkOneConfigRef().get();
  const url = normalizeShortLinkTarget(snapshot.get('url'));
  if (!url) {
    throw new functions.https.HttpsError(
      'not-found',
      'El enlace /1 todavía no tiene un destino configurado.'
    );
  }
  return { url };
});

export const redirectShortLinkOne = functions.https.onRequest(async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.set('Allow', 'GET, HEAD').status(405).send('Método no permitido.');
    return;
  }

  try {
    const snapshot = await getShortLinkOneConfigRef().get();
    const url = normalizeShortLinkTarget(snapshot.get('url'));
    if (!url) {
      res.status(404).type('text/plain').send('El enlace /1 todavía no tiene un destino configurado.');
      return;
    }

    res.status(302).set('Location', url).end();
  } catch (error) {
    console.error('No se pudo resolver el enlace corto /1:', error);
    res.status(503).type('text/plain').send('No se pudo resolver el enlace en este momento.');
  }
});
