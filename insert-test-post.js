const admin = require('firebase-admin');
const path = require('path');

process.env.FIREBASE_DATABASE_EMULATOR_HOST = ""; // Ensure not hitting emulator

const serviceAccount = require('./firebase-sa-key.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://cdeluar-ddefc-default-rtdb.firebaseio.com"
    });
}

const db = admin.database();

async function uploadTestPost() {
    console.log("Iniciando subida de prueba a Realtime Database...");
    
    // Objeto extraído
    const postData = {
        id_unico: "fb_87654321",
        author_name: "Juan Perez",
        author_id: "10000012345",
        group_name: "Clasificados CdelU",
        group_url: "https://facebook.com/groups/clasificados_cdelu",
        content: "Vendo excelente bicicleta! Contacto por DM.",
        images: ["https://images.unsplash.com/photo-1485965120184-e220f721d03e"], 
        video_links: [],
        tags: ["ventas", "bicicleta"],
        post_url: "https://facebook.com/groups/clasificados_cdelu/posts/87654321"
    };

    const uniqueId = postData.id_unico;

    const payload = {
        id_unico: uniqueId,
        type: "comunidad",
        author_name: postData.author_name || "Desconocido",
        author_id: postData.author_id || "",
        group_name: postData.group_name || "",
        group_url: postData.group_url || "",
        content: postData.content || "",
        images: Array.isArray(postData.images) ? postData.images : [],
        video_links: Array.isArray(postData.video_links) ? postData.video_links : [],
        tags: Array.isArray(postData.tags) ? postData.tags : [],
        post_url: postData.post_url || "",
        createdAt: new Date().toISOString(), 
        updatedAt: new Date().toISOString().replace('T', ' ').substring(0, 19), 
        deletedAt: null,
        stats: {
            likesCount: 0,
            commentsCount: 0,
            viewsCount: 0
        }
    };

    try {
        const ref = db.ref(`/c/${uniqueId}`);
        await ref.set(payload);
        console.log("✓ Payload enviado a Realtime Database en /c/" + uniqueId);
        console.log("El Triger onCommunityPostsReceived de Cloud Functions debería dispararse pronto.");
        process.exit(0);
    } catch (e) {
        console.error("Error subiendo el payload:", e);
        process.exit(1);
    }
}

uploadTestPost();
