const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID
  });
}

const db = admin.firestore();

const FOLLOWED_USER_ID = 'trigger-test-followed-user';
const FOLLOWER_USER_ID = 'trigger-test-follower-user';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureUser(userId) {
  const ref = db.collection('users').doc(userId);
  const snap = await ref.get();

  if (snap.exists) {
    await ref.set(
      {
        stats: {
          followersCount: snap.get('stats.followersCount') || 0,
          followingCount: snap.get('stats.followingCount') || 0
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    return;
  }

  await ref.set({
    nombre: userId,
    email: `${userId}@example.com`,
    username: userId,
    rol: 'user',
    stats: {
      postsCount: 0,
      followersCount: 0,
      followingCount: 0
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function readFollowStats() {
  const [followedSnap, followerSnap] = await Promise.all([
    db.collection('users').doc(FOLLOWED_USER_ID).get(),
    db.collection('users').doc(FOLLOWER_USER_ID).get()
  ]);

  return {
    followedFollowersCount: followedSnap.get('stats.followersCount') || 0,
    followerFollowingCount: followerSnap.get('stats.followingCount') || 0
  };
}

async function waitForStats(expected, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await readFollowStats();
    if (
      current.followedFollowersCount === expected.followedFollowersCount &&
      current.followerFollowingCount === expected.followerFollowingCount
    ) {
      return current;
    }
    await sleep(1000);
  }

  return readFollowStats();
}

async function run() {
  console.log('Running follow trigger E2E test...');

  const followRef = db
    .collection('relationships')
    .doc(FOLLOWED_USER_ID)
    .collection('followers')
    .doc(FOLLOWER_USER_ID);

  try {
    await Promise.all([ensureUser(FOLLOWED_USER_ID), ensureUser(FOLLOWER_USER_ID)]);

    const baseline = await readFollowStats();
    console.log('Baseline stats:', baseline);

    await followRef.set({
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'trigger-test'
    });
    console.log('Follow document created. Waiting for increment...');

    const expectedUp = {
      followedFollowersCount: baseline.followedFollowersCount + 1,
      followerFollowingCount: baseline.followerFollowingCount + 1
    };
    const afterCreate = await waitForStats(expectedUp);
    console.log('Stats after create:', afterCreate);

    if (
      afterCreate.followedFollowersCount !== expectedUp.followedFollowersCount ||
      afterCreate.followerFollowingCount !== expectedUp.followerFollowingCount
    ) {
      throw new Error(
        `Increment check failed. Expected ${JSON.stringify(expectedUp)}, got ${JSON.stringify(afterCreate)}`
      );
    }

    await followRef.delete();
    console.log('Follow document deleted. Waiting for decrement...');

    const afterDelete = await waitForStats(baseline);
    console.log('Stats after delete:', afterDelete);

    if (
      afterDelete.followedFollowersCount !== baseline.followedFollowersCount ||
      afterDelete.followerFollowingCount !== baseline.followerFollowingCount
    ) {
      throw new Error(
        `Decrement check failed. Expected ${JSON.stringify(baseline)}, got ${JSON.stringify(afterDelete)}`
      );
    }

    console.log('PASS: follow triggers increment and decrement counters correctly.');
    process.exit(0);
  } catch (error) {
    console.error('FAIL:', error.message);
    process.exit(1);
  } finally {
    try {
      const doc = await followRef.get();
      if (doc.exists) {
        await followRef.delete();
      }
    } catch (cleanupError) {
      console.error('Cleanup warning:', cleanupError.message);
    }
  }
}

run();
