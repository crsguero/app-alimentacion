# App de alimentación

App personal para llevar tres cosas: **qué alimentos he probado y cuáles me gustan**, un
**recetario** y un **registro de ingestas del día**. Los datos viven en la nube (Firebase), con
respaldo local en el navegador, y hay que iniciar sesión para verlos.

## Cómo se ejecuta

No hay build, ni dependencias, ni pasos de instalación.

- **En local**: se abre el archivo directamente, `open index.html`.
- **Online**: <https://crsguero.github.io/app-alimentacion/>

En ambos casos se entra con email y contraseña (**las mismas cuentas que la app de tareas y la de
lactancia**). Local y online comparten la misma base de datos en la nube, así que los datos son los
mismos en el portátil y en el móvil. Para ver un cambio en local basta con recargar la pestaña.

Cuatro archivos, y nada más:

| Archivo | Qué contiene |
| --- | --- |
| `index.html` | Estructura, navegación, login y la **lista inicial de alimentos** (sirve de semilla de datos) |
| `styles.css` | Todos los estilos, incluidos modo oscuro y responsive |
| `app.js` | Toda la interacción y la sincronización, en un único IIFE |
| `favicon.svg` | Icono de la pestaña del navegador |

Sueltos, sin contenido: `.nojekyll` (para que GitHub Pages no procese nada) y `.gitignore`.

## Cómo subir un cambio a la versión online

```bash
cd "/Users/cristinaguerra/Library/CloudStorage/OneDrive-Personal/03 Archivador/02 Personal/04 Espacio digital/Mis aplicaciones/App alimentación"
git add .
git commit -m "Cambios varios"
git push
```

El repositorio es <https://github.com/crsguero/app-alimentacion>. Si `git push` pidiera usuario y
contraseña, la contraseña de GitHub ya no vale: haría falta un token.

## Convenciones

- **Todo en español**: interfaz, comentarios del código y textos.
- **JavaScript en estilo ES5**: `var`, `function`, IIFE. Sin módulos, sin frameworks, sin
  herramientas de compilación. Mantenerlo así.
- **Degradar sin JavaScript**: la navegación entre pestañas y las secciones plegables son HTML/CSS
  nativos y funcionan con JS desactivado. Lo que solo tiene sentido con JS se marca con la clase
  `js-only` (queda oculto vía `html:not(.js) .js-only`). Sin JS no hay login ni datos guardados: se
  ve la lista de alimentos del HTML, y ya. Que siga viéndose es justo lo que se conserva.
- **El QA lo hace Cristina.** Entregar el código y describir el cambio; no lanzar pasadas de
  verificación, capturas ni pruebas por cuenta propia salvo que lo pida.

## Cuenta y datos en la nube

Los datos viven en la **Realtime Database de Firebase del proyecto `app-tareas-f38e5`**, el mismo
que usan las apps de tareas, lactancia, recordatorios y compras: por eso las cuentas de acceso son
las mismas. Lo de esta app cuelga de la ruta **`alimentacion`**, para no mezclarse con lo demás.
Todas las cuentas con sesión ven los mismos datos.

El SDK entra por tres `<script>` de `gstatic.com` al final del `<body>`; son scripts normales, así
que se ejecutan **antes** que `app.js`, que va con `defer`.

### Login

- Mientras se comprueba la sesión, `<html>` lleva la clase **`auth-pending`** y el CSS tapa `.app`
  con una ruedecita. Al resolverse: si no hay sesión se cambia por **`auth-out`** (sale el
  formulario de entrada) y si la hay se quitan las dos.
- ⚠️ Las clases las pone el `<script>` en línea del `<head>`, junto a `js`. **Sin JavaScript no se
  añade ninguna**, así que la web se sigue viendo como siempre (la lista de alimentos del HTML) en
  vez de quedarse en la ruedecita para siempre.
- Cerrar sesión está en **Ajustes › Sesión**, junto al email de la cuenta y al estado de
  sincronización. Al cerrarla se recarga la página.
- **Si el SDK no carga** (abrir el archivo sin conexión, por ejemplo) no hay login: la app arranca
  en modo local con lo que haya en IndexedDB y avisa con el rótulo de arriba. Los cambios se
  guardan en la cola y suben en la siguiente sesión con conexión.

### Los tres almacenes

Alimentos, recetas e ingestas. Cada uno es un **mapa `id -> registro`**, con la misma forma en
memoria, en IndexedDB y en la nube.

