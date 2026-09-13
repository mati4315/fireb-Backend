# Metodo de miniaturas optimizadas para distribuidores

## Objetivo

Reducir el peso de las imagenes de portada de noticias importadas desde distribuidores WordPress, sin modificar la imagen original y sin tocar publicaciones antiguas que no necesitan cambios.

El sistema actual aplica el metodo solamente a:

- `arribanoticias.com.ar`
- `elmiercolesdigital.com.ar`

## Comportamiento

Cuando llega o se actualiza una noticia oficial:

1. Se busca la URL real del distribuidor en estos campos, en este orden:
   - `originalUrl`
   - `sourceUrl`
   - `url`
   - `link_post`
   - `custom_fields.link_post`
   - `custom_fields.sourceUrl`
   - `custom_fields.source_url`
2. Se verifica que el host pertenezca a la lista autorizada.
3. Se verifica que la fecha de la noticia corresponda a la semana actual o sea futura.
4. Se toma la imagen original desde `img`, `image`, `imageUrl`, `coverImage` o `custom_fields.img`.
5. Se descarga la imagen, se corrige su orientacion y se convierte a WebP.
6. Se limita el ancho a `640px`, sin ampliar imagenes pequeñas, con calidad WebP `72`.
7. Se sube al hosting FTP en:

```text
news-thumbnails/<distribuidor>/<id>.webp
```

8. Se guarda la URL resultante en `imgMiniatura` y en `imagesV2[0].thumbUrl`.
9. La imagen original permanece en `img` y continua disponible para la vista completa.

Ejemplo de URL generada:

```text
https://bot.cdelu.io/images/news-thumbnails/arribanoticias.com.ar/8829.webp
```

## Regla de seguridad de fechas

La semana comienza el lunes a las 00:00 de `America/Argentina/Buenos_Aires`. Las noticias anteriores a ese limite no se procesan automaticamente. Esto evita modificar historico y controlar costos de FTP y procesamiento.

Si una noticia antigua se actualiza, tampoco se genera una miniatura nueva porque se vuelve a comprobar su fecha de publicacion.

## Archivos involucrados

Backend:

- `functions/src/officialNewsThumbnailRuntimeUtils.ts`: validacion de distribuidores, fechas, descarga, compresion y subida FTP.
- `functions/src/contentSyncRuntimeUtils.ts`: integracion con la sincronizacion de noticias WordPress/RTDB.
- `functions/src/publicApi/mappers.ts`: expone `thumbnail_url` sin exponer datos privados.
- `functions/src/publicApi/types.ts`: contrato del campo `thumbnail_url`.

Frontend:

- `D:\FIREBASE\Frontend\src\api\publicApi.ts`: usa `thumbnail_url` en `thumbUrl` y conserva `url` como imagen completa.

## Como agregar otro distribuidor

1. Confirmar la URL real del distribuidor en el payload de RTDB o en `custom_fields.link_post`.
2. Confirmar cual campo contiene la imagen original y agregarlo solamente si no coincide con los campos actuales.
3. Agregar los hosts autorizados en `TARGET_HOSTS` dentro de `officialNewsThumbnailRuntimeUtils.ts`.
4. No agregar dominios genericos, comodines ni hosts que no hayan sido verificados.
5. Ejecutar el build del backend y frontend.
6. Probar una noticia del nuevo distribuidor y verificar:
   - `img` conserva la imagen original;
   - `imgMiniatura` apunta a `bot.cdelu.io`;
   - `imagesV2[0].thumbUrl` apunta al WebP;
   - la API publica devuelve `thumbnail_url`;
   - la miniatura responde HTTP 200 y `image/webp`.
7. Desplegar solamente las funciones necesarias y publicar el frontend.

## Actualizacion limitada de noticias existentes

Las noticias existentes no se reprocesan automaticamente solo por desplegar el codigo. Si se necesita procesar algunas de la semana actual, debe ejecutarse un backfill controlado que:

- filtre por los hosts autorizados;
- filtre por fecha de esta semana o futura;
- procese una cantidad limitada;
- actualice solamente `imgMiniatura` y `imagesV2[0].thumbUrl`;
- nunca reemplace `img`;
- se detenga si el propietario solicita omitir mas registros.

No se debe ejecutar un backfill global sobre todo `content` sin revisar primero cantidad, costos y fechas.

## Verificacion de API

La API publica debe devolver, por cada imagen, ambos valores:

```json
{
  "url": "https://distribuidor.example/imagen-original.jpg",
  "thumbnail_url": "https://bot.cdelu.io/images/news-thumbnails/distribuidor.example/123.webp"
}
```

Si `thumbnail_url` es `null`, la noticia no fue procesada por este metodo o no cumple las reglas de host, fecha o imagen valida. En ese caso el frontend usa `url` como fallback.

## Variables necesarias

La funcion usa las variables FTP ya existentes del backend:

```text
HOSTING_FTP_HOST
HOSTING_FTP_PORT
HOSTING_FTP_USER
HOSTING_FTP_PASSWORD
HOSTING_FTP_BASE_PATH
HOSTING_PUBLIC_BASE_URL
```

Nunca incluir valores reales de estas variables en documentacion, commits, capturas ni respuestas publicas.
