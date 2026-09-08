# API publica - Fase 4: optimizacion

## Alcance

Se optimizo unicamente la Function HTTP `publicApi`. El contrato JSON de la API v1 no cambia y no se agregaron embeddings ni escritura.

## Cambios implementados

- Cache en memoria por instancia con TTL corto para lecturas de noticias y resultados reutilizables.
- Encabezado `ETag` debil para respuestas exitosas y soporte de `If-None-Match` con respuesta `304`.
- Encabezados `Cache-Control`, `X-Cache` y `X-Response-Bytes`.
- Limite de seguridad de 900 KB por respuesta; si se supera, se devuelve `413 RESPONSE_TOO_LARGE`.
- Consultas de listados con `select` de campos publicos conocidos.
- Metricas estructuradas en logs con request id, latencia, lecturas Firestore, cache hit, estado HTTP y bytes.
- Se conserva la paginacion por cursor, el limite maximo, la validacion de filtros y el rate limiting.

## Verificaciones

- `functions\\node_modules\\.bin\\tsc.cmd`: correcto.
- No se modifico el Frontend en esta fase.

## Riesgos pendientes

- La cache es local a cada instancia de Cloud Functions y se pierde al reiniciarse.
- Firestore sigue cobrando lecturas de documentos; `select` reduce datos transferidos, no elimina por si solo el costo de lectura.
- La busqueda continua siendo lexica y limitada al conjunto escaneado por la API.

## Proximo paso

Desplegar y verificar la Function publica. El Frontend Vue se debe tocar en una fase posterior, cuando se conecten sus servicios a `https://us-central1-cdeluar-ddefc.cloudfunctions.net/publicApi/api/v1`.