- **Respaldo local en IndexedDB** (base `alimentacion`, almacén `kv`), no en `localStorage`: todos
  los archivos abiertos con `file://` comparten un mismo `localStorage` de ~5 MB que otra app local
  puede llenar. Se pinta con el respaldo local al instante y luego manda la nube.
- ⚠️ **El orden importa**: primero se lee IndexedDB y se pinta, y solo después se engancha la nube.
  Al revés, el primer snapshot se llevaría por delante lo que hubiera guardado en el aparato.
- En `localStorage` solo quedan las **preferencias de este navegador**: `misAlimentos.tab` y
  `misAlimentos.nav.*`. No son datos y no se sincronizan.
- **Migración**: la primera vez se vuelca lo que hubiera en las claves viejas de `localStorage`
  (`misAlimentos.v2`, `misAlimentos.v1`, `.recetas.v1`, `.ingestas.v1`) y se marca `local-movido`.
  ⚠️ Sin esa marca, vaciar las recetas las traería de vuelta al recargar. Las claves viejas no se
  borran: se quedan de reserva.
- **Primera sincronización**: mientras no esté la marca `nube-migrada`, lo que solo está en este
  dispositivo se **suma** a lo que haya en la nube en vez de perderse (así el móvil y el portátil
  conservan lo suyo; si la misma receta se creó en los dos, sale duplicada). Después manda la nube.

### Escrituras

- `storeCommit(almacen, mapa)` guarda el mapa entero en local, pero **a la nube manda solo lo que
  ha cambiado**: los hijos que se añaden, los que cambian y los que desaparecen, todo en un único
  `update()` (un hijo a `null` lo borra). ⚠️ Nunca el nodo completo: eso es lo que deshacía cambios
  recientes hechos desde otro dispositivo.
- Lo que sale del almacén son **copias**, y lo que entra también. Si no, editar una receta (que se
  edita cambiándole los campos) tocaría también el registro guardado y la comparación no vería
  ningún cambio.
- Solo se escribe en la nube si hay listener, conexión viva y primer snapshot recibido
  (`cloudUsable()`). Si no, el cambio va a una **cola** (`cola` en IndexedDB) que se vacía al
  reconectar y que se superpone a los snapshots para que no parpadee mientras espera.
- ⚠️ **Los ids de los alimentos son `grupo/nombre` y la barra separa rutas en Firebase**: en la
  clave del nodo se cambia por `~` y el id de verdad viaja **dentro** del registro, que es de donde
  se lee al volver. Los alimentos son el único almacén cuyo registro local no repite el id dentro
  (así la copia de seguridad conserva su formato de siempre).

### Cambios que llegan de fuera

Un listener por almacén. Cuando la nube cambia, se repinta la sección que toca (`rebuildCards()`,
`refreshRecipes()`, `refreshIntakes()`). ⚠️ Si hay algo **a medio editar** —una tarjeta en edición
en línea, el formulario de receta o el modal de ingesta abiertos— el repintado se aplaza y lo
recoge `repaintPending()` al cerrar. Repintar en ese momento se llevaría por delante lo que se esté
escribiendo.

El rótulo flotante de arriba (`#sync-note`) solo aparece cuando hay algo que contar: error, sin
conexión o sin nube. El estado completo está siempre en Ajustes › Sesión.

## Navegación: pestañas sin JavaScript

Cada pestaña es un `<input type="radio" name="grupo" class="tab-state" id="tab-X">` oculto pero
enfocable, hermano de `.sidebar` y `.content`. El panel activo se resuelve con selectores de
hermano:

```css
#tab-X:checked ~ .content #panel-X { display: block; }
```

⚠️ **Añadir una pestaña obliga a tocar cuatro listas de selectores en `styles.css`**: mostrar el
panel, marcar el elemento activo de la barra lateral, el foco visible y el bloque de modo oscuro.
Si se olvida alguna, la pestaña se ve pero no se resalta (o al revés).

Las secciones de la barra lateral («Alimentación», «Recetas», «Alimentos») son `<details class="nav-group" id="nav-...">`
nativos. Su estado abierto/cerrado se guarda en `misAlimentos.nav.<id>`.

Al pie de la barra lateral, pegado abajo con `margin-top: auto` en `.sidebar__foot`, va el botón
**⚙️ Ajustes** (`#settings-open`, `js-only`). No es una pestaña: abre un modal (ver «Ajustes»).

