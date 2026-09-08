# CDELU: API pública y plataforma AI-ready

**Estado:** especificación para implementar por fases  
**Versión:** 2.1  
**Última revisión:** 2026-09-08

## 1. Objetivo

Convertir CDELU en dos superficies complementarias:

1. una API pública pequeña, segura y estable para noticias, eventos y categorías públicas;
2. un MCP privado y autenticado para tu ChatGPT, tu IA propia y agentes autorizados.

La meta no es exponer Firestore ni hacer que una IA raspe HTML. La meta es crear un contrato de datos estable que sobreviva a cambios de frontend, proveedor de IA y base de datos.

```text
Datos CDELU → servicios de dominio → API pública v1
                         │                    ↓
                         │             Web / terceros
                         ▼
                  MCP privado autenticado
                         ↓
                  ChatGPT / IA propia
```

Ambas superficies comienzan en solo lectura. Las escrituras requieren identidad, autorización, auditoría, confirmación humana y reversión.

## 2. Contexto real

### Frontend

- Vue 3, TypeScript, Vite y Pinia.
- Firebase Web SDK: Auth, Firestore, Storage, Functions y Analytics.
- Capacitor para Android.
- El frontend consulta Firestore y Cloud Functions directamente.
- Sitio público: `https://cdelu.ar/`.

### Backend

- Firebase Functions en `D:\FIREBASE\Backend\functions`.
- Node.js 22 y TypeScript.
- Firestore como base principal, con Realtime Database y Storage.
- `firebase-admin`, `firebase-functions`, `sharp`, `basic-ftp` y `ws`.
- Existen funciones callable y triggers de Firestore.

El frontend utiliza noticias/publicaciones, comentarios, perfiles, encuestas, loterías, secretos, anuncios, radio y notificaciones. `content` parece concentrar varios tipos mediante `module`, `type`, `source`, `userId` y `deletedAt`; debe verificarse antes de cerrar el contrato.

### Decisión de arquitectura

No migrar a PostgreSQL como requisito inicial. Firestore y Cloud Functions pueden soportar el MVP. PostgreSQL, `pgvector`, Redis o una cola dedicada solo se evalúan si volumen, búsqueda, tráfico o costos lo justifican.

La API debe abstraer la base de datos para poder cambiarla sin romper consumidores.

## 3. Capas que no deben confundirse

```text
Descubribilidad: robots.txt, sitemap, RSS, JSON-LD, llms.txt
API pública:     HTTP/JSON mínimo, anónimo con límites
API privada:     endpoints internos para clientes autenticados
MCP privado:     tools completas para ChatGPT y agentes autorizados
Escritura:       acciones autenticadas y auditadas, fuera del MVP
```

Regla obligatoria:

```text
Modelo → tool validada → servicio de dominio → repositorio → base de datos
```

Nunca permitir consultas Firestore o SQL arbitrarias escritas por un modelo. El MCP no debe ser público por el simple hecho de tener una URL: debe exigir autenticación y autorización.

## 4. Fase 0: inventario obligatorio

Antes de programar endpoints:

```text
[ ] confirmar dominio y proyecto Firebase de producción
[ ] confirmar región de Functions
[ ] mapear colecciones y subcolecciones
[ ] mapear campos, tipos e índices reales
[ ] revisar reglas de Firestore, Storage y RTDB
[ ] confirmar URLs canónicas del frontend
[ ] identificar datos personales y sensibles
[ ] definir política de eliminados y moderación
[ ] identificar contenido legado o duplicado
```

Tabla de trabajo:

