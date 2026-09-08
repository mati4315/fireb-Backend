# API pública mínima CDELU - Fase 2

Fecha: 2026-09-08  
Estado: implementada en código, no desplegada

## Function

Se agregó la Cloud Function HTTP `publicApi` en:

```text
functions/src/publicApi/runtime.ts
```

La Function espera rutas bajo `/api/v1/...`. En esta etapa no se agregó un rewrite de Hosting ni se modificaron dominios DNS; el endpoint de producción deberá publicarse mediante el dominio/proxy confirmado en la siguiente revisión.

## Rutas

```text
GET /api/v1/health
GET /api/v1/news
GET /api/v1/news/:id
GET /api/v1/events
GET /api/v1/events/:id
GET /api/v1/categories
GET /api/v1/search?q=...
```

## Comportamiento

- Todas las respuestas incluyen `request_id`, `generated_at` y `api_version`.
- Las colecciones incluyen `data`, `pagination.limit`, `pagination.next_cursor` y `pagination.has_next`.
- Los errores usan `error.code`, `error.message`, `error.request_id` y `details`.
- `limit` es 20 por defecto y 100 máximo; búsqueda limita a 50.
- Los cursores son opacos y están basados en `createdAt`; no se usa `offset`.
- Se aceptan únicamente filtros conocidos; filtros no soportados responden `400`.
- CORS solo permite los orígenes configurados en `PUBLIC_API_ALLOWED_ORIGINS`; por defecto `https://cdelu.ar`.
- Solo se acepta `GET` y `OPTIONS`.
- No se requiere autenticación para esta superficie pública.
- No se exponen usuarios, comentarios, secretos, administración ni documentos Firestore completos.

## Búsqueda

La búsqueda de esta fase es lexical y se ejecuta sobre una ventana limitada de noticias editoriales. Devuelve título, resumen, URL, fecha, provenance, score y campos coincidentes; no devuelve el contenido completo como resultado de búsqueda.

No se agregaron embeddings, PostgreSQL, Redis ni un motor de búsqueda externo.

## Rate limiting

Se agregó un límite temporal por IP y ruta dentro de la instancia:

```text
listados: 60 requests/min
detalle: 120 requests/min
búsqueda: 30 requests/min
```

Esto protege el MVP y permite devolver `429`, pero no es todavía un rate limiter distribuido entre instancias. Antes de producción con tráfico real debe reemplazarse o complementarse con una solución distribuida y métricas persistentes.

## Eventos

La ruta existe, pero el inventario no encontró una colección o documentos estructurados de eventos. Por eso devuelve una colección vacía mientras no exista contenido con `type = event` o `module = events` y `startAt` válido.

## Verificación

```text
functions/.bin/tsc.cmd: PASS
```

No se desplegaron Functions, reglas, índices ni Hosting.

## Riesgos pendientes

1. Confirmar el dominio público final y agregar rewrite solo después de validar DNS/Hosting.
2. Reemplazar el rate limiting en memoria antes de producción.
3. Medir lecturas Firestore y latencia; esa optimización corresponde a la siguiente fase.
4. Confirmar la política de URLs canónicas y eventos estructurados.
5. Probar los endpoints con emulador o despliegue controlado antes de publicarlos.
