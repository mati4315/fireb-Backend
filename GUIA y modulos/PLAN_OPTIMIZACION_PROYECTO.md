# Plan de Optimizacion del Proyecto

Fecha: 2026-06-09
Proyecto: CdeluAR / Firebase + Frontend

## Objetivo

Mejorar velocidad, fluidez y consumo de recursos sin cambiar la experiencia funcional actual.

La idea no es quitar contenido del Home ni simplificar el sitio a costa de funcionalidad.
La idea es que el Home siga mostrando noticias, comunidad, encuestas, loteria, radio y demas
contenidos, pero que la logica interna este mejor organizada y cargue menos peso innecesario.

## Aclaracion importante: que significa que "el Home no sea el cerebro de todo"

No significa que el Home deje de ser la pantalla principal ni que pierda contenido.
Significa que el componente del Home no deberia contener toda la logica pesada de la app:

- consultas
- listeners
- edicion
- comentarios
- likes
- encuestas
- loterias
- ads
- radio
- validaciones
- helpers de render

El Home puede seguir siendo el lugar donde se ve todo, pero la logica pesada debe vivir
en stores, composables y subcomponentes especializados. Asi el Home se vuelve mas liviano,
mas facil de mantener y mas rapido de renderizar.

---

## Etapa 1: Medir antes de tocar

### Tareas

- Medir tiempo de carga inicial del frontend.
- Identificar componentes mas pesados en arranque.
- Revisar tamaño del bundle y chunks principales.
- Revisar cuantos listeners se abren al entrar al sitio.
- Identificar que se monta aunque el usuario no use esa seccion.

### Archivos a revisar

- [Frontend/src/App.vue](D:/FIREBASE/Frontend/src/App.vue)
- [Frontend/src/main.ts](D:/FIREBASE/Frontend/src/main.ts)
- [Frontend/src/router/index.ts](D:/FIREBASE/Frontend/src/router/index.ts)
- [Frontend/src/stores/moduleStore.ts](D:/FIREBASE/Frontend/src/stores/moduleStore.ts)

### Resultado esperado

- Tener una linea base de rendimiento.
- Saber que mejora da mas impacto real.

### Criterio de cierre

- Hay una lista clara de cuellos de botella medidos.

---

## Etapa 2: Hacer mas perezoso el arranque global

### Tareas

- Revisar que listeners se activan al montar la app.
- Dejar en carga tardia lo que no sea imprescindible para la primera vista.
- Evitar inicializar módulos pesados antes de que se necesiten.
- Reducir trabajo paralelo durante el primer render.

### Archivos a revisar

- [Frontend/src/App.vue](D:/FIREBASE/Frontend/src/App.vue)
- [Frontend/src/main.ts](D:/FIREBASE/Frontend/src/main.ts)
- [Frontend/src/stores/notificationStore.ts](D:/FIREBASE/Frontend/src/stores/notificationStore.ts)
- [Frontend/src/stores/moduleStore.ts](D:/FIREBASE/Frontend/src/stores/moduleStore.ts)

### Resultado esperado

- Menos trabajo al entrar al sitio.
- Primer paint mas rapido.

### Criterio de cierre

- El sitio muestra contenido util antes de terminar de cargar todo lo secundario.

---

## Etapa 3: Aligerar el Home

### Tareas

- Separar la logica grande de [Frontend/src/views/HomeView.vue](D:/FIREBASE/Frontend/src/views/HomeView.vue) en subcomponentes y composables.
- Mantener el Home como contenedor principal, pero no como lugar donde vive toda la logica de negocio.
- Mover a componentes dedicados:
  - comentarios
  - likes
  - encuestas
  - loteria
  - radio
  - ads
  - cards de contenido
- Reducir el tamaño mental y tecnico del archivo principal.

### Resultado esperado

- El Home sigue mostrando todo.
- Pero renderiza y mantiene menos logica interna.

### Criterio de cierre

- El Home queda como orquestador visual, no como componente monolitico.

---

## Etapa 4: Carga por demanda de modulos

### Tareas

- Revisar que los modulos que el usuario no abrio no se suscriban ni calculen de mas.
- Mantener lazy loading en componentes pesados.
- Hacer que cada modulo se active solo cuando hace falta.