| Dominio | Colección probable | Público | ID | URL | Riesgo |
|---|---|---:|---|---|---:|
| Noticias | `content` | Sí, editorial | pendiente | pendiente | medio |
| Comunidad | `content` | Parcial | pendiente | pendiente | alto |
| Comentarios | subcolección | No por defecto | pendiente | variable | alto |
| Perfiles | `users` | Parcial | UID | perfil | alto |
| Encuestas | `surveys` | Parcial | documento | pendiente | medio |
| Loterías | `lotteries` | Parcial | documento | pendiente | alto |
| Secretos | `content` u otra | No por defecto | pendiente | pendiente | muy alto |
| Anuncios | `ads` | Sí, etiquetado | documento | pendiente | medio |

Los nombres son hipótesis basadas en el código actual. No deben convertirse en contrato sin verificar la base real.

Verificación externa:

```bash
curl -I https://cdelu.ar/
curl -I https://cdelu.ar/robots.txt
curl -I https://cdelu.ar/sitemap.xml
curl -I https://cdelu.ar/llms.txt
curl -I https://cdelu.ar/api/v1/health
```

Clasificar cada elemento como `existente`, `planificado`, `en desarrollo` o `no verificado`.

## 5. Superficies, URL y despliegue

Preferido:

```text
https://api.cdelu.ar/v1
```

Alternativa inicial:

```text
https://cdelu.ar/api/v1
```

MCP privado:

```text
https://api.cdelu.ar/private/mcp
```

La ruta privada no se protege con oscuridad. Debe usar OAuth/OIDC o un mecanismo de credenciales revocables, con scopes y auditoría. La URL puede ser pública en Internet para que ChatGPT llegue al servidor, pero los datos y tools permanecen privados mediante autenticación.

Arquitectura compatible con el backend actual:

```text
Firebase Hosting / proxy → Cloud Function HTTP → servicios → Firestore
```

Mantener las rutas HTTP públicas separadas de las callable del frontend. La API pública necesita CORS, respuestas cacheables, OpenAPI y errores HTTP consistentes.

No mezclar la API pública con el MCP privado. Pueden compartir servicios de dominio y repositorios, pero deben tener autenticación, límites, logs y contratos distintos.

## 6. API pública v1

### MVP

```http
GET /api/v1/health
GET /api/v1/news
GET /api/v1/news/{id}
GET /api/v1/events
GET /api/v1/events/{id}
GET /api/v1/categories
GET /api/v1/search
```

La API pública debe exponer solamente contenido editorial o eventos marcados como públicos. `content` puede mantenerse como implementación interna. Si se publica, debe devolver únicamente un DTO filtrado y no documentos Firestore.

### Posterior

```http
GET /api/v1/feeds/news.xml
GET /api/v1/feeds/events.xml
```

Lugares, autores y entidades pueden incorporarse después de revisar privacidad, calidad y utilidad real.

### Fuera del MVP

```http
POST /api/v1/content
PUT /api/v1/content/{id}
DELETE /api/v1/content/{id}
GET /api/v1/users
GET /api/v1/comments
GET /api/v1/secrets
```

### Principio de minimización pública

La API pública no debe ser un espejo de toda la aplicación. Debe responder preguntas generales como:

```text
¿Qué noticias publicó CDELU?
¿Qué eventos públicos hay?
¿Dónde está la fuente?
```

La información más completa, sensible o interna queda para el MCP privado y para servicios autenticados.

## 7. Formato público

Colecciones:

```json
{
  "data": [],
  "pagination": { "limit": 20, "next_cursor": null, "has_next": false },
  "meta": { "request_id": "req_01J...", "generated_at": "2026-09-08T20:00:00Z", "api_version": "v1" }
}
```

Recurso de contenido:

