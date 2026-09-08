# Inventario API pública CDELU - Fase 0

Fecha del inventario: 2026-09-08  
Especificación consultada: `Api_Publica.md` v2.1  
Alcance: inventario únicamente. No se implementaron endpoints públicos, MCP ni cambios de reglas.

## 1. Estado confirmado

| Área | Evidencia actual | Estado |
|---|---|---|
| Proyecto Firebase | `cdeluar-ddefc`, obtenido desde la configuración local usada para la lectura administrativa | existente y verificado |
| Firestore | Base principal usada por Backend y Frontend | existente |
| Cloud Functions | `D:\FIREBASE\Backend\functions`, TypeScript, Node 22 declarado | existente |
| Región declarada | `us-central1` en `firebase.json` para Firestore; no se encontró una región HTTP pública específica | parcialmente confirmado |
| Frontend | Vue 3, TypeScript, Vite, Pinia, Firebase Web SDK y Capacitor | existente |
| API HTTP pública | No se encontró ninguna función `onRequest` ni ruta `/api/v1` | no implementada |
| MCP privado | No se encontró endpoint `/private/mcp` ni autenticación MCP | no implementado |
| PostgreSQL/Redis/embeddings | No forman parte de la implementación actual | fuera de alcance |

La lectura de Firestore fue de solo lectura y resumió nombres y tipos de campos; no se incluyeron valores de usuarios, textos, correos, tokens ni secretos en este informe.

## 2. Colecciones Firestore reales

### Colecciones top-level observadas

```text
_config
_content_public_ids
_content_slugs
_counters
_sync_control
ad_events
content
lotteries
lottery_user_ticket_extras
relationships
secret_fingerprints
secret_rate_limits
survey_votes
surveys
usernames
users
users_public
```

### Subcolecciones observadas en reglas, código y collection groups

| Ruta o grupo | Uso | Clasificación inicial |
|---|---|---|
| `content/{id}/likes` | likes por usuario | privada/no API pública |
| `content/{id}/comments` | comentarios | privada/no API pública |
| `content/{id}/comments/{id}/replies` | respuestas | privada/no API pública |
| `content/{id}/secret_comments` | comentarios anónimos de secretos | muy sensible/no API pública |
| `content/{id}/secret_votes` | votos anónimos | muy sensible/no API pública |
| `content/{id}/secret_reports` | denuncias de secretos | muy sensible/no API pública |
| `users/{id}/notifications` | notificaciones personales | privada/no API pública |
| `users/{id}/notification_devices` | tokens y dispositivos | muy sensible/no API pública |
| `lotteries/{id}/entries` | participantes y números | privada/no API pública |
| `relationships/{id}/followers` | seguidores | requiere revisión de privacidad |
| `relationships/{id}/following` | seguidos | requiere revisión de privacidad |

## 3. Modelo `content`

`content` es la colección unificada usada por el feed. Una muestra de 1.000 documentos mostró:

- `module`: 810 `news`, 190 `community`.
- `type`: 810 `news`, 190 `post`.
- `source`: 810 `wordpress`, 190 `scraping`.
- `createdAt` y `updatedAt`: presentes como `Timestamp` en los 1.000 documentos muestreados.
- `deletedAt`: `null` en 984 y `Timestamp` en 16 documentos muestreados.
- `publicId`: presente en los documentos de noticias muestreados y ausente en los de comunidad.
- `category`: presente como string, pero vacío en la mayoría de la muestra y con valores heterogéneos en comunidad.
- `slug`: presente como string, con registros legados y valores que no necesariamente son títulos editoriales.
- `originalUrl`: presente como string.

### Campos observados en `content`

Campos comunes o editoriales:

```text
titulo, descripcion, type, module, source, isOficial,
createdAt, updatedAt, deletedAt, ingestedAt,
slug, slugBase, slugModule, publicId, postId,
category, tags, originalUrl, externalId, externalSource,
images, imagesV2, imgMiniatura, video_links, group_name, group_url,
userId, userName, userProfilePicUrl,
stats.likesCount, stats.commentsCount, stats.viewsCount,
custom_fields.*
```

Campos de riesgo especial:

```text
userId, userName, userProfilePicUrl,
custom_fields.*, externalId, externalSource,
group_url, video_links, contenido de comunidad y texto libre.
```

No se encontró en la muestra de `content` ningún campo real llamado `visibility`, `status`, `publishedAt`, `moderation` o `canonicalUrl`. Por lo tanto, la condición pública propuesta por la guía no puede aplicarse literalmente sin definir una política compatible con el esquema existente.

## 4. Noticias, comunidad y eventos

### Noticias

La sincronización RTDB -> Firestore (`/news/{newsId}`) crea o actualiza `content` con:

