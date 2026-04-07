const mysql = require('mysql2/promise');
const fs = require('fs');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  port: parseInt(process.env.MYSQL_PORT || '3306')
});

async function exportTable(tableName) {
  const connection = await pool.getConnection();
  console.log(`Exporting ${tableName}...`);
  const [rows] = await connection.query(`SELECT * FROM ${tableName}`);
  connection.release();

  if (!fs.existsSync('./exports')) {
    fs.mkdirSync('./exports');
  }

  fs.writeFileSync(
    `./exports/${tableName}.json`,
    JSON.stringify(rows, null, 2)
  );

  console.log(`Exported ${tableName}: ${rows.length} records`);
}

(async () => {
  try {
    const tables = ['users', 'news', 'posts', 'feed', 'user_follows', 'feed_likes', 'feed_comments'];
    for (const table of tables) {
      await exportTable(table);
    }
    console.log('All tables exported successfully.');
    process.exit(0);
  } catch (error) {
    console.error('Export failed:', error);
    process.exit(1);
  }
})();
