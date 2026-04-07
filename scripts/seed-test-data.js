const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();

async function seedTestData() {
  console.log('Seeding test data in Firebase...');

  try {
    const testUserId = 'test-user-001';
    const testContentId = 'test-post-001';

    // 1. Crear usuario
    const userRef = db.collection('users').doc(testUserId);
    await userRef.set({
      nombre: 'Matias Admin',
      email: 'matias@test.com',
      username: 'mati_admin',
      rol: 'admin',
      bio: 'Soy el administrador del backend.',
      location: 'Argentina',
      website: 'https://cdelu.ar',
      profilePictureUrl: 'https://via.placeholder.com/150',
      isVerified: true,
      stats: {
        postsCount: 0,
        followersCount: 0,
        followingCount: 0
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('✅ Test User created.');

    // 2. Crear contenido (Post)
    const contentRef = db.collection('content').doc(testContentId);
    await contentRef.set({
      userId: testUserId,
      titulo: '¡Primer Post en el Nuevo Backend!',
      descripcion: 'Esta publicación fue generada automáticamente para probar la sincronización con Hostinger.',
      type: 'post',
      images: ['https://via.placeholder.com/600x400'],
      stats: {
        likesCount: 0,
        commentsCount: 0
      },
      deletedAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('✅ Test Post created.');
    console.log('🚀 ¡Ahora espera 3 segundos para que los triggers actúen!');

    await new Promise(resolve => setTimeout(resolve, 3000));

    // 3. Verificar triggers (Opcional, manual)
    const updatedUser = await userRef.get();
    console.log(`📊 Stats del usuario: postsCount = ${updatedUser.data().stats.postsCount}`);

    console.log('---');
    console.log('Dato de prueba listo. Ahora corre: npm run sync:firebase-to-mysql');
    
    process.exit(0);
  } catch (error) {
    console.error('Error seeding data:', error);
    process.exit(1);
  }
}

seedTestData();