**La pestaña activa se recuerda** en `misAlimentos.tab` (el id del radio). `keepTabState()` es lo
primero que hace `init()`, para no enseñar la pestaña equivocada antes de corregirla. Sin JS —o sin
nada guardado— se abre en Carne, que es la que lleva `checked` en el HTML. Ojo: marcar un radio
desde código no dispara `change`, así que quien lo haga debe llamar también a `saveTab()`
(lo hace `showIntakesTab()`, el salto a Ingestas al guardar desde el FAB).

### Menú de móvil

Por debajo de **860 px** la barra lateral se esconde y pasa a ser un cajón que entra desde la
izquierda. Funciona con el mismo truco que las pestañas, sin JavaScript: un
`<input type="checkbox" id="nav-toggle" class="tab-state">` hermano de `.sidebar`, y
`#nav-toggle:checked ~ .sidebar { transform: none; }`.

- Se abre con `.menu-btn` (☰) de la `.topbar`, que solo se ve en móvil.
- Se cierra de tres formas: el aspa `.menu-close` del propio cajón, el fondo oscuro
  `.nav-backdrop` (ambos son `<label for="nav-toggle">`) y, con JS, al elegir una pestaña o pulsar
  Escape (`closeNavOnPick()`).
- Capas: `.topbar` 15, FAB 20, `.nav-backdrop` 30, `.sidebar` 40.
- ⚠️ En móvil `.app` necesita `grid-template-rows: auto 1fr`. Como la barra lateral sale del flujo,
  solo quedan dos filas (barra superior y contenido) y el grid repartiría entre ambas el alto
  sobrante hasta el `min-height: 100vh`: la barra superior se estiraba en las pestañas con poco
  contenido.

## Alimentos

**La lista inicial vive en el HTML.** Al arrancar, `collectSeeds()` recorre los `<li class="card">`
de `index.html`, los guarda como semillas, **los borra del DOM** y los reconstruye desde datos.
Es la forma de que la web siga siendo legible sin JS.

- **Id de cada alimento**: `grupo/slug(nombre del HTML)`. Se fija al cargar y no cambia aunque
  renombres el alimento en la app. Renombrarlo *en el HTML* sí deja huérfano lo guardado, y esa
  tarjeta vuelve a su columna original.
- **Almacenamiento**: el mapa `id -> registro` del almacén `alimentos`. De los alimentos del HTML
  solo se guarda lo que difiere del original (`state`, `name`, `deleted`); los que crea el usuario
  se guardan enteros con `custom: true`. Ese mapa es exactamente el `items` de siempre, así que la
  copia de seguridad no cambia de formato.
- **El cambio de estado es solo arrastrar y soltar**, por decisión expresa: los botones
  ○/👍/👎 existieron y se quitaron. Efecto lateral conocido y aceptado: no hay forma de cambiar de
  columna usando el teclado. No reintroducirlos sin preguntar.
- Cada tarjeta conserva únicamente ✏️ (editar en línea) y 🗑️ (eliminar).
- **No hay forma de restablecer la lista desde la interfaz.** El botón «Restablecer todo» del pie de
  la barra lateral se quitó, junto con la leyenda de colores (Sin probar / Me gusta / No me gusta).
  Para volver al estado original habría que vaciar el nodo `alimentacion/alimentos` en Firebase y
  el almacén local del navegador.

## Ingestas

Sección «Alimentación» de la barra lateral, panel `#panel-ingestas`. El panel no tiene formulario en
línea: dar de alta y editar pasan siempre por el modal. Dentro hay **dos subpestañas**:

| Subpestaña | Sección | Qué muestra |
| --- | --- | --- |
| Historial | `#intake-historial` | Las ingestas de un día, paginadas **por día** |
| Resumen | `#intake-resumen` | Una tarjeta por día con su total, paginadas **por semanas** |

Se alternan con el mismo truco que las pestañas grandes: dos radios `.tab-state` hermanos de
`.subtabs` y de las dos `<section class="intake-view">`, y selectores de hermano en `styles.css`.
Funcionan sin JavaScript y con teclado. ⚠️ **Añadir una subpestaña obliga a tocar tres listas de
selectores**: mostrar la sección, marcar la subpestaña activa y el foco visible.

