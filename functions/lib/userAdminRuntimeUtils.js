"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUsersSocialConnectionsInternal = exports.updateUserManagementInternal = void 0;
const admin = require("firebase-admin");
const functions = require("firebase-functions");
const userUtils_1 = require("./userUtils");
const updateUserManagementInternal = async (db, data, context) => {
    var _a;
    await (0, userUtils_1.assertStaffUser)(db, context.auth);
    const requesterAuth = context.auth;
    const targetUserId = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.userId, 128);
    if (!targetUserId) {
        throw new functions.https.HttpsError('invalid-argument', 'userId es obligatorio.');
    }
    const nextRole = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.rol, 40);
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
    const hasVerifiedUpdate = typeof (data === null || data === void 0 ? void 0 : data.isVerified) === 'boolean';
    const nextIsVerified = hasVerifiedUpdate ? Boolean(data.isVerified) : null;
    const nextNombreRaw = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.nombre, 120);
    const nextEmailRaw = (0, userUtils_1.sanitizeBoundedString)(data === null || data === void 0 ? void 0 : data.email, 320).toLowerCase();
    const usernameCandidate = (0, userUtils_1.normalizeUsernameCandidate)(data === null || data === void 0 ? void 0 : data.username);
    const hasCoreFieldInput = (typeof (data === null || data === void 0 ? void 0 : data.nombre) === 'string' ||
        typeof (data === null || data === void 0 ? void 0 : data.username) === 'string' ||
        typeof (data === null || data === void 0 ? void 0 : data.email) === 'string');
    if (typeof (data === null || data === void 0 ? void 0 : data.username) === 'string' && usernameCandidate.length === 0) {
        throw new functions.https.HttpsError('invalid-argument', 'Username invalido.');
    }
    if (typeof (data === null || data === void 0 ? void 0 : data.username) === 'string' &&
        (usernameCandidate.length < userUtils_1.USERNAME_MIN_LENGTH ||
            usernameCandidate.length > userUtils_1.USERNAME_MAX_LENGTH ||
            !userUtils_1.USERNAME_REGEX.test(usernameCandidate))) {
        throw new functions.https.HttpsError('invalid-argument', 'Username invalido. Usa entre 3 y 30 caracteres: a-z, 0-9 y _.');
    }
    if (typeof (data === null || data === void 0 ? void 0 : data.nombre) === 'string' && !nextNombreRaw) {
        throw new functions.https.HttpsError('invalid-argument', 'Nombre invalido.');
    }
    if (typeof (data === null || data === void 0 ? void 0 : data.email) === 'string') {
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
    const currentNombre = (0, userUtils_1.sanitizeBoundedString)(currentData.nombre, 120);
    const currentEmail = (0, userUtils_1.sanitizeBoundedString)(currentData.email, 320).toLowerCase();
    const currentUsernameLower = (0, userUtils_1.sanitizeBoundedString)(currentData.usernameLower, userUtils_1.USERNAME_MAX_LENGTH);
    const nextUsernameLower = typeof (data === null || data === void 0 ? void 0 : data.username) === 'string'
        ? usernameCandidate
        : currentUsernameLower;
    const nextNombre = typeof (data === null || data === void 0 ? void 0 : data.nombre) === 'string' ? nextNombreRaw : currentNombre;
    const nextEmail = typeof (data === null || data === void 0 ? void 0 : data.email) === 'string' ? nextEmailRaw : currentEmail;
    const willUpdateCoreFields = hasCoreFieldInput && (nextNombre !== currentNombre ||
        nextEmail !== currentEmail ||
        nextUsernameLower !== currentUsernameLower);
    if (willUpdateCoreFields) {
        (0, userUtils_1.assertSystemAdminUser)(requesterAuth);
    }
    if (nextUsernameLower !== currentUsernameLower) {
        const usernameRef = db.collection('usernames').doc(nextUsernameLower);
        const usernameSnap = await usernameRef.get();
        if (usernameSnap.exists && ((_a = usernameSnap.data()) === null || _a === void 0 ? void 0 : _a.uid) !== targetUserId) {
            throw new functions.https.HttpsError('already-exists', 'Ese username ya esta en uso.');
        }
    }
    const updates = {
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
exports.updateUserManagementInternal = updateUserManagementInternal;
const getUsersSocialConnectionsInternal = async (db, data, context) => {
    await (0, userUtils_1.assertStaffUser)(db, context.auth);
    const rawUserIds = Array.isArray(data === null || data === void 0 ? void 0 : data.userIds) ? data.userIds : [];
    const normalizedUserIds = rawUserIds
        .map((value) => (0, userUtils_1.sanitizeBoundedString)(value, 128))
        .filter((value) => value.length > 0);
    const userIds = Array.from(new Set(normalizedUserIds)).slice(0, 50);
    if (userIds.length === 0) {
        return {
            ok: true,
            records: {}
        };
    }
    const records = {};
    await Promise.all(userIds.map(async (uid) => {
        try {
            const userRecord = await admin.auth().getUser(uid);
            const providerIds = Array.from(new Set((userRecord.providerData || [])
                .map((provider) => (0, userUtils_1.sanitizeBoundedString)(provider.providerId, 64))
                .filter((providerId) => providerId.length > 0)));
            records[uid] = { providerIds };
        }
        catch (error) {
            if ((error === null || error === void 0 ? void 0 : error.code) === 'auth/user-not-found') {
                records[uid] = { providerIds: [] };
                return;
            }
            console.error(`Error loading auth providers for uid ${uid}:`, error);
        }
    }));
    return {
        ok: true,
        records
    };
};
exports.getUsersSocialConnectionsInternal = getUsersSocialConnectionsInternal;
//# sourceMappingURL=userAdminRuntimeUtils.js.map