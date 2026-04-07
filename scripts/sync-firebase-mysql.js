const admin = require('firebase-admin');
const mysql = require('mysql2/promise');
require('dotenv').config();

// Inicializar Firebase
const serviceAccount = require('../firebase-adminsdk.json'); // El usuario debe proveer este archivo
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Configuración MySQL
const dbConfig = {
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: process.env.MYSQL_PORT || 3306
};

async function syncToMySQL() {
  let connection;
  try {
    connection = await mysql.createConnection(dbConfig);
    console.log('Conectado a MySQL exitosamente.');

    // 1. Obtener última fecha de sincronización
    const syncDocRef = db.collection('_sync_control').doc('mysql_sync');
    const syncDoc = await syncDocRef.get();
    let lastSync = new Date(0); // Por defecto, extraer todo
    
    if (syncDoc.exists && syncDoc.data().lastSync) {
      lastSync = syncDoc.data().lastSync.toDate();
    }
    
    console.log(`Iniciando sincronización desde: ${lastSync.toISOString()}`);
    const newSyncTime = admin.firestore.Timestamp.now();

    // 2. Sincronizar Usuarios (Incremental)
    let usersSnapshot = await db.collection('users')
      .where('updatedAt', '>', admin.firestore.Timestamp.fromDate(lastSync))
      .orderBy('updatedAt', 'asc')
      .limit(100)
      .get();
      
    while (!usersSnapshot.empty) {
      console.log(`Sincronizando ${usersSnapshot.size} usuarios...`);
      for (const doc of usersSnapshot.docs) {
        const user = doc.data();
        const query = `
          INSERT INTO users (id, nombre, email, profilePictureUrl, rol, created_at, updated_at, is_deleted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            nombre = VALUES(nombre),
            profilePictureUrl = VALUES(profilePictureUrl),
            rol = VALUES(rol),
            updated_at = VALUES(updated_at),
            is_deleted = VALUES(is_deleted)
        `;
        const params = [
          doc.id,
          user.nombre || '',
          user.email || '',
          user.profilePictureUrl || null,
          user.rol || 'user',
          user.createdAt ? user.createdAt.toDate() : new Date(),
          user.updatedAt ? user.updatedAt.toDate() : new Date(),
          user.deletedAt ? 1 : 0
        ];
        await connection.execute(query, params);
      }
      
      const lastVisible = usersSnapshot.docs[usersSnapshot.docs.length - 1];
      usersSnapshot = await db.collection('users')
        .where('updatedAt', '>', admin.firestore.Timestamp.fromDate(lastSync))
        .orderBy('updatedAt', 'asc')
        .startAfter(lastVisible)
        .limit(100)
        .get();
    }

    // 3. Sincronizar Content (Incremental)
    let contentSnapshot = await db.collection('content')
      .where('updatedAt', '>', admin.firestore.Timestamp.fromDate(lastSync))
      .orderBy('updatedAt', 'asc')
      .limit(100)
      .get();
      
    while (!contentSnapshot.empty) {
      console.log(`Sincronizando ${contentSnapshot.size} posts...`);
      for (const doc of contentSnapshot.docs) {
        const content = doc.data();
        const query = `
          INSERT INTO content (id, user_id, titulo, descripcion, created_at, updated_at, is_deleted)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            titulo = VALUES(titulo),
            descripcion = VALUES(descripcion),
            updated_at = VALUES(updated_at),
            is_deleted = VALUES(is_deleted)
        `;
        const params = [
          doc.id,
          content.userId,
          content.titulo || '',
          content.descripcion || '',
          content.createdAt ? content.createdAt.toDate() : new Date(),
          content.updatedAt ? content.updatedAt.toDate() : new Date(),
          content.deletedAt ? 1 : 0
        ];
        await connection.execute(query, params);
      }
      
      const lastVisible = contentSnapshot.docs[contentSnapshot.docs.length - 1];
      contentSnapshot = await db.collection('content')
        .where('updatedAt', '>', admin.firestore.Timestamp.fromDate(lastSync))
        .orderBy('updatedAt', 'asc')
        .startAfter(lastVisible)
        .limit(100)
        .get();
    }
    
    // 4. Actualizar fecha de última sincronización
    await syncDocRef.set({
      lastSync: newSyncTime,
      status: 'success'
    }, { merge: true });
    
    console.log('Sincronización completada con éxito.');

  } catch (error) {
    console.error('Error durante la sincronización:', error);
    // Registrar error en Firestore
    try {
      const syncDocRef = db.collection('_sync_control').doc('mysql_sync');
      await syncDocRef.set({
        lastError: error.message,
        lastErrorTime: admin.firestore.FieldValue.serverTimestamp(),
        status: 'error'
      }, { merge: true });
    } catch (e) {
      console.error('Error registrando fallo en _sync_control:', e);
    }
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

// Ejecutar sincronización
syncToMySQL().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error("Fallo crítico:", error);
  process.exit(1);
});