- `module = news`, `type = news`, `source = wordpress`, `isOficial = true`.
- `titulo`, `descripcion`, imágenes, categoría, tags y `originalUrl`.
- `publicId`/`postId` cuando existe un identificador numérico.
- `createdAt`, `updatedAt`, `deletedAt`, `ingestedAt`.
- índice auxiliar `_content_public_ids` para resolver referencias públicas.

### Comunidad

La sincronización RTDB -> Firestore (`/c/{postId}`) crea o actualiza `content` con:

- `module = community`, `type = post`, `source = scraping`, `isOficial = false`.
- texto, imágenes, grupo, videos, `userId`/autor, categoría y `originalUrl`.
- `deletedAt` y timestamps.

El frontend también permite crear publicaciones de usuario con `source = user`; ese origen no apareció en la muestra de 1.000 documentos consultada, pero sí existe en el código de `feedStore`.

### Eventos

No existe una colección top-level `events` ni un modelo estructurado de eventos confirmado en el código o en Firestore. No se observaron campos confiables `startAt`, `endAt`, `timezone`, `venue` o equivalentes en `content` dentro del inventario realizado.

Conclusión: el endpoint de eventos de la guía no puede diseñarse todavía como recurso independiente. Primero hay que confirmar si los eventos viven como noticias, en `custom_fields`, en otra fuente no inventariada o si deben modelarse más adelante.

## 5. URLs canónicas y resolución de contenido

El dominio documentado por el frontend es `https://cdelu.ar/`.

Rutas observadas:

- Noticias: `/noticia/{referencia}/{slug}` cuando existe `publicId`/`postId`; también hay resolución por slug.
- Comunidad: `/c/{id-or-slug}`.
- Índices auxiliares: `_content_slugs` y `_content_public_ids` son legibles públicamente y contienen `contentId`, `module`, `slug` o `publicId`.
- `public/robots.txt` apunta a `https://cdelu.ar/sitemap.xml`.
- `public/sitemap.xml` contiene principalmente rutas estáticas; no se confirmó un sitemap dinámico de publicaciones.

`canonicalUrl` no está almacenado en `content`. Debe derivarse de forma controlada desde `module`, `publicId`/ID y `slug`, o conservarse desde `originalUrl` cuando sea realmente canónica. No se debe devolver `originalUrl` automáticamente como canonical sin validar su origen.

## 6. Fechas y estados

Fechas verificadas:

| Campo | Tipo observado | Uso |
|---|---|---|
| `createdAt` | Firestore `Timestamp` | creación/origen del documento |
| `updatedAt` | Firestore `Timestamp` | última actualización |
| `ingestedAt` | Firestore `Timestamp` | ingreso por sincronización |
| `deletedAt` | `null` o `Timestamp` | soft delete en contenido |
| `startsAt`, `endsAt` | `Timestamp` en loterías | ciclo de lotería, no evento editorial |
| `expiresAt` | `Timestamp` en encuestas y controles | expiración operativa |

No hay estado editorial unificado confirmado en `content`. `deletedAt` es el único indicador de eliminación observado. Las encuestas y loterías sí tienen `status`, pero no son el modelo de noticias/eventos.

## 7. Datos públicos, privados y sensibles

### Candidatos a exposición pública, condicionados

- Noticias oficiales `module = news`, `type = news`, `source = wordpress`, no eliminadas.
- Título, resumen o contenido sanitizado, imágenes públicas, categoría y fechas.
- `publicId`, `slug` y URL canónica derivada.
- Provenance de primera parte con URL validada.
- Categorías editoriales normalizadas, una vez confirmadas.

### No exponer en API pública

- `users`, correos, roles, claims, preferencias, notificaciones y dispositivos.
- `userId`, `userProfilePicUrl` y datos de autor de comunidad salvo una política explícita y un DTO aprobado.
- Comentarios, replies, likes, seguidores y seguidos.
- Secretos, aliases anónimos, votos, reportes, fingerprints y rate limits.
- Entradas de lotería, números elegidos, participantes y datos de administración.
- `custom_fields` completos, campos internos de sincronización y cualquier token.
- Anuncios internos, eventos de tracking y configuración administrativa.
- Contenido eliminado, contenido en moderación o contenido denunciado.

La existencia de `allow read: if true` en algunas reglas de Firebase no convierte automáticamente esos documentos en contrato público seguro; la API debe aplicar una lista explícita de campos permitidos y filtros de dominio.

## 8. Reglas y seguridad actuales

### Firestore

- `users`: lectura privada para el propio usuario o admin.
- `users_public`: lectura pública, escritura bloqueada.
- `usernames`: lectura pública, escritura bloqueada.
- `content`: lectura condicionada por `isSecretVisibleForRead`; comentarios, replies y likes tienen lecturas públicas en reglas actuales.
- `ads`: lectura pública si `active = true`; administración para staff.
- `surveys`: lectura pública; escritura para staff.
- `lotteries`: lectura pública; las entradas también tienen lectura pública en reglas actuales, lo cual es un riesgo para cualquier API futura.
- `_content_slugs` y `_content_public_ids`: lectura pública.
- `_sync_control`: solo admin.
- `_config`: lectura pública en reglas actuales; contiene configuración que debe revisarse antes de exponerla por una API.

