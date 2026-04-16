const admin = require('firebase-admin');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function clearMySQL() {
    console.log('--- Limpiando posts en MySQL ---');
    const pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      port: parseInt(process.env.MYSQL_PORT || '3306')
    });
    
    // Tablas donde pueden estar almacenados los posts
    const possibleTables = ['content', 'feed', 'posts', 'news'];
    
    for (const table of possibleTables) {
        try {
            const [result] = await pool.query(`DELETE FROM ${table}`);
            console.log(`Borrados ${result.affectedRows} registros de la tabla MySQL '${table}'`);
        } catch (e) {
            // Ignorar el error si la tabla no existe
            if (e.code === 'ER_NO_SUCH_TABLE') {
                console.log(`Tabla MySQL '${table}' no existe, omitiendo.`);
            } else {
                console.error(`Error al borrar de la tabla ${table}:`, e.message);
            }
        }
    }
    
    await pool.end();
}

async function deleteCollection(db, collectionPath) {
    const collectionRef = db.collection(collectionPath);
    const snapshot = await collectionRef.get();
    
    if (snapshot.empty) {
        console.log(`No hay documentos en la colección ${collectionPath}.`);
        return;
    }
    
    const batchSize = 100;
    let batch = db.batch();
    let count = 0;
    let totalDeleted = 0;
    
    for (const doc of snapshot.docs) {
        batch.delete(doc.ref);
        count++;
        totalDeleted++;
        
        if (count >= batchSize) {
            await batch.commit();
            console.log(`Borrados ${totalDeleted} documentos de Firestore (${collectionPath})...`);
            batch = db.batch();
            count = 0;
        }
    }
    
    if (count > 0) {
        await batch.commit();
    }
    
    console.log(`Total: Borrados ${totalDeleted} documentos de la colección '${collectionPath}' de Firestore.`);
}

async function clearFirestore() {
    console.log('--- Limpiando posts en Firestore ---');
    let serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH || 'firebase-sa-key.json';
    if (!path.isAbsolute(serviceAccountPath)) {
        serviceAccountPath = path.join(__dirname, '..', serviceAccountPath);
    }
    const serviceAccount = require(serviceAccountPath);
    
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: process.env.FIREBASE_PROJECT_ID
        });
    }

    const db = admin.firestore();
    
    // Borrar la colección principal de posts
    await deleteCollection(db, 'content');
    
    // Borrar las colecciones de mapeo que se generan a partir de 'content'
    await deleteCollection(db, '_content_public_ids');
    await deleteCollection(db, '_content_slugs');
}

(async () => {
    try {
        await clearMySQL();
        await clearFirestore();
        console.log('>>> TODOS LOS POSTS HAN SIDO BORRADOS CORRECTAMENTE <<<');
        process.exit(0);
    } catch (e) {
        console.error('Error durante el borrado:', e);
        process.exit(1);
    }
})();