### Archivos a revisar

- [Frontend/src/stores/feedStoreV2.ts](D:/FIREBASE/Frontend/src/stores/feedStoreV2.ts)
- [Frontend/src/stores/adsStore.ts](D:/FIREBASE/Frontend/src/stores/adsStore.ts)
- [Frontend/src/stores/surveyStore.ts](D:/FIREBASE/Frontend/src/stores/surveyStore.ts)
- [Frontend/src/stores/lotteryStore.ts](D:/FIREBASE/Frontend/src/stores/lotteryStore.ts)
- [Frontend/src/stores/commentStore.ts](D:/FIREBASE/Frontend/src/stores/commentStore.ts)

### Resultado esperado

- Menos listeners activos.
- Menos queries innecesarias.
- Menos memoria usada.

### Criterio de cierre

- Un modulo no consume recursos si no esta visible o habilitado.

---

## Etapa 5: Optimizar listas largas

### Tareas

- Aplicar `content-visibility` donde tenga sentido.
- Separar listas largas en componentes mas chicos.
- Evaluar virtualizacion en:
  - Home
  - perfiles
  - managers administrativos
- Reducir repaint en scroll.

### Archivos a revisar

- [Frontend/src/views/HomeView.vue](D:/FIREBASE/Frontend/src/views/HomeView.vue)
- [Frontend/src/views/ProfileView.vue](D:/FIREBASE/Frontend/src/views/ProfileView.vue)
- [Frontend/src/views/AdsManagerView.vue](D:/FIREBASE/Frontend/src/views/AdsManagerView.vue)
- [Frontend/src/views/LotteryManagerView.vue](D:/FIREBASE/Frontend/src/views/LotteryManagerView.vue)

### Resultado esperado

- Scroll mas fluido.
- Menos jank visual.

### Criterio de cierre

- Las listas grandes se sienten ligeras incluso en movil.

---

## Etapa 6: Reducir costo de imagenes y assets

### Tareas

- Verificar thumbnails realmente livianos.
- Asegurar lazy loading donde aplique.
- Reducir imagenes grandes que no aportan valor.
- Evitar descargar mas calidad de la necesaria para previews.

### Archivos a revisar

- [Frontend/src/views/HomeView.vue](D:/FIREBASE/Frontend/src/views/HomeView.vue)
- [Frontend/src/views/ProfileView.vue](D:/FIREBASE/Frontend/src/views/ProfileView.vue)
- [Frontend/src/components/feed/SecretCard.vue](D:/FIREBASE/Frontend/src/components/feed/SecretCard.vue)
- [Frontend/src/components/feed/FeedAdItem.vue](D:/FIREBASE/Frontend/src/components/feed/FeedAdItem.vue)

### Resultado esperado

- Menos peso de red.
- Mejor LCP.
- Menor consumo de datos.

### Criterio de cierre

- Las imagenes visibles cargan rapido y las no visibles no bloquean.

---

## Etapa 7: Reducir costo visual

### Tareas

- Revisar sombras, blur y overlays.
- Disminuir animaciones que afectan elementos fijos.
- Evitar efectos costosos en móviles.
- Mantener la estética, pero con menos repaint.

### Archivos a revisar

- [Frontend/src/App.vue](D:/FIREBASE/Frontend/src/App.vue)
- [Frontend/src/components/radio/RadioDock.vue](D:/FIREBASE/Frontend/src/components/radio/RadioDock.vue)
- [Frontend/src/components/common/ImageLightbox.vue](D:/FIREBASE/Frontend/src/components/common/ImageLightbox.vue)
- [Frontend/src/components/common/AuthPromptModal.vue](D:/FIREBASE/Frontend/src/components/common/AuthPromptModal.vue)

### Resultado esperado

- Menor uso de CPU/GPU.
- Mejor fluidez en móvil.

### Criterio de cierre

- El sitio mantiene estilo pero con menos costo visual.

---

## Etapa 8: Revisar Firebase y bundle

### Tareas

- Revisar imports de Firebase por modulo.
- Reducir dependencias usadas en el bundle principal.
- Mover parte de la logica a carga diferida si solo se usa en secciones secundarias.

