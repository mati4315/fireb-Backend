// Script para enviar publicaciones recolectadas a la Comunidad en Firebase

// 1. Configuración de Credenciales
const FIREBASE_URL = "https://cdeluar-ddefc-default-rtdb.firebaseio.com";
const FIREBASE_SECRET_KEY = "AIzaSyA6KhQumaAS0hMnrc3exj57Zq-91eY4oEo";

// 2. Función responsable de adaptar y enviar los datos
async function syncToCommunity(postData) {
    const uniqueId = postData.id_unico;

    if (!uniqueId) {
        console.error("Error: Falta el campo 'id_unico' en los datos extraídos.");
        return;
    }

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
        const endpoint = `${FIREBASE_URL}/c/${uniqueId}.json?auth=${FIREBASE_SECRET_KEY}`;

        console.log(`Enviando a Comunidad: /c/${uniqueId}`);

        const response = await fetch(endpoint, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Error de Firebase: [${response.status}] ${errorText}`);
        }

        const result = await response.json();
        console.log("¡Publicación insertada en la comunidad EXITOSAMENTE!");
        
    } catch (error) {
        console.error("Error al sincronizar en Firebase:", error.message);
    }
}

// 3. Ejemplo de prueba actualizado:
const publicacionExtraida = {
    id_unico: "fb_87654321",
    author_name: "Juan Perez",
    author_id: "10000012345",
    group_name: "Clasificados CdelU",
    group_url: "https://facebook.com/groups/clasificados_cdelu",
    content: "Vendo excelente bicicleta! Contacto por DM.",
    images: ["https://images.unsplash.com/photo-1485965120184-e220f721d03e"], // valid image url for test
    video_links: [],
    tags: ["ventas", "bicicleta"],
    post_url: "https://facebook.com/groups/clasificados_cdelu/posts/87654321"
};

syncToCommunity(publicacionExtraida);
