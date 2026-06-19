import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import {
  assertStaffUser,
  assertSystemAdminUser,
  normalizeUsernameCandidate,
  sanitizeBoundedString,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_REGEX
} from './userUtils';

export const updateUserManagementInternal = async (
  db: FirebaseFirestore.Firestore,
  data: any,
  context: functions.https.CallableContext
): Promise<Record<string, unknown>> => {
  await assertStaffUser(db, context.auth);

  const requesterAuth = context.auth;
  const targetUserId = sanitizeBoundedString(data?.userId, 128);
  if (!targetUserId) {
    throw new functions.https.HttpsError('invalid-argument', 'userId es obligatorio.');
  }

  const nextRole = sanitizeBoundedString(data?.rol, 40);
  const hasRoleUpdate = nextRole.length > 0;
  const allowedRoles = new Set([
    'usuario',
    'colaborador',
    'admin',
    'administrador',
    'super_admin',
    'superadmin',
    'Sistema-no-user',
    'sistema-no-user'
  ]);
  if (hasRoleUpdate && !allowedRoles.has(nextRole)) {
    throw new functions.https.HttpsError('invalid-argument', 'Rol invalido.');
  }

  const hasVerifiedUpdate = typeof data?.isVerified === 'boolean';
  const nextIsVerified = hasVerifiedUpdate ? Boolean(data.isVerified) : null;

  const nextNombreRaw = sanitizeBoundedString(data?.nombre, 120);
  const nextEmailRaw = sanitizeBoundedString(data?.email, 320).toLowerCase();
  const usernameCandidate = normalizeUsernameCandidate(data?.username);
  const hasCoreFieldInput = (
    typeof data?.nombre === 'string' ||
    typeof data?.username === 'string' ||
    typeof data?.email === 'string'
  );

  if (typeof data?.username === 'string' && usernameCandidate.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Username invalido.');
  }
  if (
    typeof data?.username === 'string' &&
    (usernameCandidate.length < USERNAME_MIN_LENGTH ||
      usernameCandidate.length > USERNAME_MAX_LENGTH ||
      !USERNAME_REGEX.test(usernameCandidate))
  ) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Username invalido. Usa entre 3 y 30 caracteres: a-z, 0-9 y _.'
    );
  }
  if (typeof data?.nombre === 'string' && !nextNombreRaw) {
    throw new functions.https.HttpsError('invalid-argument', 'Nombre invalido.');
  }
  if (typeof data?.email === 'string') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(nextEmailRaw)) {
      throw new functions.https.HttpsError('invalid-argument', 'Email invalido.');
    }
  }

  const userRef = db.collection('users').doc(targetUserId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Usuario no encontrado.');
  }

  const currentData = userSnap.data() || {};
  const currentNombre = sanitizeBoundedString(currentData.nombre, 120);
  const currentEmail = sanitizeBoundedString(currentData.email, 320).toLowerCase();
  const currentUsernameLower = sanitizeBoundedString(currentData.usernameLower, USERNAME_MAX_LENGTH);
  const nextUsernameLower = typeof data?.username === 'string'
    ? usernameCandidate
    : currentUsernameLower;

  const nextNombre = typeof data?.nombre === 'string' ? nextNombreRaw : currentNombre;
  const nextEmail = typeof data?.email === 'string' ? nextEmailRaw : currentEmail;
  const willUpdateCoreFields = hasCoreFieldInput && (
    nextNombre !== currentNombre ||
    nextEmail !== currentEmail ||
    nextUsernameLower !== currentUsernameLower
  );

  if (willUpdateCoreFields) {
    assertSystemAdminUser(requesterAuth);
  }

  if (nextUsernameLower !== currentUsernameLower) {
    const usernameRef = db.collection('usernames').doc(nextUsernameLower);
    const usernameSnap = await usernameRef.get();
    if (usernameSnap.exists && usernameSnap.data()?.uid !== targetUserId) {
      throw new functions.https.HttpsError('already-exists', 'Ese username ya esta en uso.');
    }
  }

  const updates: Record<string, unknown> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (hasRoleUpdate) {
    updates.rol = nextRole;
  }
  if (hasVerifiedUpdate) {
    updates.isVerified = nextIsVerified;
  }
  if (willUpdateCoreFields) {
    updates.nombre = nextNombre;
    updates.email = nextEmail;
    updates.username = nextUsernameLower;
    updates.usernameLower = nextUsernameLower;
  }

  await userRef.set(updates, { merge: true });

  if (willUpdateCoreFields && nextEmail !== currentEmail) {
    await admin.auth().updateUser(targetUserId, { email: nextEmail });
  }

  return {
    ok: true,
    userId: targetUserId,
    updated: {
      rol: hasRoleUpdate ? nextRole : currentData.rol,
      isVerified: hasVerifiedUpdate ? nextIsVerified : currentData.isVerified,
      nombre: willUpdateCoreFields ? nextNombre : currentData.nombre,
      email: willUpdateCoreFields ? nextEmail : currentData.email,
      username: willUpdateCoreFields ? nextUsernameLower : currentData.username
    }
  };
};

export const getUsersSocialConnectionsInternal = async (
  db: FirebaseFirestore.Firestore,
  data: any,
  context: functions.https.CallableContext
): Promise<Record<string, unknown>> => {
  await assertStaffUser(db, context.auth);

  const rawUserIds = Array.isArray(data?.userIds) ? data.userIds : [];
  const normalizedUserIds: string[] = rawUserIds
    .map((value: unknown) => sanitizeBoundedString(value, 128))
    .filter((value: string) => value.length > 0);
  const userIds: string[] = Array.from(new Set(normalizedUserIds)).slice(0, 50);

  if (userIds.length === 0) {
    return {
      ok: true,
      records: {}
    };
  }

  const records: Record<string, { providerIds: string[] }> = {};
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const userRecord = await admin.auth().getUser(uid);
        const providerIds = Array.from(
          new Set(
            (userRecord.providerData || [])
              .map((provider) => sanitizeBoundedString(provider.providerId, 64))
              .filter((providerId) => providerId.length > 0)
          )
        );
        records[uid] = { providerIds };
      } catch (error: any) {
        if (error?.code === 'auth/user-not-found') {
          records[uid] = { providerIds: [] };
          return;
        }
        console.error(`Error loading auth providers for uid ${uid}:`, error);
      }
    })
  );

  return {
    ok: true,
    records
  };
};