```json
{
  "id": "content_123",
  "type": "news",
  "origin": "editorial",
  "visibility": "public",
  "status": "published",
  "title": "Título",
  "slug": "titulo",
  "summary": "Resumen factual",
  "content": "Contenido limpio",
  "canonical_url": "https://cdelu.ar/noticia/titulo",
  "published_at": "2026-09-08T18:30:00-03:00",
  "updated_at": "2026-09-08T19:10:00-03:00",
  "language": "es-AR",
  "category": { "id": "cultura", "name": "Cultura" },
  "author": { "id": "author_9", "name": "CDELU" },
  "location": { "city": "Concepción del Uruguay", "province": "Entre Ríos", "country": "AR" },
  "images": [{ "url": "https://.../imagen.webp", "alt": "Descripción" }],
  "provenance": {
    "source_type": "first_party",
    "publisher": "CDELU",
    "canonical_url": "https://cdelu.ar/...",
    "retrieved_at": "2026-09-08T20:00:00Z"
  }
}
```

No devolver `doc.data()` directamente. Usar mappers y una lista explícita de campos permitidos.

## 8. Eventos y fechas

Los eventos necesitan datos estructurados, no solo texto en una noticia:

```json
{
  "id": "event_123",
  "type": "event",
  "name": "Festival local",
  "status": "scheduled",
  "start_at": "2026-09-12T20:00:00-03:00",
  "end_at": "2026-09-12T23:00:00-03:00",
  "timezone": "America/Argentina/Buenos_Aires",
  "venue": { "name": "Lugar", "address": "Dirección", "city": "Concepción del Uruguay" },
  "source": { "url": "https://cdelu.ar/...", "updated_at": "2026-09-08T19:00:00-03:00" }
}
```

Estados: `scheduled`, `cancelled`, `postponed`, `finished`, `unknown`.

Zona horaria editorial:

```text
America/Argentina/Buenos_Aires
```

Guardar timestamps de infraestructura en UTC y exponer ISO 8601 con offset cuando sea útil. Campos recomendados: `published_at`, `updated_at`, `retrieved_at`, `expires_at`, `timezone` y `status`.

## 9. Búsqueda y paginación

```http
GET /api/v1/search?q=carnaval&types=news,event&limit=10
```

Filtros iniciales: `q`, `types`, `category`, `from`, `until`, `city`, `status`, `sort`, `cursor` y `limit`.

Resultado mínimo:

```json
{
  "data": [{
    "id": "content_123",
    "type": "news",
    "title": "...",
    "summary": "...",
    "canonical_url": "https://cdelu.ar/...",
    "published_at": "2026-09-08T18:30:00-03:00",
    "score": 0.94,
    "match": { "kind": "lexical", "fields": ["title", "summary"] }
  }],
  "pagination": { "limit": 10, "next_cursor": null, "has_next": false }
}
```

Reglas: `limit` predeterminado 20, máximo 100; cursor para colecciones grandes; orden estable; no prometer `total` si calcularlo es costoso; no aceptar nombres de campos libres ni consultas arbitrarias.

La búsqueda híbrida y los embeddings son posteriores a medir la calidad de la búsqueda léxica y el costo de Firestore.

## 10. Visibilidad y privacidad

Valores sugeridos:

```text
public
unlisted
authenticated
staff
admin
deleted
moderation_hold
```

Orígenes: `editorial`, `community`, `user_generated`, `sponsored`, `system`, `unknown`.

La API pública debe exigir una condición equivalente a:

```text
visibility = public
status = published
deletedAt = null
moderation_status = approved o no requerido
```

No exponer automáticamente secretos anónimos, comentarios, teléfonos, correos, direcciones personales, claims, datos privados de sorteos, administración, contenido denunciado o imágenes privadas.

Las reglas de Firebase siguen siendo necesarias porque el frontend continúa accediendo al backend.

## 11. Seguridad, límites y caché

Requisitos mínimos:

- HTTPS.
- CORS revisado.
- Validación de entradas.
- Límite de respuesta.
- Rate limiting por IP y cliente.
- `request_id` en toda respuesta.
- Timeouts y errores controlados.
- Sin consultas Firestore o SQL arbitrarias.
- Sanitización de HTML.
- Secretos solo server-side.
- Logs sin PII innecesaria.

Valores iniciales para medir:

