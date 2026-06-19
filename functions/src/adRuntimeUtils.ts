import * as admin from 'firebase-admin';

export const handleAdEventCreatedInternal = async (
  db: FirebaseFirestore.Firestore,
  snap: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>
): Promise<void> => {
  const eventData = snap.data();
  if (!eventData) return;

  const adId = eventData.adId as string | undefined;
  const eventType = eventData.eventType as 'impression' | 'click' | undefined;
  const countRaw = Number(eventData.count ?? 1);
  const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(Math.floor(countRaw), 20)) : 1;

  if (!adId || (eventType !== 'impression' && eventType !== 'click')) {
    console.log('Ignoring invalid ad event payload', { adId, eventType });
    return;
  }

  const adRef = db.collection('ads').doc(adId);

  try {
    await db.runTransaction(async (tx) => {
      const adSnap = await tx.get(adRef);
      if (!adSnap.exists) {
        console.log(`Ad ${adId} does not exist. Event ignored.`);
        return;
      }

      const adData = adSnap.data() || {};
      const stats = adData.stats || {};
      const currentImpressions = Number(stats.impressionsTotal || 0);
      const currentClicks = Number(stats.clicksTotal || 0);

      const impressionIncrement = eventType === 'impression' ? count : 0;
      const clickIncrement = eventType === 'click' ? count : 0;

      const nextImpressions = currentImpressions + impressionIncrement;
      const nextClicks = currentClicks + clickIncrement;
      const ctr = nextImpressions > 0
        ? Number(((nextClicks / nextImpressions) * 100).toFixed(2))
        : 0;

      tx.set(
        adRef,
        {
          stats: {
            impressionsTotal: admin.firestore.FieldValue.increment(impressionIncrement),
            clicksTotal: admin.firestore.FieldValue.increment(clickIncrement),
            ctr,
            lastEventAt: admin.firestore.FieldValue.serverTimestamp()
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });
  } catch (error) {
    console.error(`Failed to aggregate ad event for ad ${adId}`, error);
  }
};
