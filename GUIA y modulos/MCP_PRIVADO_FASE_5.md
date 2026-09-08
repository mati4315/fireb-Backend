# MCP privado - Fase 5

## Estado

Implementado en Backend y compilado, pero todavia no desplegado. El despliegue queda pendiente de crear la credencial en Firebase Secret Manager.

## Endpoint

Despues del despliegue:

`https://us-central1-cdeluar-ddefc.cloudfunctions.net/privateMcp`

La URL objetivo `https://api.cdelu.ar/private/mcp` requiere configurar un proxy o dominio personalizado en una etapa posterior.

## Seguridad

- Autenticacion `Authorization: Bearer ...`.
- Secret Manager mediante `PRIVATE_MCP_API_KEYS`.
- Scope obligatorio: `private_read`.
- Claves con id, expiracion opcional y posibilidad de revocacion reemplazando el secreto.
- No se aceptan consultas Firestore arbitrarias.
- No hay herramientas de escritura, usuarios, comentarios, secretos ni administracion.
- Timeout de 8 segundos por tool.
- Auditoria sin guardar el token ni los argumentos completos.

## Tools

- `search_cdelu`
- `search_news`
- `get_news`
- `search_events`
- `get_event`
- `search_categories`
- `get_publication_context`
- `get_module_status`

Todas las respuestas se limitan a 50 resultados y usan los mappers publicos con provenance. El texto recuperado se trata como datos y no como instrucciones para el agente.

## Crear la credencial

Generar una clave localmente, sin pegarla en el repositorio:

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$key = [Convert]::ToHexString($bytes)
$json = '[{"id":"chatgpt","key":"' + $key + '","scopes":["private_read"]}]'
.\\node_modules\\.bin\\firebase.cmd functions:secrets:set PRIVATE_MCP_API_KEYS --project cdeluar-ddefc
```

Cuando Firebase solicite el valor, pegar `$json` en esa misma terminal. La clave `$key` debe conservarse en un gestor seguro para la conexión del cliente MCP; no debe enviarse al repositorio ni al Frontend.

## Verificacion pendiente

Despues de crear el secreto se puede desplegar solo la nueva Function:

```powershell
.\\node_modules\\.bin\\firebase.cmd deploy --only functions:privateMcp --project cdeluar-ddefc
```

No se debe desplegar antes de configurar el secreto, porque el endpoint quedaria inutilizable y no se debe simular autenticacion con una URL secreta.
