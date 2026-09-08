# Modelo público CDELU - Fase 1

Fecha: 2026-09-08  
Estado: diseñado, sin endpoints públicos

## Política de exposición

La primera versión pública solo admite contenido editorial oficial de `content`:

```text
module = news
type = news
isOficial = true
source = wordpress o admin
deletedAt = null o ausente
```

Si en el futuro aparecen `visibility`, `status` o `moderation`, el mapper también exige:

```text
visibility = public
status = published
moderation.status = approved o active
```

Comunidad, scraping, secretos, comentarios, usuarios, likes, loterías, notificaciones y configuración no forman parte del modelo público inicial.

## Archivos

- `functions/src/publicApi/types.ts`: DTOs y tipos públicos.
- `functions/src/publicApi/policy.ts`: elegibilidad y clasificación de origen.
- `functions/src/publicApi/mappers.ts`: mappers allow-list y sanitización básica.
- `functions/src/publicApi/index.ts`: exportaciones de la capa.

## DTOs

### `PublicNews`

Incluye únicamente:

```text
id, type, origin, visibility, status,
title, slug, summary, content,
canonical_url, published_at, updated_at, language,
category, author, location, images, provenance
```

El autor editorial se normaliza a `CDELU`; no se propagan `userId`, `userName` ni `userProfilePicUrl` desde Firestore.

### `PublicEvent`

Existe como DTO preparado para contenido estructurado con `type = event` o `module = events`, pero actualmente el inventario no encontró documentos que lo alimenten. Requiere `startAt`/`start_at` y no convierte noticias comunes en eventos.

### `PublicSearchResult`

Es un DTO reducido: título, resumen, URL, fecha, score opcional, match lexical opcional y provenance. No incluye el contenido completo.

### `PublicCategory`

Se deriva de un nombre controlado y no expone documentos completos de `_config` ni `custom_fields`.

## Provenance

Cada recurso incluye:

```text
source_type, publisher, canonical_url, source_id,
published_at, updated_at, retrieved_at
```

Las fechas se serializan como ISO 8601 UTC. La zona editorial definida para eventos es `America/Argentina/Buenos_Aires`.

## Campos excluidos

Los mappers no copian automáticamente ningún campo no listado. Quedan excluidos expresamente:

```text
userId, userName, userProfilePicUrl, email, rol, claims,
custom_fields, stats internos, externalId, externalSource,
moderation interna, tokens, secretos, fingerprints,
comentarios, replies, likes, notificaciones, entradas de lotería
```

Las imágenes solo se aceptan con URL HTTP/HTTPS, se deduplican y se limitan a 12. El texto pasa por una limpieza básica de HTML y se limita para evitar respuestas descontroladas. La sanitización HTML avanzada deberá confirmarse antes de publicar contenido enriquecido.

## Eliminados y contenido de usuarios

- `deletedAt` distinto de `null` o ausente excluye el recurso.
- No se implementan tombstones ni respuestas `404` todavía; eso corresponde al contrato HTTP.
- El contenido `source = user` o `source = scraping` queda fuera del modelo público inicial, incluso si es visible en el frontend.

## Decisiones pendientes antes de endpoints

1. Confirmar si las noticias sin `publicId` deben usar el ID Firestore como referencia pública.
2. Confirmar si `originalUrl` es siempre la fuente canónica o solo una referencia externa.
3. Definir una fuente real para eventos estructurados.
4. Decidir si `content` completo se sirve en detalle o si requiere una limpieza HTML más fuerte.
5. Definir la política HTTP para contenido eliminado y no encontrado.