`renderIntakes()` pinta **las dos** (`renderHistory()` y `renderSummary()`); cuál se ve lo decide el
CSS, así que el JS no necesita saber en cuál estás. Los botones de cada paginado solo repintan lo
suyo.

- Cada ingesta tiene **día**, **hora** y **tipo**. El tipo no se escribe: se elige entre cuatro botones
  —**Desayuno, Almuerzo, Cena, Snack**— que son radios (`.choice__input` + `<label class="choice">`)
  dentro de un `<fieldset class="field choices">`. Al ser radios funcionan sin JavaScript y con
  teclado. La lista está en `INTAKE_TITLES`; `cleanTitle()` rechaza cualquier otro valor.
- ⚠️ En la interfaz se llama **«Tipo»**, pero por dentro (dato guardado, ids, nombre del grupo de
  radios) sigue siendo `title`. Renombrarlo obligaría a migrar lo que ya está en `localStorage`.
- Al abrir el formulario el día viene relleno con **hoy** y la hora con la **hora actual**. El tipo
  **no viene preseleccionado**: hay que elegirlo, y sin él no se guarda. `markTypeMissing()` pinta
  el campo en rojo (`.choices--error`) y lleva el foco al primer botón; el aviso se retira al elegir
  uno o al volver a abrir el modal.
- Los radios **no llevan `required`**: al estar ocultos, el navegador no puede enfocarlos para su
  aviso nativo y se queda sin poder enviar el formulario. De ahí la comprobación a mano.
- `titleForHour()` (6–11 Desayuno, 12–16 Almuerzo, 20–23 Cena, el resto Snack) ya **solo** se usa al
  editar una ingesta vieja, para proponerle un tipo. No preselecciona nada en las nuevas.
- `cleanDay()` valida el día igual que `cleanTime()` valida la hora: solo pasa `AAAA-MM-DD` y solo
  si es una fecha real (rechaza, por ejemplo, el 31 de febrero). También filtra lo que se lee de
  `localStorage`.
- El grupo de radios se llama `intake-modal-title`; `readChoice()` y `setChoice()` lo leen y lo
  marcan por ese nombre.
- Las ingestas guardadas antes de los botones conservan su título, «Ingesta» (`INTAKE_TITLE`).
- Al editar se pueden cambiar **los tres campos**. Si cambia el día, la ingesta se va sola a su
  nuevo grupo: `renderIntakes()` reagrupa desde cero en cada repintado.
- **Almacenamiento**: el almacén `ingestas`, un mapa de `{ id, day, time, title }` por id, con `day`
  en formato `AAAA-MM-DD` (hora local) y `time` en `HH:MM`. En memoria se maneja como array: el
  orden lo pone el repintado, no el almacén.
- Los días se ordenan del más reciente al más antiguo; dentro de cada día, las ingestas van por
  hora ascendente. La cabecera del día dice «Hoy», «Ayer» o la fecha completa.
- **Se ve un día cada vez**, con el paginado (`#intake-pager`, `js-only`) encima del listado:
  «‹ Anterior» va hacia los días más recientes y «Siguiente ›» hacia los más antiguos, como en
  cualquier paginado, porque la página 1 es el día más reciente. En medio, la posición («2 de 7»),
  con `aria-live` para que se anuncie al cambiar. Con un solo día el paginado se oculta.
- El día que se está viendo se guarda en `iu.day` (la **clave del día**, no un índice: así aguanta
  altas y bajas) y la lista de días en `iu.keys`. Si el día que se veía desaparece, se cae al más
  reciente. Al guardar un alta o una edición, `iu.day` salta al día de lo que se acaba de tocar,
  para verlo. No se recuerda entre recargas.
- **Resumen**: mismo patrón, pero por semanas (`iu.week` / `iu.weeks`, `#summary-pager`). La semana
  va de **lunes a domingo** (`weekKeyOf()` devuelve la clave de su lunes) y la cabecera dice «Del 8
  al 14 de septiembre de 2026», repitiendo mes o año a los dos lados solo si cambian. Al guardar,
  `iu.week` salta igual que `iu.day`.
- En el resumen **solo salen los días que tienen ingestas**: un día sin ninguna no aparece, no sale
  con un cero. Dentro de la semana van de lunes a domingo, y la tarjeta dice «Hoy», «Ayer» o
  «Lunes 8» (`dayShort()`): el mes ya lo pone la cabecera de la semana.
