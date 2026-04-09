const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = require(`../${process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH}`);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = admin.firestore();

async function upsertModuleConfig() {
  const modulesRef = db.collection('_config').doc('modules');

  await modulesRef.set(
    {
      news: {
        enabled: true
      },
      community: {
        enabled: true
      },
      surveys: {
        enabled: true
      },
      likes: {
        enabled: true,
        newsEnabled: true,
        communityEnabled: true
      },
      ads: {
        enabled: true,
        maxAdsPerFeed: 2,
        minPostsBetweenAds: 6,
        probability: 0.7,
        fetchLimit: 8,
        trackImpressions: true,
        trackClicks: true,
        tabs: ['todo'],
        impressionCooldownMs: 3600000,
        clickCooldownMs: 0
      }
    },
    { merge: true }
  );
}

async function ensureSampleAd() {
  const adsRef = db.collection('ads');
  const existing = await adsRef.limit(1).get();
  if (!existing.empty) {
    console.log('Ads collection already has data. Sample ad skipped.');
    return;
  }

  const sampleRef = adsRef.doc('sample_ads_welcome');
  await sampleRef.set({
    module: 'ads',
    active: true,
    priority: 8,
    title: 'Promociona tu proyecto en CdeluAR',
    description:
      'Este es un ejemplo de anuncio. Puedes editarlo o crear anuncios nuevos desde Firestore.',
    imageUrl: '',
    destinationUrl: 'https://cdeluar.com',
    ctaLabel: 'Conocer mas',
    stats: {
      impressionsTotal: 0,
      clicksTotal: 0,
      ctr: 0
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function run() {
  try {
    console.log('Setting up ADS module configuration...');
    await upsertModuleConfig();
    await ensureSampleAd();
    console.log('ADS module setup completed.');
    process.exit(0);
  } catch (error) {
    console.error('ADS module setup failed:', error);
    process.exit(1);
  }
}

run();
