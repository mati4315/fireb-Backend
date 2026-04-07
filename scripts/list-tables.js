const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: parseInt(process.env.MYSQL_PORT || '3306')
});

async function listTables() {
  const connection = await pool.getConnection();
  const [rows] = await connection.query('SHOW TABLES');
  connection.release();
  console.log('Tables in database:', rows);
  process.exit(0);
}

listTables().catch(err => {
  console.error(err);
  process.exit(1);
});
