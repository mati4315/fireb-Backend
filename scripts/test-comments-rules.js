const path = require('path');
const admin = require('firebase-admin');
const dotenv = require('dotenv');

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../Frontend/.env') });

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID
  });
}

const db = admin.firestore();
const projectId = process.env.FIREBASE_PROJECT_ID;
const apiKey = process.env.VITE_FIREBASE_API_KEY;

if (!projectId || !apiKey) {
  console.error('Missing FIREBASE_PROJECT_ID or VITE_FIREBASE_API_KEY in env.');
  process.exit(1);
}

function randomId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function toFsString(value) {
  return { stringValue: value };
}

function toFsBool(value) {
  return { booleanValue: value };
}

function toFsInt(value) {
  return { integerValue: String(value) };
}

function toFsNull() {
  return { nullValue: null };
}

function toFsTimestamp(value) {
  return { timestampValue: value.toISOString() };
}

function toFsMap(fields) {
  return { mapValue: { fields } };
}

async function signInAndGetIdToken(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Auth signIn failed: ${JSON.stringify(body)}`);
  }
  return body.idToken;
}

async function createDocWithToken(token, collectionPath, docId, fields) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collectionPath}?documentId=${encodeURIComponent(docId)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ fields })
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

async function patchDocWithToken(token, documentPath, fields, updateMask) {
  const updateMaskQuery = updateMask
    .map((fieldPath) => `updateMask.fieldPaths=${encodeURIComponent(fieldPath)}`)
    .join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${documentPath}?${updateMaskQuery}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ fields })
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

function expectStatus(label, actual, expected) {
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  if (!expectedValues.includes(actual)) {
    throw new Error(`${label} expected ${expectedValues.join('/')} and got ${actual}`);
  }
}

function buildCommentFields({ uid, userName, module, contentId, text }) {
  const now = new Date();
  return {
    userId: toFsString(uid),
    userName: toFsString(userName),
    userProfilePicUrl: toFsString(''),
    text: toFsString(text),
    module: toFsString(module),
    contentId: toFsString(contentId),
    stats: toFsMap({
      repliesCount: toFsInt(0)
    }),
    createdAt: toFsTimestamp(now),
    updatedAt: toFsTimestamp(now),
    isEdited: toFsBool(false),
    deletedAt: toFsNull()
  };
}

function buildReplyFields({ uid, userName, module, contentId, commentId, text }) {
  const now = new Date();
  return {
    userId: toFsString(uid),
    userName: toFsString(userName),
    userProfilePicUrl: toFsString(''),
    text: toFsString(text),
    module: toFsString(module),
    contentId: toFsString(contentId),
    commentId: toFsString(commentId),
    createdAt: toFsTimestamp(now),
    updatedAt: toFsTimestamp(now),
    isEdited: toFsBool(false),
    deletedAt: toFsNull()
  };
}

async function run() {
  console.log('Running comments rules E2E test...');

  const contentId = randomId('comments-content');
  const allowedCommentId = randomId('comment-allowed');
  const deniedGlobalCommentId = randomId('comment-denied-global');
  const deniedCommunityCommentId = randomId('comment-denied-community');
  const foreignCommentId = randomId('comment-foreign');
  const ownReplyId = randomId('reply-own');

  const regularEmail = `${randomId('comments-user')}@example.com`;
  const regularPassword = `Pwd!${Math.floor(Math.random() * 100000)}Ab`;
  const otherEmail = `${randomId('comments-other')}@example.com`;
  const otherPassword = `Pwd!${Math.floor(Math.random() * 100000)}Ab`;
  const collaboratorEmail = `${randomId('comments-colab')}@example.com`;
  const collaboratorPassword = `Pwd!${Math.floor(Math.random() * 100000)}Ab`;
  const adminEmail = `${randomId('comments-admin')}@example.com`;
  const adminPassword = `Pwd!${Math.floor(Math.random() * 100000)}Ab`;

  let regularUid = null;
  let otherUid = null;
  let collaboratorUid = null;
  let adminUid = null;

  try {
    const regularUser = await admin.auth().createUser({
      email: regularEmail,
      password: regularPassword,
      displayName: 'Comments User'
    });
    regularUid = regularUser.uid;

    const otherUser = await admin.auth().createUser({
      email: otherEmail,
      password: otherPassword,
      displayName: 'Comments Other'
    });
    otherUid = otherUser.uid;

    const collaboratorUser = await admin.auth().createUser({
      email: collaboratorEmail,
      password: collaboratorPassword,
      displayName: 'Comments Collaborator'
    });
    collaboratorUid = collaboratorUser.uid;

    const adminUser = await admin.auth().createUser({
      email: adminEmail,
      password: adminPassword,
      displayName: 'Comments Admin'
    });
    adminUid = adminUser.uid;

    await Promise.all([
      db.collection('users').doc(regularUid).set({
        email: regularEmail,
        nombre: 'Comments User',
        username: randomId('comments_user'),
        rol: 'user'
      }, { merge: true }),
      db.collection('users').doc(otherUid).set({
        email: otherEmail,
        nombre: 'Comments Other',
        username: randomId('comments_other'),
        rol: 'user'
      }, { merge: true }),
      db.collection('users').doc(collaboratorUid).set({
        email: collaboratorEmail,
        nombre: 'Comments Collaborator',
        username: randomId('comments_colab'),
        rol: 'colaborador'
      }, { merge: true }),
      db.collection('users').doc(adminUid).set({
        email: adminEmail,
        nombre: 'Comments Admin',
        username: randomId('comments_admin'),
        rol: 'admin'
      }, { merge: true }),
      db.collection('content').doc(contentId).set({
        module: 'community',
        type: 'post',
        source: 'user',
        userId: regularUid,
        userName: 'Comments User',
        userProfilePicUrl: '',
        titulo: 'Test comments rules',
        descripcion: 'E2E rules document',
        stats: {
          likesCount: 0,
          commentsCount: 0,
          viewsCount: 0
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        deletedAt: null
      }, { merge: true }),
      db.collection('_config').doc('modules').set({
        comments: {
          enabled: true,
          newsEnabled: true,
          communityEnabled: true
        }
      }, { merge: true })
    ]);

    const [regularToken, otherToken, collaboratorToken, adminToken] = await Promise.all([
      signInAndGetIdToken(regularEmail, regularPassword),
      signInAndGetIdToken(otherEmail, otherPassword),
      signInAndGetIdToken(collaboratorEmail, collaboratorPassword),
      signInAndGetIdToken(adminEmail, adminPassword)
    ]);

    const createAllowed = await createDocWithToken(
      regularToken,
      `content/${contentId}/comments`,
      allowedCommentId,
      buildCommentFields({
        uid: regularUid,
        userName: 'Comments User',
        module: 'community',
        contentId,
        text: 'Comentario permitido'
      })
    );
    expectStatus('regular create comment', createAllowed.status, 200);
    console.log('PASS regular user can create comments when module is enabled.');

    await db.collection('_config').doc('modules').set(
      { comments: { enabled: false, communityEnabled: true, newsEnabled: true } },
      { merge: true }
    );

    const createDeniedGlobal = await createDocWithToken(
      regularToken,
      `content/${contentId}/comments`,
      deniedGlobalCommentId,
      buildCommentFields({
        uid: regularUid,
        userName: 'Comments User',
        module: 'community',
        contentId,
        text: 'Debe fallar por modulo global'
      })
    );
    expectStatus('regular create denied when global disabled', createDeniedGlobal.status, 403);
    console.log('PASS create denied when comments.enabled is false.');

    await db.collection('_config').doc('modules').set(
      { comments: { enabled: true, communityEnabled: false, newsEnabled: true } },
      { merge: true }
    );

    const createDeniedCommunity = await createDocWithToken(
      regularToken,
      `content/${contentId}/comments`,
      deniedCommunityCommentId,
      buildCommentFields({
        uid: regularUid,
        userName: 'Comments User',
        module: 'community',
        contentId,
        text: 'Debe fallar por modulo community'
      })
    );
    expectStatus(
      'regular create denied when community comments disabled',
      createDeniedCommunity.status,
      403
    );
    console.log('PASS create denied when comments.communityEnabled is false.');

    await db.collection('_config').doc('modules').set(
      { comments: { enabled: true, communityEnabled: true, newsEnabled: true } },
      { merge: true }
    );

    const createForeignComment = await createDocWithToken(
      otherToken,
      `content/${contentId}/comments`,
      foreignCommentId,
      buildCommentFields({
        uid: otherUid,
        userName: 'Comments Other',
        module: 'community',
        contentId,
        text: 'Comentario de otro usuario'
      })
    );
    expectStatus('other user create comment', createForeignComment.status, 200);

    const regularEditsForeign = await patchDocWithToken(
      regularToken,
      `content/${contentId}/comments/${foreignCommentId}`,
      {
        text: toFsString('Intento editar comentario ajeno'),
        isEdited: toFsBool(true),
        updatedAt: toFsTimestamp(new Date())
      },
      ['text', 'isEdited', 'updatedAt']
    );
    expectStatus('regular cannot edit foreign comment', regularEditsForeign.status, 403);
    console.log('PASS regular user cannot edit someone else comment.');

    const collaboratorDeletesForeign = await patchDocWithToken(
      collaboratorToken,
      `content/${contentId}/comments/${foreignCommentId}`,
      {
        deletedAt: toFsTimestamp(new Date()),
        updatedAt: toFsTimestamp(new Date())
      },
      ['deletedAt', 'updatedAt']
    );
    expectStatus('collaborator cannot moderate foreign comment', collaboratorDeletesForeign.status, 403);
    console.log('PASS collaborator cannot moderate comments globally.');

    const adminEditsForeign = await patchDocWithToken(
      adminToken,
      `content/${contentId}/comments/${foreignCommentId}`,
      {
        text: toFsString('Edicion admin permitida'),
        isEdited: toFsBool(true),
        updatedAt: toFsTimestamp(new Date())
      },
      ['text', 'isEdited', 'updatedAt']
    );
    expectStatus('admin can edit foreign comment', adminEditsForeign.status, 200);

    const adminDeletesForeign = await patchDocWithToken(
      adminToken,
      `content/${contentId}/comments/${foreignCommentId}`,
      {
        deletedAt: toFsTimestamp(new Date()),
        updatedAt: toFsTimestamp(new Date())
      },
      ['deletedAt', 'updatedAt']
    );
    expectStatus('admin can soft delete foreign comment', adminDeletesForeign.status, 200);
    console.log('PASS admin can moderate any comment.');

    const createOwnReply = await createDocWithToken(
      regularToken,
      `content/${contentId}/comments/${allowedCommentId}/replies`,
      ownReplyId,
      buildReplyFields({
        uid: regularUid,
        userName: 'Comments User',
        module: 'community',
        contentId,
        commentId: allowedCommentId,
        text: 'Respuesta del autor'
      })
    );
    expectStatus('regular can create own reply', createOwnReply.status, 200);

    const collaboratorEditsReply = await patchDocWithToken(
      collaboratorToken,
      `content/${contentId}/comments/${allowedCommentId}/replies/${ownReplyId}`,
      {
        text: toFsString('Intento colaborador'),
        isEdited: toFsBool(true),
        updatedAt: toFsTimestamp(new Date())
      },
      ['text', 'isEdited', 'updatedAt']
    );
    expectStatus('collaborator cannot edit foreign reply', collaboratorEditsReply.status, 403);

    const adminEditsReply = await patchDocWithToken(
      adminToken,
      `content/${contentId}/comments/${allowedCommentId}/replies/${ownReplyId}`,
      {
        text: toFsString('Admin puede editar respuesta'),
        isEdited: toFsBool(true),
        updatedAt: toFsTimestamp(new Date())
      },
      ['text', 'isEdited', 'updatedAt']
    );
    expectStatus('admin can edit foreign reply', adminEditsReply.status, 200);
    console.log('PASS admin can moderate replies globally.');

    console.log('PASS: comments rules E2E validations completed.');
    process.exit(0);
  } catch (error) {
    console.error('FAIL:', error.message);
    process.exit(1);
  } finally {
    try { await db.collection('content').doc(contentId).collection('comments').doc(allowedCommentId).collection('replies').doc(ownReplyId).delete(); } catch {}
    try { await db.collection('content').doc(contentId).collection('comments').doc(allowedCommentId).delete(); } catch {}
    try { await db.collection('content').doc(contentId).collection('comments').doc(foreignCommentId).delete(); } catch {}
    try { await db.collection('content').doc(contentId).collection('comments').doc(deniedGlobalCommentId).delete(); } catch {}
    try { await db.collection('content').doc(contentId).collection('comments').doc(deniedCommunityCommentId).delete(); } catch {}
    try { await db.collection('content').doc(contentId).delete(); } catch {}
    if (regularUid) {
      try { await db.collection('users').doc(regularUid).delete(); } catch {}
      try { await admin.auth().deleteUser(regularUid); } catch {}
    }
    if (otherUid) {
      try { await db.collection('users').doc(otherUid).delete(); } catch {}
      try { await admin.auth().deleteUser(otherUid); } catch {}
    }
    if (collaboratorUid) {
      try { await db.collection('users').doc(collaboratorUid).delete(); } catch {}
      try { await admin.auth().deleteUser(collaboratorUid); } catch {}
    }
    if (adminUid) {
      try { await db.collection('users').doc(adminUid).delete(); } catch {}
      try { await admin.auth().deleteUser(adminUid); } catch {}
    }
  }
}

run();
