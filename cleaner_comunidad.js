/**
 * cleaner_comunidad.js  (v2 — FTP secuencial)
 *
 * Elimina TODOS los posts de la comunidad (/c en RTDB y module:'community' en Firestore)
 * y sus imágenes asociadas en FTP (bot.cdelu.io) y Firebase Storage.
 *
 * Uso:
 *   node cleaner_comunidad.js          → DRY RUN
 *   node cleaner_comunidad.js --delete  → BORRADO REAL
 */

const admin = require('firebase-admin');
const ftp = require('basic-ftp');
const path = require('path');

const DRY_RUN = !process.argv.includes('--delete');

require('dotenv').config();

const FTP_CONFIG = {
  host: process.env.FTP_HOST || '195.35.41.78',
  user: process.env.FTP_USER || 'u692901087',
  password: process.env.FTP_PASSWORD,
  port: 21,
  secure: false,
};

const BOT_URL_PREFIX  = 'https://bot.cdelu.io/images/';
const BOT_FTP_PREFIX  = '/}/bot.cdelu.io/public_html/images/';
const STORAGE_BUCKET  = 'cdeluar-ddefc.firebasestorage.app';

const serviceAccount = require(path.join(__dirname, 'firebase-sa-key.json'));
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://cdeluar-ddefc-default-rtdb.firebaseio.com',
    storageBucket: STORAGE_BUCKET,
  });
}
const db   = admin.firestore();
const rtdb = admin.database();

// ── helpers ────────────────────────────────────────────────────────────────

function urlToFtpPath(url) {
  if (url.startsWith(BOT_URL_PREFIX))
    return BOT_FTP_PREFIX + url.slice(BOT_URL_PREFIX.length);
  return null;
}

function urlToStoragePath(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'firebasestorage.googleapis.com') {
      const m = u.pathname.match(/\/v0\/b\/[^/]+\/o\/(.+)$/);
      if (m) return decodeURIComponent(m[1]);
    }
  } catch {}
  return null;
}

function extractUrls(post) {
  const urls = new Set();
  const add = v => { if (typeof v === 'string' && v.startsWith('http')) urls.add(v); };
  if (Array.isArray(post.images))   post.images.forEach(add);
  if (Array.isArray(post.imagesV2)) post.imagesV2.forEach(o => { add(o?.url); add(o?.thumbUrl); });
  return [...urls];
}

async function ftpDelete(client, ftpPath) {
  if (DRY_RUN) { console.log(`  [DRY] FTP: ${ftpPath}`); return; }
  try {
    await client.remove(ftpPath);
    console.log(`  ✓ FTP: ${ftpPath}`);
  } catch (e) {
    const msg = e.code === 550 ? '⚠ no encontrado' : `✗ error (${e.code})`;
    console.log(`  ${msg}: ${ftpPath}`);
  }
}