```text
Anónimo: 60 requests/min por IP
Cliente identificado: 300 requests/min
Búsqueda: 30 requests/min
Detalle: 120 requests/min
MCP: límite por cliente y tool
```

Las API keys deben ser server-side, almacenarse hasheadas, ser revocables y tener cuota. Nunca ponerlas en el frontend. No usar `Access-Control-Allow-Origin: *` junto con credenciales.

Cachear categorías, listados y próximos eventos con TTL corto o `ETag`. No cachear datos privados o personalizados.

## 12. Errores y observabilidad

```json
{
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "El parámetro limit debe estar entre 1 y 100.",
    "request_id": "req_01J...",
    "details": [{ "field": "limit", "reason": "out_of_range" }]
  }
}
```

Códigos mínimos: `400`, `401`, `403`, `404`, `409`, `413`, `429`, `500`, `503`.

Registrar: `request_id`, cliente, endpoint, método, status, latencia, bytes, cache hit y timestamp. Para IA, agregar tool, resultados recuperados, latencia de recuperación, modelo, tokens y costo estimado sin guardar datos sensibles innecesarios.

## 13. OpenAPI y descubribilidad

Publicar:

```text
https://api.cdelu.ar/openapi.json
https://api.cdelu.ar/docs
```

OpenAPI debe describir endpoints, parámetros, límites, esquemas, errores, paginación, autenticación, ejemplos y provenance. Versionarlo en Git y validarlo en CI.

Complementos web:

```text
/robots.txt
/sitemap.xml
/sitemap-news.xml
/feed.xml
/feed/news.xml
/feed/events.xml
/llms.txt
```

Usar JSON-LD `NewsArticle`, `Event`, `Place`, `Organization` y `WebPage` cuando corresponda. Los valores deben coincidir con la página visible y la API.

Ejemplo mínimo de `robots.txt`:

```text
User-agent: *
Allow: /

Sitemap: https://cdelu.ar/sitemap.xml
```

Ejemplo de `llms.txt`:

```text
# CDELU
Noticias y comunidad de Concepción del Uruguay, Entre Ríos, Argentina.
Sitio: https://cdelu.ar/
API: https://api.cdelu.ar/v1
OpenAPI: https://api.cdelu.ar/openapi.json
Política de IA: https://cdelu.ar/ai-policy
Sitemap: https://cdelu.ar/sitemap.xml
Feed: https://cdelu.ar/feed.xml
```

`llms.txt` es descubribilidad y documentación; no autentica ni obliga a ningún modelo a usar CDELU.

## 14. API privada y MCP privado

La superficie privada es la recomendada para conectar el proyecto con tu ChatGPT. No tiene que exponer todos los datos al público ni ofrecer escritura desde el inicio.

### Niveles de acceso

```text
public_read
private_read
private_write_draft
private_write_approved
admin
```

El primer MCP debe tener únicamente `private_read`. Los scopes de escritura se agregan más adelante y se habilitan de forma independiente.

### Autenticación

Preferencia:

```text
OAuth 2.0 / OpenID Connect
```

Alternativas controladas para integraciones server-to-server:

```text
API key revocable + scope
Service account limitada + allowlist de cliente
```

Nunca usar una clave fija compartida dentro del código, ni confiar solamente en un header secreto sin rotación. Registrar cliente, usuario, scope, tool, resultado, latencia y request ID.

### Herramientas privadas iniciales

```text
search_cdelu
search_news
get_news
search_events
get_event
search_categories
get_publication_context
get_module_status
```

En el MCP privado se pueden agregar datos que no conviene entregar a terceros anónimos, siempre que estén clasificados y autorizados. Eso no habilita automáticamente usuarios, comentarios, secretos o datos personales: cada dominio necesita su propio permiso.

### Herramientas que no se habilitan inicialmente

```text
create_content
publish_content
delete_content
modify_user
read_private_user_data
read_secrets
```

