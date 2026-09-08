Te recomiendo hacerlo por etapas, probar cada etapa y recién después avanzar. Hacerlo todo de una vez aumenta mucho el riesgo de errores en Firebase, permisos, costos y autenticación MCP.
Usaría este prompt general como base:
Trabaja usando como especificación principal:

D:\FIREBASE\Backend\GUIA y modulos\Api_Publica.md

Antes de modificar archivos:

1. Analiza el estado actual del Backend y Frontend.
2. Revisa Firebase, Firestore, Functions, reglas, índices y variables de entorno.
3. No supongas que las colecciones o campos existen: verifícalos.
4. No migres a PostgreSQL ni agregues infraestructura innecesaria.
5. No expongas usuarios, comentarios, secretos, claims, datos administrativos ni información privada.
6. Mantén la API pública separada del MCP privado.
7. Implementa únicamente la fase solicitada.
8. Ejecuta build, tests y verificaciones de seguridad.
9. No avances a la siguiente fase hasta informar claramente el resultado.
10. No uses acciones destructivas ni modifiques archivos fuera del alcance sin avisar.

Al terminar, informa:
- archivos modificados;
- qué se implementó;
- comandos ejecutados;
- pruebas realizadas;
- riesgos pendientes;
- próximo paso recomendado.
Después lo dividiría así.
Paso 1: inventario
Usando Api_Publica.md, realiza únicamente la Fase 0 de inventario.

Analiza Backend y Frontend y documenta:

- colecciones Firestore;
- subcolecciones;
- campos reales;
- tipos de contenido;
- campos de visibilidad;
- campos de moderación;
- URLs canónicas;
- fechas y estados;
- datos sensibles;
- reglas de Firestore y Storage;
- índices necesarios;
- Cloud Functions existentes.

No implementes todavía la API.

Crea un informe dentro de:
D:\FIREBASE\Backend\GUIA y modulos\

Indica qué datos pueden ser públicos, cuáles deben ser privados y qué información falta confirmar.
Paso 2: modelo público
A partir del inventario realizado y de Api_Publica.md, diseña el modelo público de CDELU.

Define:

- DTOs públicos;
- mappers desde Firestore;
- tipos TypeScript;
- campos permitidos;
- campos excluidos;
- tipos news, event y category;
- provenance;
- fechas y estados;
- política para contenido eliminado;
- política para contenido de usuarios.

No crees aún endpoints públicos.

Verifica que nunca se devuelva directamente doc.data().
Ejecuta el build del Backend y Frontend si corresponde.
Paso 3: API pública mínima
Implementa únicamente la API pública read-only mínima:

- GET /api/v1/health
- GET /api/v1/news
- GET /api/v1/news/:id
- GET /api/v1/events
- GET /api/v1/events/:id
- GET /api/v1/categories
- GET /api/v1/search

Requisitos:

- Cloud Functions HTTP;
- respuestas JSON uniformes;
- paginación por cursor;
- límite máximo de resultados;
- filtros validados;
- DTOs públicos;
- request_id;
- errores consistentes;
- CORS revisado;
- sin autenticación para contenido público, pero con rate limiting;
- no exponer usuarios, comentarios, secretos ni administración.

No implementes todavía MCP ni escritura.

Prueba cada endpoint y ejecuta build.
Paso 4: optimización
Optimiza la API pública implementada sin cambiar su contrato.

Revisa:

- lecturas y costos de Firestore;
- índices;
- consultas sin filtros;
- paginación;
- tamaño de respuestas;
- caché;
- ETag o Last-Modified;
- límites de bytes;
- latencia;
- errores 429;
- consultas duplicadas;
- contenido completo enviado en búsquedas.

Agrega métricas de:

- latencia;
- cantidad de documentos leídos;
- cache hit;
- status HTTP;
- tamaño de respuesta;
- errores.

No agregues embeddings todavía.
Paso 5: MCP privado
Implementa el MCP privado read-only siguiendo Api_Publica.md.

Endpoint objetivo:

https://api.cdelu.ar/private/mcp

Tools iniciales:

- search_cdelu
- search_news
- get_news
- search_events
- get_event
- search_categories
- get_publication_context
- get_module_status

Requisitos:

- autenticación OAuth/OIDC o mecanismo seguro equivalente;
- scopes por herramienta;
- tools read-only;
- máximo 50 resultados;
- timeout por tool;
- respuestas pequeñas y estructuradas;
- provenance en cada resultado;
- auditoría de cada llamada;
- no ejecutar consultas Firestore arbitrarias;
- no exponer secretos ni datos privados;
- protección contra prompt injection;
- documentación de conexión para ChatGPT.

No agregues herramientas de escritura.
Paso 6: conexión y evaluación
Prueba la integración completa de CDELU con el cliente MCP y ChatGPT.

Verifica:

- autenticación;
- expiración y revocación de tokens;
- scopes;
- conexión HTTPS;
- descubrimiento de tools;
- respuestas con fuentes;
- fechas y zona horaria;
- contenido eliminado;
- datos privados;
- límites de resultados;
- errores;
- latencia;
- costos.

Evalúa estas preguntas:

- ¿Qué noticias se publicaron hoy?
- ¿Qué eventos hay este fin de semana?
- ¿Dónde se realiza el evento X?
- ¿Cuál es la fuente?
- ¿Qué ocurre si no existen resultados?
- ¿Puede el contenido de una noticia modificar el comportamiento del agente?

No implementes escritura automática.
Paso 7: escritura controlada, más adelante
Analiza si realmente conviene agregar herramientas de escritura al MCP.

No implementes todavía.

Evalúa riesgos y diseño para:

- submit_correction;
- create_draft_event;
- update_draft;
- approve_draft.

Define:

- roles;
- scopes;
- confirmación humana;
- idempotency key;
- auditoría;
- rollback;
- límites;
- validación;
- pruebas de abuso.

Solo después de presentar el diseño y sus riesgos, implementa la primera herramienta de borrador.
Mi recomendación final sería:
Inventario
  ↓
Modelo público
  ↓
API pública
  ↓
Optimización
  ↓
MCP privado
  ↓
Conexión con ChatGPT
  ↓
Evaluación
  ↓
Escritura controlada