- Cada fila lleva debajo del título **cuánto pasó desde la ingesta anterior** («Después de 3 h
  54 min»). `renderIntakes()` ordena todas de la más antigua a la más reciente, calcula los huecos
  en un mapa `id → minutos` y lo pasa hacia abajo; de ese orden sale ya cada día ordenado por hora.
  `minutesOf()` convierte día + hora a minutos **en UTC** a propósito, para que un cambio de hora no
  invente ni se coma una hora. La comparación es con la **anterior en el tiempo, sea del día que
  sea**: el desayuno se mide contra la cena de ayer, y la primera ingesta de todas no muestra nada.
- Las filas **no llevan botones**: la fila entera es un `<button class="intake-row__btn">` que abre
  el modal de edición, igual que en el listado de recetas. No hay arrastrar y soltar.
- Eliminar está **dentro del modal de edición** (`#intake-modal-delete`, `.btn--danger`), oculto con
  `hidden` cuando el modal se abre para dar de alta. `removeIntake()` devuelve si se llegó a borrar,
  para saber si cerrar el modal o quedarse (el `confirm` se puede cancelar).
- **El modal reparte el ancho a medias**: día y hora comparten línea (`.field-row` con `nowrap` y
  `flex: 1 1 0`), los cuatro botones de título van de dos en dos (`.choices__row` es un grid de dos
  columnas) y las acciones son otro grid de dos columnas: Guardar y Cancelar arriba, Eliminar
  ocupando la fila entera debajo (`grid-column: 1 / -1`). Ocultar Eliminar con `hidden` no deja
  hueco: no llega a crear celda.
- **Dos puertas de entrada al mismo modal** (`<dialog class="modal">`): el botón «+ Añadir ingesta»
  de la cabecera del panel y el **FAB** (`#intake-fab`), fijo en la esquina inferior derecha y
  visible en **todas** las pestañas. Ambos llaman a `openIntakeModal()` sin argumentos. Al guardar
  un alta se salta a la pestaña Ingestas para ver el registro.
- **El modal sirve para las dos cosas**, alta y edición: `openIntakeModal(intake)` con ingesta edita
  y sin ella crea. `iu.editing` guarda cuál se está editando y es lo que mira `submitIntakeModal()`
  para decidir si actualiza o da de alta; cambia también el título del modal («Nueva ingesta» o
  «Editar ingesta»). El botón de guardar dice **«Guardar» siempre**, así que es texto fijo del HTML:
  no lo toca nadie desde JS. Editando no se salta de pestaña. ⚠️ `iu.editing` hay que soltarlo **en dos sitios**:
  en `closeIntakeModal()` y en el evento `close` del `<dialog>`, porque cerrar con Esc no pasa por
  la función.
- Al editar una ingesta vieja («Ingesta», sin botón que le corresponda) se preselecciona el título
  que toca por su hora, para que lo que se ve sea lo que se guarda.
- El FAB y el modal viven fuera de `.content`, al final de `.app`, y son `js-only`. `html.js .content`
  añade 96 px de margen inferior para que el FAB no tape la última fila.
- Las ingestas solo se borran una a una, desde el modal de edición.

## Recetario

Tres pantallas dentro del mismo panel, alternadas con el atributo `hidden` desde `showView()`:

| Vista | Id | Contenido |
| --- | --- | --- |
| Listado | `#view-list` | Solo nombre y tiempo, una receta por fila; la fila entera es un `<button>` |
| Detalle | `#view-detail` | La receta completa, con Editar, Duplicar y Eliminar |
| Formulario | `#view-form` | Alta y edición |

- **Almacenamiento**: el almacén `recetas`, un mapa de
  `{ id, name, time, ingredients, steps, rich }` por id. `ingredients` es texto plano (una línea por
  ingrediente); `steps` es HTML. En memoria se maneja como array, ordenado al pintar.
- **«Preparación» es un `contenteditable`** con barra de formato (negrita, cursiva, subrayado,
  listas) basada en `document.execCommand`. Está formalmente obsoleto, pero es la única vía sin
  dependencias; si dejara de funcionar se perdería el formato, no el texto.
- ⚠️ **Todo el HTML pasa siempre por `sanitizeHtml()`**, tanto al guardar como al pintar: lista
  blanca de etiquetas de formato y borrado de **todos** los atributos. Es lo que permite usar
  `innerHTML` al mostrar una receta. No saltarse ese paso.