Una aplicación MCP puede estar disponible en Internet y seguir siendo privada. La privacidad se obtiene con autenticación, scopes, control de acceso y auditoría, no ocultando el endpoint.

## 15. Provenance, IA y MCP

Cada resultado debe incluir:

```json
{
  "source_type": "first_party",
  "publisher": "CDELU",
  "canonical_url": "https://cdelu.ar/...",
  "source_id": "content_123",
  "published_at": "2026-09-08T18:30:00-03:00",
  "updated_at": "2026-09-08T19:10:00-03:00",
  "retrieved_at": "2026-09-08T20:00:00Z"
}
```

Tipos de origen: `first_party`, `official_external`, `user_submitted`, `aggregated`, `unknown`.

La IA de CDELU debe vivir en backend. Debe buscar datos actuales, usar fechas reales, citar URLs recibidas, distinguir hechos de opiniones y abstenerse sin evidencia. La clave de OpenAI nunca va al navegador.

MCP privado futuro:

```text
https://api.cdelu.ar/private/mcp
```

Tools read-only: `search_cdelu`, `search_news`, `get_news`, `search_events`, `get_event`, `search_categories`.

Cada tool necesita esquema estricto, límite, timeout, respuesta pequeña, fuentes y errores controlados. No crear `ask_cdelu_anything`. Resources posteriores: `resource://cdelu/about`, `resource://cdelu/categories`, `resource://cdelu/ai-policy`.

El servidor MCP debe comprobar en cada llamada:

```text
[ ] identidad del cliente
[ ] usuario autorizado, si corresponde
[ ] scopes requeridos por la tool
[ ] límite de resultados
[ ] filtro de visibilidad
[ ] datos que pueden devolverse
[ ] auditoría de la llamada
```

Publicar una API o un MCP no significa que ChatGPT vaya a usarlo automáticamente. En ChatGPT hay que crear/conectar una aplicación MCP desde la configuración disponible para el plan y el espacio de trabajo. En la OpenAI API, el backend puede registrar un servidor MCP remoto como tool. Web, OpenAPI, RSS, OpenAI tools y MCP son mecanismos complementarios.

## 16. Indexación y embeddings

Para el MVP se puede indexar bajo demanda o mediante tareas programadas. Más adelante:

```text
contenido publicado → evento interno → worker
                   ├── búsqueda
                   ├── embedding
                   ├── caché
                   ├── sitemap/feed
                   └── auditoría
```

Eventos sugeridos: `content.published`, `content.updated`, `content.deleted`, `event.cancelled`.

Embeddings solo después de medir volumen, calidad, latencia y costo. Guardar `entity_id`, `text_hash`, `embedding_model`, `embedding_version` y `updated_at`. Nunca indexar contenido privado, eliminado o en moderación.

## 17. Escrituras de agentes

Segunda etapa:

```text
submit_correction
create_draft_event
update_draft
approve_draft
publish/cancel con confirmación humana
```

Toda escritura exige identidad, alcance, validación, límites, `idempotency key`, auditoría, confirmación y reversión. Un modelo nunca publica directamente contenido editorial sin revisión humana.

## 18. Código y pruebas

Agregar capas sin reorganizar todo el repositorio:

```text
functions/src/
├── api/          # HTTP, OpenAPI, errores, middleware
├── publicApi/    # rutas, schemas, mappers
├── domain/       # reglas y servicios
└── repositories/ # acceso a Firestore
```

Las rutas no deben mezclar consulta Firestore, reglas y serialización. El frontend puede conservar sus callable actuales.

Tests mínimos:

```text
[ ] cada endpoint cumple OpenAPI
[ ] errores tienen formato único
[ ] campos privados nunca aparecen
[ ] paginación no duplica ni salta
[ ] eliminados no aparecen
[ ] filtros arbitrarios son rechazados
[ ] CORS y rate limiting funcionan
[ ] no hay stack traces públicos
[ ] respuestas incluyen fuentes y fechas
```

