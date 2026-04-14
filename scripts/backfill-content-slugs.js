const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID
  });
}

const db = admin.firestore();
const MAX_SLUG_LENGTH = 96;

const normalizeContentSlug = (value) => {
  const raw = typeof value === 'string' ? value : '';
  const normalized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');

  const trimmed = normalized.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
  return trimmed || 'contenido';
};

const inferModule = (data) => {
  if (data?.module === 'news' || data?.type === 'news' || data?.isOficial === true) {
    return 'news';
  }
  return 'community';
};

const buildSlugBase = (data) => {
  const title = typeof data?.titulo === 'string' ? data.titulo.trim() : '';
  if (title) return normalizeContentSlug(title);
  return inferModule(data) === 'news' ? 'noticia' : 'publicacion';
};

const buildSlugKey = (moduleName, slug) => `${moduleName}__${slug}`;

async function assignSlug(contentRef, dryRun) {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(contentRef);
    if (!snapshot.exists) return { changed: false };

    const data = snapshot.data() || {};
    const moduleName = inferModule(data);
    const slugBase = buildSlugBase(data);
    const existingSlugRaw = typeof data.slug === 'string' ? data.slug.trim() : '';

    if (existingSlugRaw) {
      const slug = normalizeContentSlug(existingSlugRaw);
      const slugKey = buildSlugKey(moduleName, slug);
      const update = {};

      if (data.slug !== slug) update.slug = slug;
      if (data.slugBase !== slugBase) update.slugBase = slugBase;
      if (data.slugModule !== moduleName) update.slugModule = moduleName;

      if (!dryRun) {
        transaction.set(
          db.collection('_content_slugs').doc(slugKey),
          {
            contentId: snapshot.id,
            module: moduleName,
            slug,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        if (Object.keys(update).length > 0) {
          transaction.set(contentRef, update, { merge: true });
        }
      }

      return { changed: Object.keys(update).length > 0 };
    }

    let nextSlug = slugBase;
    let attempt = 2;

    while (true) {
      const slugKey = buildSlugKey(moduleName, nextSlug);
      const slugRef = db.collection('_content_slugs').doc(slugKey);
      const slugSnapshot = await transaction.get(slugRef);

      if (!slugSnapshot.exists) {
        if (!dryRun) {
          transaction.set(
            contentRef,
            {
              slug: nextSlug,
              slugBase,
              slugModule: moduleName
            },
            { merge: true }
          );
          transaction.set(
            slugRef,
            {
              contentId: snapshot.id,
              module: moduleName,
              slug: nextSlug,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            { merge: true }
          );
        }
        return { changed: true };
      }

      const mappedId = String(slugSnapshot.data()?.contentId || '').trim();
      if (mappedId === snapshot.id) {
        return { changed: false };
      }

      const suffix = `-${attempt}`;
      const allowedBaseLength = Math.max(1, MAX_SLUG_LENGTH - suffix.length);
      const shortenedBase = slugBase.slice(0, allowedBaseLength).replace(/-+$/g, '') || 'contenido';
      nextSlug = `${shortenedBase}${suffix}`;
      attempt += 1;
    }
  });
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const pageSize = 300;
  let lastDoc = null;
  let scanned = 0;
  let changed = 0;

  console.log(dryRun ? 'Backfill content slugs (dry-run)...' : 'Backfill content slugs...');

  while (true) {
    let q = db.collection('content').orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc.id);

    const snapshot = await q.get();
    if (snapshot.empty) break;

    for (const contentDoc of snapshot.docs) {
      scanned += 1;
      const result = await assignSlug(contentDoc.ref, dryRun);
      if (result.changed) changed += 1;
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
  }

  console.log(`Scanned: ${scanned}`);
  console.log(`Updated/assigned: ${changed}`);
  console.log(dryRun ? 'Dry run completed.' : 'Backfill completed.');
}

run().then(() => process.exit(0)).catch((error) => {
  console.error('Backfill content slugs failed:', error);
  process.exit(1);
});
