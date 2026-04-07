const admin = require('firebase-admin');
const mysql = require('mysql2/promise');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: parseInt(process.env.MYSQL_PORT || '3306')
});

async function validateMigration() {
  console.log('Validating migration...');

  try {
    // Contar usuarios
    const firebaseUserCount = (await db.collection('users').count().get()).data().count;
    const [[{ count: mysqlUserCount }]] = await pool.execute('SELECT COUNT(*) as count FROM users');

    console.log(`Firebase users: ${firebaseUserCount}`);
    console.log(`MySQL users: ${mysqlUserCount}`);

    if (firebaseUserCount !== mysqlUserCount) {
      console.warn('⚠️ User counts differ!');
    } else {
      console.log('✅ User counts match.');
    }

    // Validar contenido (Feed vs Content)
    const firestoreContent = await db.collection('content').get();
    const [[{ count: mysqlContentCount }]] = await pool.execute('SELECT COUNT(*) as count FROM feed');

    console.log(`Firebase content: ${firestoreContent.size}`);
    console.log(`MySQL feed items: ${mysqlContentCount}`);

    if (firestoreContent.size !== mysqlContentCount) {
      console.warn('⚠️ Content counts differ!');
    } else {
      console.log('✅ Content counts match.');
    }

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('Validation failed:', error);
    process.exit(1);
  }
}

validateMigration();