Preguntas de evaluación: “¿Qué eventos hay este fin de semana?”, “¿Qué noticias se publicaron hoy?”, “¿Qué actividades hay mañana?”, “¿Dónde se realiza X?” y “¿Cuál es la fuente?”. Medir precisión, actualidad, citas, latencia y costos.

## 19. Optimización y preparación real para IA

La arquitectura será realmente utilizable por IA cuando se cumplan cuatro condiciones distintas:

```text
Contrato implementado
        +
MCP desplegado y autenticado
        +
ChatGPT/agente conectado y probado
        +
Calidad, latencia y costos medidos
```

Publicar una guía, una API o un endpoint MCP no completa por sí solo la integración.

### 18.1 Optimización de respuestas y contexto

Diseñar dos niveles de respuesta:

```text
listado/search: resumen, título, fecha, tipo, score y URL
detalle:        contenido completo, metadata y provenance
```

Reglas:

- devolver por defecto 10 resultados a una tool MCP;
- permitir como máximo 50 resultados por llamada MCP;
- limitar `limit` público a 100;
- no enviar contenido completo en búsquedas;
- truncar textos muy largos con un campo `content_truncated`;
- permitir `fields=summary` o `fields=full` solo donde esté documentado;
- devolver fuentes junto a cada resultado, no en un bloque separado ambiguo;
- evitar campos duplicados y nombres internos de Firestore;
- usar respuestas estructuradas y deterministas.

El objetivo es reducir tokens, latencia y posibilidad de que el modelo mezcle documentos.

### 18.2 Optimización de Firestore y costos

```text
[ ] todas las consultas tienen filtros e índices
[ ] ninguna consulta hace un escaneo completo
[ ] no usar offset para paginar
[ ] usar cursores documentados
[ ] no calcular total en cada búsqueda
[ ] limitar documentos y campos recuperados
[ ] separar lectura pública de datos privados
[ ] medir lecturas, errores y latencia por endpoint
```

Crear, si el modelo actual lo necesita, una proyección pública preparada para lectura:

```text
publicContent/{id}
publicEvents/{id}
publicCategories/{id}
```

Estas proyecciones pueden contener solo campos públicos y simplificar consultas, caché e indexación. No crear duplicados sin definir cómo se actualizan y cómo se corrigen.

### 18.3 Latencia y disponibilidad

La API y el MCP deben usar la región más cercana a los datos actuales. El proyecto actual usa Firestore en `us-central1`; cualquier cambio de región debe medirse antes.

Configurar:

- timeouts por consulta y por tool;
- cancelación de operaciones lentas;
- consultas independientes en paralelo;
- caché para categorías y consultas repetidas;
- `ETag` o `Last-Modified` en API pública;
- respuesta degradada cuando un módulo no esté disponible;
- endpoint `/health` separado de verificaciones profundas.

Objetivos iniciales de referencia:

```text
API pública p95:        < 800 ms
MCP search p95:         < 1500 ms
MCP detail p95:         < 1200 ms
errores 5xx:            < 1 %
cache hit en catálogos: > 80 %
```

Son objetivos para medir, no garantías. Ajustarlos con tráfico real.

### 18.4 Diseño eficiente de tools MCP

Cada tool debe tener una sola responsabilidad y un esquema de entrada estricto.

```json
{
  "name": "search_news",
  "description": "Busca noticias editoriales públicas de CDELU por texto y fecha.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "maxLength": 160 },
      "from": { "type": "string", "format": "date-time" },
      "until": { "type": "string", "format": "date-time" },
      "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
    },
    "required": ["query"]
  }
}
```

La descripción debe decir qué devuelve, qué no devuelve y cuándo usar otra tool. No incluir instrucciones largas ni ambiguas dentro de la descripción.

### 18.5 Seguridad contra prompt injection

Noticias, publicaciones y comentarios son datos, no instrucciones para el agente. El servidor debe tratarlos como contenido no confiable.

