const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();

async function createWp2User() {
  const email = 'noticia@cdelu.ar';
  const password = 'w35115415';
  const username = 'wp_2';
  const displayName = 'Noticias Cdelu.ar';
  const normalizedUsername = username.toLowerCase().replace(/[^a-z0-9_]/g, '_');

  try {
    console.log(`Verificando usuario con email: ${email}`);

    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
      console.log('El usuario ya existe en Firebase Auth. Actualizando contraseña y displayName...');
      userRecord = await admin.auth().updateUser(userRecord.uid, {
        password,
        displayName
      });
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        console.log('Usuario no existe en Auth. Creando nuevo usuario...');
        userRecord = await admin.auth().createUser({
          email,
          password,
          displayName
        });
      } else {
        throw err;
      }
    }

    const uid = userRecord.uid;
    const now = admin.firestore.FieldValue.serverTimestamp();

    const profileData = {
      id: uid,
      email,
      nombre: displayName,
      username,
      usernameLower: normalizedUsername,
      bio: 'Cuenta oficial de Noticias Cdelu.ar generada desde el sistema.',
      location: 'Cdelu.ar',
      website: 'https://cdelu.ar',
      profilePictureUrl: '',
      rol: 'user',
      isVerified: false,
      stats: {
        postsCount: 0,
        followersCount: 0,
        followingCount: 0,
        likesTotalCount: 0
      },
      settings: {
        notificationsEnabled: true,
        privateAccount: false,
        notificationTypes: {
          comments: true,
          likes: true,
          follows: true
        }
      },
      createdAt: now,
      updatedAt: now
    };

    const publicProfileData = {
      userId: uid,
      username,
      usernameLower: normalizedUsername,
      nombre: displayName,
      bio: profileData.bio,
      location: profileData.location,
      website: profileData.website,
      profilePictureUrl: profileData.profilePictureUrl,
      isVerified: false,
      stats: profileData.stats,
      updatedAt: now
    };

    await db.collection('users').doc(uid).set(profileData, { merge: true });
    await db.collection('users_public').doc(uid).set(publicProfileData, { merge: true });
    await db.collection('usernames').doc(normalizedUsername).set({
      uid,
      username,
      updatedAt: now
    }, { merge: true });

    console.log('✅ Usuario creado/actualizado correctamente:');
    console.log(`  email: ${email}`);
    console.log(`  username: ${username}`);
    console.log(`  uid: ${uid}`);
  } catch (error) {
    console.error('Error creando el usuario wp_2:', error);
    process.exit(1);
  }
}

createWp2User();
