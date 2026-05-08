# Guía de Sincronización con Firebase para la Comunidad (Node.js)

Esta guía explica cómo enviar publicaciones recopiladas desde tu scraper de Node.js en Hostinger hacia la sección de "Comunidad" en Firebase, adaptada a los campos que ya estás recolectando.

## Credenciales y Destino
A diferencia de usar llamadas REST simples que lanzan el error "401 Permission Denied", la mejor práctica para un entorno como Hostinger (Backend en Node.js) es utilizar el **Service Account / SDK de `firebase-admin`**. Esto asegura autenticación privilegiada de alto nivel y cero rechazos.

- **Archivo Necesario:** Tu scraper necesita el archivo `firebase-sa-key.json` de tu proyecto. 

---

## 1. Estructura Exacta del JSON (Payload)

La estructura recomendada que tu script debe armar es la siguiente para la integración final:

```json
{
  "id_unico": "fb_123456789",
  "type": "comunidad",
  "author_name": "Nombre del Grupo o Autor",
  "author_id": "id_usuario_o_grupo",
  "group_name": "Nombre de la comunidad o grupo",
  "group_url": "https://facebook.com/groups/...",
  "content": "Contenido extraido de la publicación...",
  "images": [
    "https://url-imagen-1.jpg"
  ],
  "video_links": [
    "https://url-video.mp4"
  ],
  "tags": ["etiqueta1", "etiqueta2"],
  "post_url": "https://facebook.com/groups/...",
  "createdAt": "2026-05-08T12:00:15Z", 
  "updatedAt": "2026-05-08 12:00:15",
  "deletedAt": null,
  "stats": {
    "likesCount": 0,
    "commentsCount": 0,
    "viewsCount": 0
  }
}
```

---

## 2. Ejemplo Funcional de Script en Node.js

Para este ejemplo asumo que tienes instalada la librería `firebase-admin` en tu proyecto de scraping en Node. De no ser así, ejecuta `npm install firebase-admin` en el entorno Hostinger.

```javascript
/**
 * Script para enviar publicaciones recolectadas a la Comunidad vía Auth de Admin 
 */

const admin = require('firebase-admin');

// 1. Configuración de Credenciales usando la clave (coloca el path correcto del json en Hostinger)
const serviceAccount = require('./firebase-sa-key.json'); 

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://cdeluar-ddefc-default-rtdb.firebaseio.com"
    });
}
const db = admin.database();

// 2. Función responsable de adaptar y enviar los datos
async function syncToCommunity(postData) {
    // Usamos el campo 'id_unico' para evitar registros duplicados
    const uniqueId = postData.id_unico;

    if (!uniqueId) {
        console.error("Error: Falta el campo 'id_unico' en los datos extraídos.");
        return;
    }

    // 2.1 Armar los datos según estructura
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
        // Metadatos de control 
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
        console.log(`Enviando a Comunidad por Realtime Database Auth: /c/${uniqueId}`);

        // Utilizamos "set" para ser idempotentes (sobrescribir o crear si no existe)
        const ref = db.ref(`/c/${uniqueId}`);
        await ref.set(payload);

        console.log("¡Publicación insertada en la Realtime Database EXITOSAMENTE para que corran los triggers!");
        
    } catch (error) {
        console.error("Error al sincronizar en Firebase:", error.message);
    }
}

// 3. Ejemplo de prueba de simulación
const publicacionExtraida = {
    id_unico: "fb_87654321", // Identificador de ejemplo
    author_name: "Juan Perez",
    author_id: "10000012345",
    group_name: "Clasificados CdelU",
    group_url: "https://facebook.com/groups/clasificados_cdelu",
    content: "Vendo excelente bicicleta!...",
    images: ["https://images.unsplash.com/photo-14859651201..."],
    video_links: [],
    tags: ["ventas", "bicicleta"],
    post_url: "https://facebook.com/groups/clasificados_cdelu/posts/87654321"
};

syncToCommunity(publicacionExtraida);
```

---

## 3. Puntos Clave para tu Sistema General

1. **Ruta a la Comunidad (`/c`)**: En lugar de apuntar a `/news` en la request, tu script Node apuntará los datos al ref `/c/${uniqueId}` validado con sus credenciales maestras.
2. **Método `set()` para ser Idempotentes**: Al utilizar la función `ref.set()`, tu scraper se hace seguro frente a duplicidades. Si el crontab levanta el mismo post de Facebook varias veces y lo manda, solo actualizará la metadata pero no creará una publicación repetida gracias a ese ID fuerte.
3. **Arrays Válidos**: Manda listas nativas para compatibilidad al Frontend. Firebase las respeta.
4. **Activación Segura en Production**: La integración ya está activa gracias al *trigger* `onCommunityPostsReceived` de Cloud Functions. Cada vez que llames a este servicio como en la guía, Firestore recibirá la réplica limpia y tu frontend renderizará todo bajo la pestaña de "Comunidad".