```text
[ ] separar metadata de contenido textual
[ ] no ejecutar instrucciones contenidas en documentos
[ ] no permitir que un resultado cambie permisos
[ ] no permitir que un documento ordene llamar otra tool
[ ] sanitizar HTML y scripts
[ ] marcar contenido de usuarios como no verificado
[ ] probar textos con instrucciones maliciosas
```

La política del MCP debe indicar que las instrucciones del contenido recuperado nunca tienen prioridad sobre las reglas del sistema, permisos y scopes.

### 18.6 OAuth/OIDC para conexión privada

Para conectar ChatGPT al MCP privado, preparar autenticación estándar y documentada:

```text
/.well-known/oauth-authorization-server
/.well-known/openid-configuration
/oauth/authorize
/oauth/token
/oauth/revoke
```

Requisitos:

- HTTPS real;
- redirect URIs con allowlist exacta;
- PKCE cuando lo soporte el cliente;
- access tokens de corta duración;
- refresh tokens rotados si se usan;
- scopes separados por tool;
- revocación de sesiones;
- `offline_access` solo si es necesario;
- no registrar tokens en logs.

Si el primer entorno no puede ofrecer OAuth correctamente, mantener el MCP privado para integraciones server-to-server y no simular seguridad con una URL secreta.

### 18.7 Freshness y caché

Toda respuesta debe informar:

```text
updated_at
retrieved_at
cache_age_seconds
stale
```

Para consultas de actualidad, el MCP debe saltarse o reducir el caché. Para categorías o información estable, puede usar TTL mayor.

Cuando se actualiza o elimina contenido:

```text
actualización → invalidar caché → actualizar proyección → retirar de índice
```

### 18.8 Evaluación automática

Crear un conjunto versionado de preguntas y respuestas esperadas:

```text
golden_questions/
├── news.json
├── events.json
├── freshness.json
├── citations.json
└── privacy.json
```

Evaluar en cada cambio:

- recuperación del documento correcto;
- precisión de fechas y estados;
- presencia de fuentes;
- no exposición de campos privados;
- comportamiento sin resultados;
- latencia y costo;
- resistencia a prompt injection.

No evaluar solamente si “la respuesta suena bien”.

### 18.9 Presupuesto operativo

Definir límites antes de abrir el MCP:

```text
máximo de llamadas por tool
máximo de documentos por llamada
máximo de bytes por respuesta
máximo de tiempo por consulta
cuota por cliente
alerta de costo diario
```

Un MCP privado también puede generar costos si una IA repite búsquedas, pide demasiados resultados o consulta historiales completos.

## 20. Roadmap

### Fase 0: inventario y seguridad

```text
[ ] mapear datos reales
[ ] clasificar público/privado
[ ] revisar reglas Firebase
[ ] confirmar URLs canónicas
[ ] definir moderación y eliminados
```

### Fase 1: API read-only

```text
[ ] health
[ ] content/news
[ ] detalle
[ ] búsqueda léxica
[ ] DTOs y mappers
[ ] cursor pagination
[ ] errores, CORS y rate limiting
[ ] request_id y logs
```

### Fase 2: contrato y descubribilidad

```text
[ ] OpenAPI y docs
[ ] JSON-LD
[ ] sitemap
[ ] robots.txt
[ ] RSS
[ ] llms.txt
```

### Fase 3: robustez

```text
[ ] ETag/caché
[ ] tests de contrato y seguridad
[ ] monitoreo
[ ] costos Firestore
```

### Fase 4: IA/MCP

```text
[ ] backend de IA
[ ] tools pequeñas
[ ] citas y provenance
[ ] evaluación
[ ] MCP privado read-only
[ ] OAuth/OIDC o API keys con scopes
[ ] autenticación de clientes
[ ] auditoría de tools
```

### Fase 5: escritura