async function storageDelete(storagePath) {
  if (DRY_RUN) { console.log(`  [DRY] Storage: ${storagePath}`); return; }
  try {
    await admin.storage().bucket().file(storagePath).delete();
    console.log(`  ✓ Storage: ${storagePath}`);
  } catch (e) {
    console.log(`  ${e.code === 404 ? '⚠' : '✗'} Storage: ${storagePath} — ${e.message}`);
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function run() {
  console.log('═══════════════════════════════════════════════');
  console.log(DRY_RUN ? '  MODO DRY RUN — No se borrará nada' : '  MODO BORRADO REAL ⚠️');
  console.log('═══════════════════════════════════════════════\n');

  // 1. Fetch data
  console.log('🔄 RTDB /c ...');
  const rtdbSnap = await rtdb.ref('/c').once('value');
  const rtdbVal  = rtdbSnap.val() || {};
  const rtdbIds  = Object.keys(rtdbVal);
  console.log(`   → ${rtdbIds.length} posts\n`);

  console.log('🔄 Firestore content(module:community) ...');
  const fsSnap = await db.collection('content').where('module', '==', 'community').get();
  console.log(`   → ${fsSnap.size} posts\n`);

  // 2. Build unified map
  const postMap = new Map();
  const ensure  = id => { if (!postMap.has(id)) postMap.set(id, { urls: new Set(), inRtdb: false, inFs: false }); };

  rtdbIds.forEach(id => {
    ensure(id);
    postMap.get(id).inRtdb = true;
    extractUrls(rtdbVal[id]).forEach(u => postMap.get(id).urls.add(u));
  });
  fsSnap.forEach(doc => {
    ensure(doc.id);
    postMap.get(doc.id).inFs = true;
    extractUrls(doc.data()).forEach(u => postMap.get(doc.id).urls.add(u));
  });

  const allIds = [...postMap.keys()];
  let ftpCount = 0, storageCount = 0, otherCount = 0;
  for (const d of postMap.values())
    for (const u of d.urls) {
      if (urlToFtpPath(u)) ftpCount++;
      else if (urlToStoragePath(u)) storageCount++;
      else otherCount++;
    }

  console.log(`📊 Posts únicos   : ${allIds.length}`);
  console.log(`📷 FTP images     : ${ftpCount}`);
  console.log(`📷 Storage images : ${storageCount}`);
  console.log(`📷 Otras (skip)   : ${otherCount}\n`);

  if (DRY_RUN) {
    console.log('DRY RUN completado. Para borrar ejecutá:');
    console.log('  node cleaner_comunidad.js --delete');
    process.exit(0);
  }

  // 3. Connect FTP (single persistent connection, sequential operations)
  const ftpClient = new ftp.Client(120000);
  ftpClient.ftp.verbose = false;
  await ftpClient.access(FTP_CONFIG);
  console.log('✓ FTP conectado\n');

  let deletedPosts = 0, deletedImages = 0, errors = 0;

  for (let i = 0; i < allIds.length; i++) {
    const postId = allIds[i];
    const data   = postMap.get(postId);

    if ((i + 1) % 50 === 1)
      console.log(`\n── Progreso: ${i + 1} / ${allIds.length} posts ──`);

    // 3a. FTP images — SEQUENTIAL (one connection, no parallelism)
    for (const url of data.urls) {
      const ftpPath     = urlToFtpPath(url);
      const storagePath = urlToStoragePath(url);
      if (ftpPath)          await ftpDelete(ftpClient, ftpPath);
      else if (storagePath) await storageDelete(storagePath);
      else                  console.log(`  ⚠ skip: ${url}`);
      deletedImages++;
    }

    // 3b. Firestore + RTDB in parallel (no FTP here)
    const fsTask   = data.inFs
      ? db.collection('content').doc(postId).delete()
          .then(() => console.log(`  ✓ Firestore: content/${postId}`))
          .catch(e  => { console.log(`  ✗ Firestore: ${postId} — ${e.message}`); errors++; })
      : Promise.resolve();

    const rtdbTask = data.inRtdb
      ? rtdb.ref(`/c/${postId}`).remove()
          .then(() => console.log(`  ✓ RTDB: /c/${postId}`))
          .catch(e  => { console.log(`  ✗ RTDB: ${postId} — ${e.message}`); errors++; })
      : Promise.resolve();

    await Promise.all([fsTask, rtdbTask]);
    deletedPosts++;
  }

  ftpClient.close();

  console.log('\n═══════════════════════════════════════════════');
  console.log('✅ LIMPIEZA COMPLETADA');
  console.log(`   Posts borrados  : ${deletedPosts}`);
  console.log(`   Imágenes proc.  : ${deletedImages}`);
  console.log(`   Errores         : ${errors}`);
  console.log('═══════════════════════════════════════════════');
  process.exit(0);
}

run().catch(err => { console.error('Error fatal:', err); process.exit(1); });
