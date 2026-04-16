const admin = require('firebase-admin');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const baseBackupDir = path.join(__dirname, '..', 'copia-de-seguridad-db');
const mysqlBackupDir = path.join(baseBackupDir, 'mysql');
const firestoreBackupDir = path.join(baseBackupDir, 'firestore');

if (!fs.existsSync(baseBackupDir)) fs.mkdirSync(baseBackupDir, { recursive: true });
if (!fs.existsSync(mysqlBackupDir)) fs.mkdirSync(mysqlBackupDir, { recursive: true });
if (!fs.existsSync(firestoreBackupDir)) fs.mkdirSync(firestoreBackupDir, { recursive: true });

async function backupMySQL() {
    console.log('--- Iniciando Backup de MySQL ---');
    const pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      port: parseInt(process.env.MYSQL_PORT || '3306')
    });
    const connection = await pool.getConnection();

    const [tables] = await connection.query('SHOW TABLES');
    const tableNames = tables.map(t => Object.values(t)[0]);

    for (const tableName of tableNames) {
        console.log(`Exportando tabla MySQL: ${tableName}...`);
        const [rows] = await connection.query(`SELECT * FROM ${tableName}`);
        fs.writeFileSync(
            path.join(mysqlBackupDir, `${tableName}.json`),
            JSON.stringify(rows, null, 2)
        );
        console.log(`Guardados ${rows.length} registros de ${tableName}`);
    }
    
    connection.release();
    pool.end();
    console.log('--- Backup de MySQL completado ---');
}

async function backupFirestore() {
    console.log('--- Iniciando Backup de Firestore ---');
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
    const collections = await db.listCollections();

    for (const collection of collections) {
        console.log(`Exportando colección Firestore: ${collection.id}...`);
        const snapshot = await collection.get();
        const data = {};
        
        snapshot.forEach(doc => {
            data[doc.id] = doc.data();
        });

        fs.writeFileSync(
            path.join(firestoreBackupDir, `${collection.id}.json`),
            JSON.stringify(data, null, 2)
        );
        console.log(`Guardados ${snapshot.size} documentos de la colección ${collection.id}`);
    }

    console.log('--- Backup de Firestore completado ---');
}

(async () => {
    try {
        await backupMySQL();
        await backupFirestore();
        console.log('>>> TODO EL BACKUP COMPLETADO CORRECTAMENTE <<<');
        process.exit(0);
    } catch (e) {
        console.error('Error durante el backup:', e);
        process.exit(1);
    }
})();