### Storage

- `posts/{userId}/...`: lectura pública; escritura autenticada solo para el propietario, imágenes menores de 5 MB.
- `avatars/{userId}/...`: lectura pública; escritura autenticada solo para el propietario, imágenes menores de 2 MB.

### Realtime Database

La regla raíz niega lectura y escritura, pero hay reglas de escritura abiertas para `/news/{newsId}` y `/c/{postId}` con validación mínima. Esto debe mantenerse separado de la API pública y revisarse antes de usar RTDB como fuente de confianza editorial.

## 9. Índices actuales

`firestore.indexes.json` contiene índices para:

- `content`: `deletedAt`, `module`, `moderation.status`, `createdAt`, `userId`.
- collection groups de `comments` y `replies`.
- `ads`, `surveys`, `survey_votes`, `lotteries` y `entries`.

No hay índices basados en `visibility`, `status` o `publishedAt` para `content`, coherente con su ausencia en los datos observados. No se deben agregar índices de la API hasta decidir el modelo público y las consultas reales.

## 10. Cloud Functions existentes

El backend actual contiene triggers Firestore, RTDB, Storage, callable functions y tareas programadas para:

- likes, comentarios, replies y contadores;
- secretos, votos, comentarios, reportes y moderación;
- perfiles, relaciones, notificaciones y dispositivos;
- sincronización de noticias WordPress y publicaciones de comunidad;
- slugs e identificadores públicos de contenido;
- imágenes de comunidad y hosting FTP;
- loterías, entradas, sorteos y migraciones;
- encuestas y cierre de encuestas expiradas;
- anuncios y eventos de anuncios;
- purga de notificaciones y rankings de secretos.

No hay aún funciones HTTP `onRequest` para la API pública ni una capa de repositorios/DTOs públicos separada de las funciones actuales.

## 11. Variables de entorno identificadas

Solo se registraron nombres, nunca valores:

```text
MYSQL_HOST
MYSQL_USER
MYSQL_PASSWORD
MYSQL_DATABASE
MYSQL_PORT
FIREBASE_PROJECT_ID
FIREBASE_SERVICE_ACCOUNT_KEY_PATH
```

También existe lógica de runtime que usa variables server-side para FTP, WebSocket y otros módulos. No deben pasar al frontend ni formar parte de un DTO público.

## 12. Build y verificaciones ejecutadas

Comandos equivalentes ejecutados usando los binarios locales porque `npm` no está disponible en el PATH de esta sesión:

```text
Backend/functions: node_modules/.bin/tsc.cmd                       PASS
Frontend:         node_modules/.bin/vue-tsc.cmd -b                 PASS
Frontend:         node_modules/.bin/vite.cmd build                 PASS
Lectura Firestore administrativa de metadatos                      PASS
```

Vite emitió una advertencia no bloqueante sobre el uso de `__dirname` en `vite.config.ts` con `configLoader: native`. No se modificó ese archivo.

## 13. Información que falta confirmar

1. Qué proyecto y credenciales se consideran oficialmente producción, aunque la lectura local apunta a `cdeluar-ddefc`.
2. Región exacta de despliegue de Functions HTTP y dominio/proxy final (`api.cdelu.ar` o `cdelu.ar/api`).
3. Política pública para comunidad y contenido `source = scraping`.
4. Campos o fuente real de eventos estructurados.
5. Criterio editorial equivalente a `visibility = public`, `status = published` y moderación.
6. Política para noticias sin `publicId`, sin slug válido o con `originalUrl` externa.
7. Política de autores: si se mostrará una identidad editorial fija o un DTO de autor limitado.
8. Lista oficial de categorías y normalización de los valores libres actuales.
9. Sanitización permitida para `descripcion`, imágenes, videos y HTML.
10. Política de contenido eliminado: ocultar inmediatamente, responder `404` o conservar tombstone.
11. Límites operativos, rate limiting y proveedor de caché para la futura API.
12. Si las reglas públicas actuales de loterías, comentarios, relaciones y configuración requieren endurecimiento independiente de la API.

## 14. Recomendación para la Fase 1

Antes de crear DTOs, confirmar los puntos 3 a 6 y decidir un contrato mínimo basado en el contenido editorial existente. La primera versión debería poder publicar únicamente noticias oficiales verificables; `events` y comunidad deberían quedar como `no confirmados` hasta tener campos de visibilidad, estado y fechas confiables.

No se recomienda que la siguiente fase use `doc.data()` directamente. Debe crear mappers explícitos que permitan excluir identificadores de usuario, campos internos, `custom_fields`, datos de sincronización y contenido no clasificado.