```text
[ ] borradores
[ ] idempotencia
[ ] aprobación humana
[ ] auditoría y reversión
```

## 21. MVP recomendado

```text
1. API HTTP pública read-only sobre Cloud Functions.
2. /api/v1/health.
3. /api/v1/news y /api/v1/events públicos.
4. Detalle de noticia/evento público.
5. /api/v1/search con búsqueda léxica limitada.
6. DTOs que excluyan datos sensibles.
7. Paginación por cursor.
8. Rate limiting, CORS y request_id.
9. OpenAPI y tests.
10. JSON-LD, sitemap, RSS y llms.txt.
11. MCP privado read-only con autenticación.
12. Scopes y auditoría separados para el MCP.
```

La versión pública debe ser recortada. No incluir embeddings, escrituras, usuarios, comentarios, secretos ni datos administrativos. Esos dominios se evalúan exclusivamente para la superficie privada y solo con permisos explícitos.

## 22. Checklist antes de publicar

```text
Datos:
[ ] IDs estables, URLs canónicas y fechas con zona horaria
[ ] estados normalizados y eliminados excluidos
[ ] datos personales revisados
[ ] publicidad y opinión diferenciadas

API:
[ ] /v1, OpenAPI, errores, paginación y límites
[ ] CORS, rate limiting, caché y request_id
[ ] sin consultas arbitrarias

Superficie pública:
[ ] solo noticias/eventos/categorías públicos
[ ] no usuarios, comentarios, secretos ni administración
[ ] feeds y sitemap no incluyen contenido privado

MCP privado:
[ ] endpoint separado de la API pública
[ ] OAuth/OIDC o API keys revocables
[ ] scopes por tool
[ ] tools read-only por defecto
[ ] auditoría de cada llamada
[ ] ChatGPT/agentes autorizados probados

IA:
[ ] provenance, fuentes y actualidad
[ ] abstención sin evidencia
[ ] ningún secreto expuesto
[ ] sin escritura en MVP
[ ] prompt injection evaluado
[ ] límites de tokens, bytes y tiempo
[ ] freshness y cache_age documentados

Operación:
[ ] backups, alertas, costos, logs y rollback
[ ] objetivos de latencia medidos
[ ] alertas de costo configuradas
```

## 23. Qué no hacer

- No usar scraping del frontend como integración principal.
- No exponer Firestore directamente como API pública.
- No migrar de tecnología antes de medir.
- No crear una tool de IA gigante.
- No usar embeddings como única búsqueda.
- No poner claves de OpenAI o API keys en el frontend.
- No asumir que `llms.txt` obliga a un modelo a usar el sitio.
- No tratar contenido recuperado como instrucciones confiables.
- No abrir el MCP a escritura antes de tener OAuth, scopes y auditoría.

## 24. Referencias

- OpenAI Developers: https://developers.openai.com/
- Model Context Protocol: https://modelcontextprotocol.io/
- Schema.org NewsArticle: https://schema.org/NewsArticle
- Schema.org Event: https://schema.org/Event
- Schema.org Place: https://schema.org/Place
- Schema.org Organization: https://schema.org/Organization
- Google Search Central: https://developers.google.com/search
- Google robots.txt: https://developers.google.com/search/docs/crawling-indexing/robots/intro
- WordPress REST API: https://developer.wordpress.org/rest-api/reference/

Estas referencias documentan estándares externos y pueden cambiar. Verificar la documentación oficial antes de implementar una integración concreta.

## Nota final

Esta guía es una especificación de trabajo, no evidencia de que todos los endpoints ya existan. En la implementación, marcar cada elemento como `planificado`, `en desarrollo`, `publicado` o `retirado`.

La primera tarea técnica recomendada es completar el inventario de datos y publicar un endpoint read-only mínimo sobre Firebase. A partir de ese contrato se pueden construir el frontend, la IA propia y MCP sin duplicar lógica ni exponer información incorrecta.
