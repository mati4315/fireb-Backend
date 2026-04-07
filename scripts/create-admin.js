const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();

async function createAdmin() {
  const email = 'admin@cdelu.ar';
  const password = 'adminpassword123';
  const username = 'admin';

  try {
    console.log(`Checking if user ${email} already exists...`);
    let userRecord;
    try {
      userRecord = await admin.auth().getUserByEmail(email);
      console.log('User already exists in Auth. Updating password and claim...');
      userRecord = await admin.auth().updateUser(userRecord.uid, { password });
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        console.log('Creating new user in Auth...');
        userRecord = await admin.auth().createUser({
          email,
          password,
          displayName: 'Admin Master',
        });
      } else {
        throw e;
      }
    }

    console.log(`Setting custom claim for ${email}...`);
    await admin.auth().setCustomUserClaims(userRecord.uid, { admin: true });

    console.log(`Creating/Updating profile in Firestore for ${username}...`);
    const usersRef = db.collection('users');
    await usersRef.doc(userRecord.uid).set({
      username: username,
      email: email,
      rol: 'admin',
      nombre: 'Adminsitrador General',
      fecha_registro: admin.firestore.FieldValue.serverTimestamp(),
      avatar_url: '',
      descripcion: 'Super Admin',
      es_publico: true
    }, { merge: true });

    console.log(`\n✅ USER CREATED/UPDATED:`);
    console.log(`Correo: ${email}`);
    console.log(`Contraseña: ${password}`);
    console.log(`Usuario: ${username}`);
    process.exit(0);
  } catch (error) {
    console.error('Error creating admin user:', error);
    process.exit(1);
  }
}

createAdmin();