- El flag `rich` distingue las recetas nuevas (HTML) de las antiguas en texto plano, que se
  convierten al vuelo en `stepsHtmlOf()`.
- Al pegar dentro del editor, el contenido entra siempre como texto plano.

## Ajustes

Modal `#settings-modal`, abierto desde el botón ⚙️ del pie de la barra lateral. Hace dos cosas:
**la sesión** (qué cuenta, cómo va la sincronización y cerrar sesión) y **sacar y meter los datos
de la app en un archivo**.

- Es un `<dialog class="modal">` como el de ingestas, pero **sin formulario**: dentro lleva un
  `.modal__body` (mismo hueco y relleno que `.modal__form`, sin la rejilla de campos) con tres
  `<section class="settings-block">`: sesión, exportar e importar.
- **Sesión**: `#settings-email` con el email de la cuenta, `#settings-sync` con el estado de la nube
  (lo escribe `syncStatus()`, que se llama también al abrir el modal) y `#settings-logout`, que
  cierra sesión y recarga.
- **Exportar** (`exportData()`) arma el objeto de `backupData()` —`{ app, version, exported,
  alimentos, recetas, ingestas }`— y lo guarda como `alimentacion-AAAA-MM-DD.json`. Se exporta lo
  que hay en el almacén, que es lo mismo que hay en la nube.
- **Elegir la carpeta depende del navegador**, y por eso hay dos caminos. Si existe
  `window.showSaveFilePicker()` (Chrome y Edge, y solo por `http(s)`: abierta como `file://`
  suele fallar) se abre el diálogo del sistema y se escribe con `createWritable()`. Si no existe
  —o si falla— se cae a `downloadFile()`, el `<a download>` de siempre con una URL de `Blob` que
  se revoca al segundo, y el archivo va a la carpeta de descargas. ⚠️ Cancelar el diálogo llega
  como `AbortError`: eso **no** es un fallo y no debe disparar la descarga de respaldo.
- Como exportar puede tardar lo que la usuaria tarde en elegir carpeta, el mensaje de resultado lo
  pone `exportData()` por dentro, no quien escucha el clic.
- `misAlimentos.tab` y `misAlimentos.nav.*` **no se exportan**: son preferencias de este navegador,
  no datos.
- **Importar** pasa por un `<input type="file">` oculto (`.settings-file`) que dispara el botón.
  `readBackup()` exige la marca `app: 'misAlimentos'` y **revalida todo** como si viniera del
  almacén: las ingestas por `cleanDay()`/`cleanTime()`, y el HTML de las recetas por
  `sanitizeHtml()`. ⚠️ Ese saneado no es opcional: el archivo es contenido de fuera.
- **Se escriben solo las secciones que trae el archivo** (`writeBackup()`), así que una copia sin
  recetas no borra las recetas que ya haya. El aviso de `confirm` dice cuáles son, con el texto
  que arma `backupSummary()`. Lo importado va al almacén local **y a la nube**, como cualquier otro
  cambio, así que llega también a los demás dispositivos.
- Al terminar se repintan las secciones tocadas. ⚠️ Ya **no se recarga la página**: recargar
  cortaría las escrituras que aún van camino de la nube.
- El resultado se cuenta en `#settings-msg` (`role="status"`), en verde o, con
  `.settings-msg--bad`, en rojo. Vacío se oculta solo (`:empty`).
- Al abrir el modal se cierra el cajón de móvil: el botón no es un `.nav__item`, así que
  `closeNavOnPick()` no lo cubre y se quedaría abierto por detrás.

## Detalles que conviene recordar

- El título de la pestaña del navegador es «Alimentación»; el rótulo de la barra lateral sigue
  siendo «Mis alimentos». Es intencionado.
- Los alimentos no llevan emoji delante del nombre (se quitaron); los emojis de la barra lateral y
  de los títulos de grupo sí se mantienen.
- Dentro de cada columna, los alimentos se ordenan alfabéticamente al repintar; las recetas
  también.
- Los datos **se sincronizan solos** entre el portátil y el móvil, y entre la versión local y la
  online: son el mismo nodo de la nube. Lo que sigue siendo de cada navegador son las preferencias
  (pestaña activa y secciones abiertas) y el respaldo local de IndexedDB.
- El Exportar/Importar de **Ajustes** ya no es la única forma de llevarse los datos, pero se queda
  como copia de seguridad aparte.
