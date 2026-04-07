const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: parseInt(process.env.MYSQL_PORT || '3306')
});

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(128) PRIMARY KEY,
    nombre VARCHAR(255),
    email VARCHAR(255),
    username VARCHAR(100),
    rol VARCHAR(50) DEFAULT 'user',
    bio TEXT,
    location VARCHAR(255),
    website VARCHAR(255),
    profile_picture_url TEXT,
    is_verified BOOLEAN DEFAULT FALSE,
    created_at DATETIME,
    updated_at DATETIME
  )`,
  `CREATE TABLE IF NOT EXISTS feed (
    id VARCHAR(128) PRIMARY KEY,
    titulo VARCHAR(255),
    descripcion TEXT,
    image_url TEXT,
    type INT COMMENT '1=news, 2=post',
    original_id VARCHAR(128),
    user_id VARCHAR(128),
    likes_count INT DEFAULT 0,
    comments_count INT DEFAULT 0,
    created_at DATETIME,
    updated_at DATETIME,
    is_deleted BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS feed_likes (
    feed_id VARCHAR(128),
    user_id VARCHAR(128),
    created_at DATETIME,
    PRIMARY KEY (feed_id, user_id),
    FOREIGN KEY (feed_id) REFERENCES feed(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS sync_control (
    id INT PRIMARY KEY,
    lastSyncTime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    totalSyncs INT DEFAULT 0,
    lastError VARCHAR(500),
    lastErrorTime TIMESTAMP NULL,
    status ENUM('success', 'failed', 'running') DEFAULT 'success'
  )`
];

async function setupDatabase() {
  const connection = await pool.getConnection();
  console.log('Setting up database schema...');
  for (const query of schema) {
    try {
      await connection.query(query);
    } catch (e) {
      console.error('Error running:', query, e.message);
    }
  }
  
  // Seed sync_control
  await connection.query('INSERT IGNORE INTO sync_control (id, lastSyncTime) VALUES (1, NOW())');
  
  connection.release();
  console.log('Database schema ready.');
  process.exit(0);
}

setupDatabase().catch(err => {
  console.error(err);
  process.exit(1);
});