### Archivos a revisar

- [Frontend/src/config/firebase.ts](D:/FIREBASE/Frontend/src/config/firebase.ts)
- [Frontend/src/stores/*.ts](D:/FIREBASE/Frontend/src/stores)
- [Frontend/src/views/*.vue](D:/FIREBASE/Frontend/src/views)

### Resultado esperado

- Menos peso de JS inicial.
- Menor tiempo de parseo.

### Criterio de cierre

- El bundle crece menos o baja en los puntos mas sensibles.

---

## Etapa 9: Backend y escrituras

### Tareas

- Revisar funciones que escriben mas de lo necesario.
- Evitar recalcular contadores si se puede agrupar.
- Priorizar lotes y agregacion diferida cuando aplique.

### Archivos a revisar

- [Backend/functions/src/index.ts](D:/FIREBASE/Backend/functions/src/index.ts)
- [Backend/firestore.rules](D:/FIREBASE/Backend/firestore.rules)
- [Backend/firestore.indexes.json](D:/FIREBASE/Backend/firestore.indexes.json)

### Resultado esperado

- Menor costo por operacion.
- Menos latencia.
- Menos riesgo de hotspots.

### Criterio de cierre

- Las funciones criticas hacen solo el trabajo necesario.

---

## Etapa 10: Cache y rehidratacion

### Tareas

- Revisar caches locales de stores.
- Evitar recalcular datos frescos.
- Reutilizar estado mientras siga vigente.

### Archivos a revisar

- [Frontend/src/stores/moduleStore.ts](D:/FIREBASE/Frontend/src/stores/moduleStore.ts)
- [Frontend/src/stores/adsStore.ts](D:/FIREBASE/Frontend/src/stores/adsStore.ts)
- [Frontend/src/stores/lotteryStore.ts](D:/FIREBASE/Frontend/src/stores/lotteryStore.ts)
- [Frontend/src/stores/notificationStore.ts](D:/FIREBASE/Frontend/src/stores/notificationStore.ts)

### Resultado esperado

- Menos queries repetidas.
- Menos costo al volver a una pestaña.

### Criterio de cierre

- El usuario no nota recarga innecesaria de datos frescos ya conocidos.

---

## Etapa 11: Validacion final

### Tareas

- Volver a medir lo mismo que en la etapa 1.
- Comparar antes y despues.
- Verificar que no se rompieron flujos.

### Resultado esperado

- Mejor rendimiento real.
- Sin regresiones funcionales.

### Criterio de cierre

- Se confirma que el sitio carga mas rapido y mantiene la misma experiencia.

---

## Orden recomendado de ejecucion

1. Medir antes de tocar.
2. Hacer mas perezoso el arranque global.
3. Aligerar el Home.
4. Carga por demanda de modulos.
5. Optimizar listas largas.
6. Reducir costo de imagenes y assets.
7. Reducir costo visual.
8. Revisar Firebase y bundle.
9. Backend y escrituras.
10. Cache y rehidratacion.
11. Validacion final.

---

## Version Operativa

### Leyenda

- Prioridad:
  - `Alta`: impacto fuerte o riesgo de arranque / render.
  - `Media`: mejora importante pero depende de la base ya optimizada.
  - `Baja`: refinamiento o mejora secundaria.
- Impacto:
  - `Alto`: se nota en carga, fluidez o costo.
  - `Medio`: mejora visible pero no rompe el flujo principal.
  - `Bajo`: ajuste fino.
- Esfuerzo:
  - `Bajo`: cambio puntual.
  - `Medio`: varias piezas.
  - `Alto`: refactor grande.

### Backlog Ejecutable

#### 1) Medicion base
- Prioridad: Alta
- Impacto: Alto
- Esfuerzo: Bajo
- Riesgo: Bajo
- Tareas:
  - medir tiempo de carga inicial
  - medir bundle
  - medir listeners al arranque
  - registrar cuellos de botella
- Entregable:
  - lista corta de problemas reales priorizados

#### 2) Arranque global perezoso
- Prioridad: Alta
- Impacto: Alto
- Esfuerzo: Medio
- Riesgo: Medio
- Tareas:
  - revisar [App.vue](D:/FIREBASE/Frontend/src/App.vue)
  - retrasar listeners no criticos
  - evitar inicializaciones globales prematuras
- Entregable:
  - primer render mas ligero

#### 3) Home liviano por dentro
- Prioridad: Alta
- Impacto: Alto
- Esfuerzo: Alto
- Riesgo: Medio
- Tareas:
  - sacar bloques pesados de [HomeView.vue](D:/FIREBASE/Frontend/src/views/HomeView.vue)
  - dividir en subcomponentes
  - dejar el Home como orquestador visual
- Entregable:
  - mismo Home visible, menos peso interno

#### 4) Carga por demanda de modulos
- Prioridad: Alta
- Impacto: Alto
- Esfuerzo: Medio
- Riesgo: Medio
- Tareas:
  - revisar stores de modulos
  - activar listeners solo cuando se usan
  - mantener las features apagadas si no estan visibles
- Entregable:
  - menos queries y menos memoria al entrar

#### 5) Listas largas y render
- Prioridad: Media
- Impacto: Alto
- Esfuerzo: Medio
- Riesgo: Bajo-Medio
- Tareas:
  - aplicar `content-visibility`
  - evaluar virtualizacion
  - fragmentar listas grandes
- Entregable:
  - scroll mas fluido

#### 6) Imagenes y assets
- Prioridad: Media
- Impacto: Alto
- Esfuerzo: Medio
- Riesgo: Bajo
- Tareas:
  - thumbnails livianos
  - lazy loading
  - revisar imágenes grandes
- Entregable:
  - menos red y mejor LCP

#### 7) Coste visual
- Prioridad: Media
- Impacto: Medio
- Esfuerzo: Bajo-Medio
- Riesgo: Bajo
- Tareas:
  - revisar blur y sombras
  - reducir animaciones pesadas
  - suavizar componentes fijos
- Entregable:
  - UI igual de bonita, mas barata de renderizar

#### 8) Bundle Firebase
- Prioridad: Media
- Impacto: Medio-Alto
- Esfuerzo: Medio
- Riesgo: Medio
- Tareas:
  - revisar imports
  - mover dependencias raras a carga tardia
  - evitar importaciones globales innecesarias
- Entregable:
  - menos peso JS

#### 9) Backend y escrituras
- Prioridad: Media
- Impacto: Medio-Alto
- Esfuerzo: Medio-Alto
- Riesgo: Medio
- Tareas:
  - revisar triggers y contadores
  - agrupar escrituras si se puede
  - evitar recalcular de mas
- Entregable:
  - menos costo y menos latencia

#### 10) Cache y rehidratacion
- Prioridad: Baja
- Impacto: Medio
- Esfuerzo: Bajo-Medio
- Riesgo: Bajo
- Tareas:
  - revisar cache local
  - evitar recargas innecesarias
  - mantener datos frescos por mas tiempo si siguen validos
- Entregable:
  - menos repeticiones de consulta

#### 11) Validacion final
- Prioridad: Alta
- Impacto: Alto
- Esfuerzo: Bajo
- Riesgo: Bajo
- Tareas:
  - repetir mediciones iniciales
  - comparar antes/despues
  - revisar regresiones
- Entregable:
  - reporte de mejora con evidencia

### Orden de implementacion sugerido

1. Etapa 1 y 2 juntas: medicion base + arranque global.
2. Etapa 3: aligerar Home.
3. Etapa 4: carga por demanda de modulos.
4. Etapa 5: listas largas.
5. Etapa 6: imagenes y assets.
6. Etapa 7: costo visual.
7. Etapa 8: bundle Firebase.
8. Etapa 9: backend y escrituras.
9. Etapa 10: cache y rehidratacion.
10. Etapa 11: validacion final.

### Regla de avance

- No pasar a la siguiente etapa sin dejar documentado:
  - que se cambio
  - que mejora dio
  - que riesgo quedo
  - que no se rompio

## Nota de criterio

No conviene optimizar a ciegas.
Cada etapa deberia terminar con una medicion simple o una verificacion concreta.
