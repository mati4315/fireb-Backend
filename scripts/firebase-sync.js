
const admin = require('firebase-admin');
const mysql = require('mysql2/promise');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();

// ==========================================
// DATABASE CONNECTION
// ==========================================

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: parseInt(process.env.MYSQL_PORT || '3306'),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ==========================================
// SYNC LOGIC
// ==========================================

class FirebaseSync {
  constructor() {
    this.lastSync = null;
    this.syncLog = [];
  }

  // Registrar evento en log
  log(level, message, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data
    };
    this.syncLog.push(entry);
    console.log(`[${level}] ${message}`, data);
  }

  // Obtener timestamp de última sincronización exitosa
  async getLastSyncTimestamp() {
    try {
      const connection = await pool.getConnection();
      const [rows] = await connection.query(
        'SELECT lastSyncTime FROM sync_control WHERE id = 1'
      );
      connection.release();

      if (rows.length > 0) {
        return new Date(rows[0].lastSyncTime);
      }
      return null;
    } catch (error) {
      this.log('WARN', 'Could not get last sync time, will sync all', { error: error.message });
      return null;
    }
  }

  // Actualizar timestamp de última sincronización
  async updateLastSyncTimestamp(timestamp) {
    try {
      const connection = await pool.getConnection();
      await connection.query(
        'INSERT INTO sync_control (id, lastSyncTime) VALUES (1, ?) ON DUPLICATE KEY UPDATE lastSyncTime = ?',
        [timestamp, timestamp]
      );
      connection.release();
      this.log('INFO', 'Last sync timestamp updated');
    } catch (error) {
      this.log('ERROR', 'Failed to update sync timestamp', { error: error.message });
      throw error;
    }
  }

  // 1. SINCRONIZAR USUARIOS
  async syncUsers() {
    this.log('INFO', 'Starting user sync');

    const lastSync = await this.getLastSyncTimestamp();
    let query = db.collection('users');

    // Filtro incremental (solo modificados desde último sync)
    if (lastSync) {
      query = query.where('updatedAt', '>=', lastSync);
    }

    try {
      const snapshot = await query.get();
      const usersToSync = [];

      snapshot.forEach((doc) => {
        // Transformar Firebase doc a estructura SQL
        const userData = {
          id: doc.id,
          nombre: doc.data().nombre || '',
          email: doc.data().email || '',
          username: doc.data().username || '',
          rol: doc.data().rol || 'user',
          bio: doc.data().bio || '',
          location: doc.data().location || '',
          website: doc.data().website || '',
          profile_picture_url: doc.data().profilePictureUrl || '',
          is_verified: doc.data().isVerified ? 1 : 0,
          created_at: this.formatTimestamp(doc.data().createdAt),
          updated_at: this.formatTimestamp(doc.data().updatedAt)
        };
        usersToSync.push(userData);
      });

      // UPSERT a MySQL
      if (usersToSync.length > 0) {
        await this.upsertUsersToMySQL(usersToSync);
        this.log('INFO', `Synced ${usersToSync.length} users`);
      } else {
        this.log('INFO', 'No users to sync');
      }
    } catch (error) {
      this.log('ERROR', 'User sync failed', { error: error.message });
      throw error;
    }
  }

  async upsertUsersToMySQL(users) {
    const connection = await pool.getConnection();

    try {
      for (const user of users) {
        await connection.query(`
          INSERT INTO users (
            id, nombre, email, username, rol, bio, location, website,
            profile_picture_url, is_verified, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            nombre = ?, email = ?, username = ?, rol = ?, bio = ?,
            location = ?, website = ?, profile_picture_url = ?,
            is_verified = ?, updated_at = ?
        `, [
          // INSERT values
          user.id, user.nombre, user.email, user.username, user.rol,
          user.bio, user.location, user.website, user.profile_picture_url,
          user.is_verified, user.created_at, user.updated_at,
          // UPDATE values
          user.nombre, user.email, user.username, user.rol, user.bio,
          user.location, user.website, user.profile_picture_url,
          user.is_verified, user.updated_at
        ]);
      }

      connection.release();
      this.log('INFO', 'Users upserted to MySQL');
    } catch (error) {
      connection.release();
      throw error;
    }
  }

  // 2. SINCRONIZAR CONTENT (news + posts)
  async syncContent() {
    this.log('INFO', 'Starting content sync');

    const lastSync = await this.getLastSyncTimestamp();
    let query = db.collection('content');

    if (lastSync) {
      query = query.where('updatedAt', '>=', lastSync);
    }

    try {
      const snapshot = await query.get();
      const contentToSync = [];

      snapshot.forEach((doc) => {
        const contentData = doc.data();
        const syncItem = {
          id: doc.id,
          titulo: contentData.titulo || '',
          descripcion: contentData.descripcion || '',
          image_url: contentData.images?.[0] || '',
          type: contentData.type === 'news' ? 1 : 2,
          original_id: doc.id,
          user_id: contentData.userId || null,
          likes_count: contentData.stats?.likesCount || 0,
          comments_count: contentData.stats?.commentsCount || 0,
          created_at: this.formatTimestamp(contentData.createdAt),
          updated_at: this.formatTimestamp(contentData.updatedAt),
          is_deleted: contentData.deletedAt ? 1 : 0
        };
        contentToSync.push(syncItem);
      });

      if (contentToSync.length > 0) {
        await this.upsertContentToMySQL(contentToSync);
        this.log('INFO', `Synced ${contentToSync.length} content items`);
      } else {
        this.log('INFO', 'No content to sync');
      }
    } catch (error) {
      this.log('ERROR', 'Content sync failed', { error: error.message });
      throw error;
    }
  }

  async upsertContentToMySQL(contentItems) {
    const connection = await pool.getConnection();

    try {
      for (const item of contentItems) {
        await connection.query(`
          INSERT INTO feed (
            id, titulo, descripcion, image_url, type, original_id,
            user_id, likes_count, comments_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            titulo = ?, descripcion = ?, image_url = ?, type = ?,
            likes_count = ?, comments_count = ?, updated_at = ?
        `, [
          // INSERT
          item.id, item.titulo, item.descripcion, item.image_url,
          item.type, item.original_id, item.user_id, item.likes_count,
          item.comments_count, item.created_at, item.updated_at,
          // UPDATE
          item.titulo, item.descripcion, item.image_url, item.type,
          item.likes_count, item.comments_count, item.updated_at
        ]);
      }

      connection.release();
      this.log('INFO', 'Content upserted to MySQL');
    } catch (error) {
      connection.release();
      throw error;
    }
  }

  // 3. SINCRONIZAR LIKES
  async syncLikes() {
    this.log('INFO', 'Starting likes sync');

    try {
      const connection = await pool.getConnection();

      // Limpiar likes anteriores (para sincronización completa)
      // Ojo: En producción podrías querer algo incremental
      await connection.query('TRUNCATE TABLE feed_likes');

      // Obtener todos los likes desde Firestore
      const contentSnapshot = await db.collection('content').get();

      for (const contentDoc of contentSnapshot.docs) {
        const likesSnapshot = await contentDoc.ref
          .collection('likes')
          .get();

        for (const likeDoc of likesSnapshot.docs) {
          const likeData = likeDoc.data();
          await connection.query(`
            INSERT INTO feed_likes (feed_id, user_id, created_at)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE created_at = ?
          `, [
            contentDoc.id,
            likeDoc.id,
            this.formatTimestamp(likeData.createdAt),
            this.formatTimestamp(likeData.createdAt)
          ]);
        }
      }

      connection.release();
      this.log('INFO', 'Likes synced');
    } catch (error) {
      this.log('ERROR', 'Likes sync failed', { error: error.message });
      throw error;
    }
  }

  // Helper: Convertir Firestore timestamp a MySQL datetime
  formatTimestamp(firebaseTimestamp) {
    if (!firebaseTimestamp) return new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    try {
      const date = firebaseTimestamp.toDate ? firebaseTimestamp.toDate() : new Date(firebaseTimestamp);
      return date.toISOString().slice(0, 19).replace('T', ' ');
    } catch {
      return new Date().toISOString().slice(0, 19).replace('T', ' ');
    }
  }

  // Ejecutar sincronización completa
  async sync() {
    const startTime = Date.now();
    this.log('INFO', '========== FIREBASE → MYSQL SYNC STARTED ==========');

    try {
      await this.syncUsers();
      await this.syncContent();
      await this.syncLikes();

      // Actualizar timestamp de última sincronización exitosa
      await this.updateLastSyncTimestamp(new Date());

      const duration = Date.now() - startTime;
      this.log('INFO', '========== SYNC COMPLETED SUCCESSFULLY ==========', {
        duration: `${duration}ms`,
        logEntries: this.syncLog.length
      });

      return { success: true, duration, logs: this.syncLog };
    } catch (error) {
      this.log('ERROR', 'SYNC FAILED', { error: error.message, stack: error.stack });
      throw error;
    }
  }
}

// ==========================================
// MAIN EXECUTION
// ==========================================

(async () => {
  const syncer = new FirebaseSync();

  try {
    await syncer.sync();
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
})();
