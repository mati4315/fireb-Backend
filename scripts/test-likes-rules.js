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

function toFsTimestamp(value) {
  return { timestampValue: value.toISOString() };
}

async function signInAndGetIdToken(email, password) {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Auth signIn failed: ${JSON.stringify(body)}`);
  }
  return body.idToken;
}

async function createLikeDocument({ token, contentId, likeUserId, fields }) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/content/${contentId}/likes?documentId=${likeUserId}`;
  const headers = {
    'Content-Type': 'application/json'
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fields })
  });

  let body;
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  return { status: res.status, body };
}

async function deleteLikeDocument({ token, contentId, likeUserId }) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/content/${contentId}/likes/${likeUserId}`;
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: 'DELETE',
    headers
  });

  let body;
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  return { status: res.status, body };
}

function expectStatus(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name} expected HTTP ${expected}, got ${actual}`);
  }
}

function expectStatusIn(name, actual, expectedList) {
  if (!expectedList.includes(actual)) {
    throw new Error(
      `${name} expected one of [${expectedList.join(', ')}], got ${actual}`
    );
  }
}

async function run() {
  console.log('Running likes rules E2E test...');

  const modulesRef = db.collection('_config').doc('modules');
  const previousModulesSnap = await modulesRef.get();
  const previousLikesConfig = previousModulesSnap.exists
    ? previousModulesSnap.data()?.likes
    : undefined;

  const userAEmail = `${randomId('likes-user-a')}@example.com`;
  const userBEmail = `${randomId('likes-user-b')}@example.com`;
  const userPassword = `Pwd!${Math.floor(Math.random() * 100000)}Ab`;

  const contentCommunityId = randomId('likes-community');
  const contentNewsId = randomId('likes-news');
  const contentDeletedId = randomId('likes-deleted');

  let userAUid = null;
  let userBUid = null;

  try {
    const userA = await admin.auth().createUser({
      email: userAEmail,
      password: userPassword,
      displayName: 'Likes Test User A'
    });
    userAUid = userA.uid;

    const userB = await admin.auth().createUser({
      email: userBEmail,
      password: userPassword,
      displayName: 'Likes Test User B'
    });
    userBUid = userB.uid;

    await modulesRef.set(
      {
        likes: {
          enabled: true,
          newsEnabled: true,
          communityEnabled: true
        }
      },
      { merge: true }
    );

    await db.collection('content').doc(contentCommunityId).set({
      type: 'post',
      module: 'community',
      source: 'user',
      isOficial: false,
      titulo: 'Test community likes',
      descripcion: 'Rules test',
      userId: userAUid,
      userName: 'Likes Test User A',
      userProfilePicUrl: '',
      stats: {
        likesCount: 0,
        commentsCount: 0,
        viewsCount: 0
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedAt: null
    });

    await db.collection('content').doc(contentNewsId).set({
      type: 'news',
      module: 'news',
      source: 'wordpress',
      isOficial: true,
      titulo: 'Test news likes',
      descripcion: 'Rules test',
      userId: 'wp_official',
      userName: 'Redaccion',
      userProfilePicUrl: '',
      stats: {
        likesCount: 0,
        commentsCount: 0,
        viewsCount: 0
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedAt: null
    });

    await db.collection('content').doc(contentDeletedId).set({
      type: 'post',
      module: 'community',
      source: 'user',
      isOficial: false,
      titulo: 'Test deleted content likes',
      descripcion: 'Rules test',
      userId: userAUid,
      userName: 'Likes Test User A',
      userProfilePicUrl: '',
      stats: {
        likesCount: 0,
        commentsCount: 0,
        viewsCount: 0
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const userAToken = await signInAndGetIdToken(userAEmail, userPassword);
    const userBToken = await signInAndGetIdToken(userBEmail, userPassword);

    const unauthCreate = await createLikeDocument({
      token: null,
      contentId: contentCommunityId,
      likeUserId: userAUid,
      fields: {
        createdAt: toFsTimestamp(new Date())
      }
    });
    expectStatusIn('Unauthenticated like create', unauthCreate.status, [401, 403]);
    console.log('PASS unauthenticated user cannot create like.');

    const createOwnLike = await createLikeDocument({
      token: userAToken,
      contentId: contentCommunityId,
      likeUserId: userAUid,
      fields: {
        createdAt: toFsTimestamp(new Date())
      }
    });
    expectStatus('Authenticated own like create', createOwnLike.status, 200);
    console.log('PASS user can create own like.');

    const deleteForeignLike = await deleteLikeDocument({
      token: userBToken,
      contentId: contentCommunityId,
      likeUserId: userAUid
    });
    expectStatus('Foreign user cannot delete like', deleteForeignLike.status, 403);
    console.log('PASS user cannot delete another user like.');

    const deleteOwnLike = await deleteLikeDocument({
      token: userAToken,
      contentId: contentCommunityId,
      likeUserId: userAUid
    });
    expectStatus('Owner can delete own like', deleteOwnLike.status, 200);
    console.log('PASS user can delete own like.');

    const invalidPayloadCreate = await createLikeDocument({
      token: userAToken,
      contentId: contentCommunityId,
      likeUserId: userAUid,
      fields: {
        createdAt: toFsTimestamp(new Date()),
        malicious: toFsString('not-allowed')
      }
    });
    expectStatus('Invalid payload denied', invalidPayloadCreate.status, 403);
    console.log('PASS invalid like payload is denied.');

    const deletedContentCreate = await createLikeDocument({
      token: userAToken,
      contentId: contentDeletedId,
      likeUserId: userAUid,
      fields: {
        createdAt: toFsTimestamp(new Date())
      }
    });
    expectStatus('Deleted content like denied', deletedContentCreate.status, 403);
    console.log('PASS likes are denied on deleted content.');

    await modulesRef.set(
      {
        likes: {
          enabled: true,
          newsEnabled: false,
          communityEnabled: true
        }
      },
      { merge: true }
    );

    const newsLikeWhenDisabled = await createLikeDocument({
      token: userAToken,
      contentId: contentNewsId,
      likeUserId: userAUid,
      fields: {
        createdAt: toFsTimestamp(new Date())
      }
    });
    expectStatus('News like disabled by module flag', newsLikeWhenDisabled.status, 403);
    console.log('PASS likes module flag blocks disabled content module.');

    const communityLikeWhenEnabled = await createLikeDocument({
      token: userAToken,
      contentId: contentCommunityId,
      likeUserId: userAUid,
      fields: {
        createdAt: toFsTimestamp(new Date())
      }
    });
    expectStatus('Community like still enabled', communityLikeWhenEnabled.status, 200);
    console.log('PASS enabled content module still accepts likes.');

    console.log('PASS: likes rules E2E validations completed.');
    process.exit(0);
  } catch (error) {
    console.error('FAIL:', error.message);
    process.exit(1);
  } finally {
    try {
      await db.collection('content').doc(contentCommunityId).collection('likes').doc(userAUid).delete();
    } catch {}
    try {
      await db.collection('content').doc(contentNewsId).collection('likes').doc(userAUid).delete();
    } catch {}
    try {
      await db.collection('content').doc(contentDeletedId).collection('likes').doc(userAUid).delete();
    } catch {}
    try {
      await db.collection('content').doc(contentCommunityId).delete();
    } catch {}
    try {
      await db.collection('content').doc(contentNewsId).delete();
    } catch {}
    try {
      await db.collection('content').doc(contentDeletedId).delete();
    } catch {}

    if (userAUid) {
      try {
        await admin.auth().deleteUser(userAUid);
      } catch {}
    }
    if (userBUid) {
      try {
        await admin.auth().deleteUser(userBUid);
      } catch {}
    }

    try {
      if (typeof previousLikesConfig === 'undefined') {
        await modulesRef.set(
          { likes: admin.firestore.FieldValue.delete() },
          { merge: true }
        );
      } else {
        await modulesRef.set({ likes: previousLikesConfig }, { merge: true });
      }
    } catch {}
  }
}

run();
