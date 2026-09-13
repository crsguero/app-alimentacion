/* =========================================================
   Mis alimentos — interacción
   - Crear, editar y eliminar alimentos en cualquier columna
   - Mover tarjetas entre columnas (arrastrar y soltar)
   - Guardar los datos en la nube (Firebase) con respaldo local (IndexedDB)
   El HTML del index sirve de lista inicial: si no hay JS, la web
   se ve igual y las tarjetas se quedan en su columna de origen.
   ========================================================= */

(function () {
  'use strict';

  /* Preferencias de este navegador: no son datos, no se sincronizan */
  var NAV_KEY = 'misAlimentos.nav';
  var TAB_KEY = 'misAlimentos.tab';

  /* Claves del viejo localStorage: solo se leen una vez, al migrar */
  var LS_FOODS = 'misAlimentos.v2';
  var LS_FOODS_V1 = 'misAlimentos.v1';
  var LS_RECIPES = 'misAlimentos.recetas.v1';
  var LS_INTAKES = 'misAlimentos.ingestas.v1';

  var STATES = ['todo', 'yes', 'no'];
  var LABELS = { todo: 'Sin probar', yes: 'Me gusta', no: 'No me gusta' };
  var EMPTY = { todo: 'Todo probado 🎉', yes: 'Nada aquí todavía', no: 'Nada aquí todavía' };

  var seeds = {};   // id -> { group, name, state } tal y como viene del HTML
  var cards = [];   // { id, group, name, state, custom, el }
  var lists = {};   // "grupo:estado" -> <ul class="cards">
  var dragged = null;

  /* ---------- Utilidades ---------- */

  function slug(text) {
    return text
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function byId(id) {
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].id === id) { return cards[i]; }
    }
    return null;
  }

  function cardOf(node) {
    var el = node && node.closest ? node.closest('.card') : null;
    return el ? byId(el.dataset.id) : null;
  }

  function cleanName(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  /* =========================================================
     Almacenamiento: nube (Firebase) + respaldo local (IndexedDB)
     ========================================================= */

  /* ---------- Firebase ----------
     Mismo proyecto que la app de tareas, así que las cuentas de acceso son las
     mismas que en lactancia, recordatorios o compras. Los datos de esta app
     viven bajo la ruta "alimentacion" para no mezclarse con los de las otras.
     Todas las cuentas con sesión comparten estos datos. */
  var FB_CONFIG = {
    apiKey: 'AIzaSyDEBCJbasCSAH_o6L-VR63LLxoL9IM9BWk',
    authDomain: 'app-tareas-f38e5.firebaseapp.com',
    databaseURL: 'https://app-tareas-f38e5-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'app-tareas-f38e5',
    storageBucket: 'app-tareas-f38e5.firebasestorage.app',
    messagingSenderId: '991941627960',
    appId: '1:991941627960:web:7a6eeedda963354e3596cd'
  };
  var FB_ROOT = 'alimentacion';   // raíz de esta app dentro de la base de datos

  var fdb = null;        // base de datos; null si no ha cargado el SDK
  var fauth = null;
  var fbReady = false;   // sesión iniciada y escuchando la nube
  var fbOnline = false;  // websocket vivo (.info/connected)
  var fbSynced = {};     // almacén -> ya llegó su primer snapshot

  /* ---------- Los tres almacenes ----------
     Alimentos, recetas e ingestas. Cada uno es un mapa `id -> registro`, igual
     en memoria, en IndexedDB y en la nube: así un cambio escribe solo el hijo
     que toca y dos dispositivos no se pisan al guardar a la vez.
     IndexedDB y no localStorage porque todos los archivos abiertos con file://
     comparten un mismo localStorage de ~5 MB que otra app local puede llenar. */
  var DB_NAME = 'alimentacion';
  var DB_STORE = 'kv';
  var S_FOODS = 'alimentos';
  var S_RECIPES = 'recetas';
  var S_INTAKES = 'ingestas';
  var STORES = [S_FOODS, S_RECIPES, S_INTAKES];

  var OUTBOX_KEY = 'cola';          // cambios sin subir; no se sincroniza
  var MOVED_KEY = 'local-movido';   // localStorage ya volcado a IndexedDB
  var MIGRATED_KEY = 'nube-migrada';// lo que había aquí ya se subió a la nube

  var idb = null;
  var mem = {};          // almacén -> mapa id -> registro
  var outbox = [];       // [{ key, id, rec }]; rec a null = borrar
  var moved = false;
  var migrated = false;
  var lastError = '';

  STORES.forEach(function (key) { mem[key] = {}; });

  /* ---------- IndexedDB ---------- */

  function idbGet(key, done) {
    var req;

    if (!idb) { done(undefined); return; }

    try { req = idb.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key); }
    catch (e) { done(undefined); return; }

    req.onsuccess = function () { done(req.result); };
    req.onerror = function () { done(undefined); };
  }

  function idbSet(key, value) {
    if (!idb) { return; }
    try {
      idb.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(value, key);
    } catch (e) {
      /* sin respaldo local se sigue funcionando: la nube es la copia buena */
    }
  }

  /* Abre el almacén local y lee lo que haya antes de pintar nada. Sin él la app
     sigue: se trabaja con lo que traiga la nube, sin respaldo en el aparato. */
  function openStore(done) {
    var req;

    function withoutIdb() {
      moveFromLocalStorage();   // al menos lo que quedara en el almacén viejo
      done();
    }

    try { req = indexedDB.open(DB_NAME, 1); }
    catch (e) { withoutIdb(); return; }

    req.onupgradeneeded = function () { req.result.createObjectStore(DB_STORE); };
    req.onerror = function () {
      syncFail('No se ha podido abrir el almacén de este navegador.');
      withoutIdb();
    };
    req.onsuccess = function () {
      idb = req.result;
      readStore(done);
    };
  }

  function readStore(done) {
    var keys = STORES.concat([OUTBOX_KEY, MOVED_KEY, MIGRATED_KEY]);
    var left = keys.length;

    keys.forEach(function (key) {
      idbGet(key, function (value) {
        if (key === OUTBOX_KEY) { outbox = Array.isArray(value) ? value : []; }
        else if (key === MOVED_KEY) { moved = value === true; }
        else if (key === MIGRATED_KEY) { migrated = value === true; }
        else { mem[key] = value && typeof value === 'object' ? value : {}; }

        left--;
        if (!left) { moveFromLocalStorage(); done(); }
      });
    });
  }

  /* ---------- Migración: de localStorage a IndexedDB ----------
     Solo la primera vez. La marca `local-movido` evita que lo borrado después
     resucite: sin ella, vaciar las recetas las traería de vuelta al recargar. */
  function moveFromLocalStorage() {
    if (moved) { return; }

    var foods = lsRead(LS_FOODS);
    var items = foods && foods.items && typeof foods.items === 'object' ? foods.items : null;

    if (!items) {
      var old = lsRead(LS_FOODS_V1);   // formato v1: id -> estado
      if (old && typeof old === 'object') {
        items = {};
        Object.keys(old).forEach(function (id) {
          if (typeof old[id] === 'string') { items[id] = { state: old[id] }; }
        });
      }
    }

    if (items && !Object.keys(mem[S_FOODS]).length) { mem[S_FOODS] = items; }

    [[LS_RECIPES, S_RECIPES], [LS_INTAKES, S_INTAKES]].forEach(function (pair) {
      var list = lsRead(pair[0]);
      if (Array.isArray(list) && list.length && !Object.keys(mem[pair[1]]).length) {
        mem[pair[1]] = listToMap(list);
      }
    });

    moved = true;
    idbSet(MOVED_KEY, true);
    STORES.forEach(function (key) { idbSet(key, mem[key]); });
  }

  function lsRead(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }

  /* ---------- Lectura y escritura ---------- */

  function listToMap(list) {
    var map = {};
    list.forEach(function (item) {
      if (item && item.id) { map[String(item.id)] = item; }
    });
    return map;
  }

  function copyRec(rec) {
    var out = {};
    Object.keys(rec).forEach(function (k) { out[k] = rec[k]; });
    return out;
  }

  /* Lo que sale del almacén son copias, y lo que entra también: si el resto de
     la app editara los registros guardados (una receta se edita cambiándole los
     campos), la comparación de `storeCommit()` no vería ningún cambio. */
  function mapToList(map) {
    return Object.keys(map).map(function (id) { return copyRec(map[id]); });
  }

  function storeGet(key) { return mem[key] || {}; }

  function storeCopy(key) {
    var map = storeGet(key);
    var out = {};
    Object.keys(map).forEach(function (id) { out[id] = copyRec(map[id]); });
    return out;
  }

  function sortedRec(rec) {
    var out = {};
    Object.keys(rec).sort().forEach(function (k) { out[k] = rec[k]; });
    return out;
  }

  function sameRec(a, b) {
    if (!a || !b) { return false; }
    return JSON.stringify(sortedRec(a)) === JSON.stringify(sortedRec(b));
  }

  /* Se guarda el mapa entero, pero a la nube va solo lo que ha cambiado: los
     hijos que se añaden, los que cambian y los que desaparecen. Nunca el nodo
     completo, que es lo que deshacía cambios recientes de otro dispositivo. */
  function storeCommit(key, next) {
    var prev = mem[key] || {};
    var keep = {};
    var ops = [];

    Object.keys(next).forEach(function (id) {
      keep[id] = copyRec(next[id]);
      if (!sameRec(prev[id], next[id])) { ops.push({ key: key, id: id, rec: keep[id] }); }
    });

    Object.keys(prev).forEach(function (id) {
      if (!next[id]) { ops.push({ key: key, id: id, rec: null }); }
    });

    mem[key] = keep;
    idbSet(key, keep);
    if (ops.length) { sendOps(ops); }
  }

  /* ---------- Escritura en la nube ----------
     Los ids de los alimentos son "grupo/nombre" y la barra separa rutas en la
     base de datos, así que en la clave del nodo se cambia por "~". El id de
     verdad va dentro del registro, que es de donde se lee al volver. */
  function fbKey(id) { return String(id).replace(/[.#$\/[\]]/g, '~'); }

  /* Solo por si un registro llegara sin `id` dentro: los nuestros lo llevan */
  function idOfKey(key) { return String(key).replace(/~/g, '/'); }

  function cloudRec(id, rec) {
    var out = { id: id };
    Object.keys(rec).forEach(function (k) {
      if (k !== 'id' && rec[k] !== undefined) { out[k] = rec[k]; }
    });
    return out;
  }

  /* ¿Se puede escribir en la nube fiándonos de lo que tenemos en memoria?
     Solo con listener enganchado, conexión viva y primer snapshot recibido.
     Sin las tres, el cambio va a la cola y se aplica sobre datos frescos. */
  function cloudUsable(key) { return fbReady && fbOnline && fbSynced[key] === true; }

  function saveOutbox() {
    idbSet(OUTBOX_KEY, outbox);
    syncStatus();
  }

  function queueOps(ops) {
    ops.forEach(function (op) {
      /* una sola operación por id: la última es la que manda */
      outbox = outbox.filter(function (o) { return !(o.key === op.key && o.id === op.id); });
      outbox.push(op);
    });
    saveOutbox();
  }

  /* Todos los cambios de un almacén en una sola escritura. update() con un
     hijo a null lo borra, así que altas, cambios y bajas van juntos. */
  function pushOps(key, ops) {
    var patch = {};

    ops.forEach(function (op) {
      patch[fbKey(op.id)] = op.rec ? cloudRec(op.id, op.rec) : null;
    });

    fdb.ref(FB_ROOT + '/' + key).update(patch).catch(function (e) {
      syncFail('No se ha podido sincronizar: ' + errText(e));
    });
  }

  function sendOps(ops) {
    var byKey = {};
    var later = [];

    ops.forEach(function (op) {
      if (!cloudUsable(op.key)) { later.push(op); return; }
      if (!byKey[op.key]) { byKey[op.key] = []; }
      byKey[op.key].push(op);
    });

    Object.keys(byKey).forEach(function (key) { pushOps(key, byKey[key]); });
    if (later.length) { queueOps(later); }
  }

  /* Al reconectar (o al llegar el primer snapshot) sube lo que quedó en cola */
  function flushOutbox() {
    if (!outbox.length) { return; }

    var ready = [];
    var rest = [];

    outbox.forEach(function (op) {
      if (cloudUsable(op.key)) { ready.push(op); } else { rest.push(op); }
    });

    if (!ready.length) { return; }

    outbox = rest;
    saveOutbox();

    var byKey = {};
    ready.forEach(function (op) {
      if (!byKey[op.key]) { byKey[op.key] = []; }
      byKey[op.key].push(op);
    });
    Object.keys(byKey).forEach(function (key) { pushOps(key, byKey[key]); });
  }

  /* ---------- Sincronización ----------
     Un listener por almacén: cuando la nube cambia porque lo editó otro
     dispositivo, se adopta lo que llega, se le superponen los cambios que
     aún no han podido subir y se repinta. */
  function startSync() {
    if (!fdb) { return; }
    fbReady = true;

    /* Estado real de la conexión: `fbReady` a secas diría "sincronizado"
       aunque el websocket llevara horas caído. */
    fdb.ref('.info/connected').on('value', function (snap) {
      fbOnline = !!snap.val();
      if (fbOnline) { lastError = ''; flushOutbox(); }   // lo de antes ya pasó
      syncStatus();
    });

    STORES.forEach(function (key) {
      fdb.ref(FB_ROOT + '/' + key).on('value', function (snap) {
        applyRemote(key, snap.val());
      }, function (err) {
        syncFail('No se ha podido leer la nube: ' + errText(err));
      });
    });
  }

  function applyRemote(key, raw) {
    var cloud = {};

    if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (childKey) {
        var rec = raw[childKey];
        if (!rec || typeof rec !== 'object') { return; }

        var id = rec.id ? String(rec.id) : idOfKey(childKey);
        cloud[id] = localRec(key, id, rec);
      });
    }

    fbSynced[key] = true;

    /* La primera vez en este dispositivo, lo que solo estaba aquí se sube en
       vez de perderse: así ni el móvil ni el portátil se quedan sin lo suyo. */
    if (!migrated) {
      var mine = mem[key] || {};
      var ops = [];

      Object.keys(mine).forEach(function (id) {
        if (cloud[id]) { return; }
        cloud[id] = mine[id];
        ops.push({ key: key, id: id, rec: mine[id] });
      });

      if (ops.length) { sendOps(ops); }
    }

    mem[key] = withOutbox(key, cloud);
    idbSet(key, mem[key]);
    flushOutbox();
    markMigrated();
    repaint(key);
    lastError = '';   // si la nube contesta, el aviso anterior ya no toca
    syncStatus();
  }

  /* Lo que espera en la cola se ve encima de lo que llega de la nube, para que
     no parpadee mientras espera a la reconexión. */
  function withOutbox(key, map) {
    outbox.forEach(function (op) {
      if (op.key !== key) { return; }
      if (op.rec) { map[op.id] = op.rec; } else { delete map[op.id]; }
    });
    return map;
  }

  function markMigrated() {
    if (migrated) { return; }

    for (var i = 0; i < STORES.length; i++) {
      if (!fbSynced[STORES[i]]) { return; }
    }

    migrated = true;
    idbSet(MIGRATED_KEY, true);
  }

  /* En la nube todo registro lleva su id dentro, porque la clave del nodo no
     admite barras. Los alimentos, en cambio, se guardan aquí en un mapa
     id -> registro sin repetirlo dentro: así la copia de seguridad y el
     formato de los datos son los mismos de siempre. */
  function localRec(key, id, rec) {
    var out = {};

    Object.keys(rec).forEach(function (k) {
      if (k === 'id' && key === S_FOODS) { return; }
      out[k] = rec[k];
    });

    if (key !== S_FOODS) { out.id = id; }
    return out;
  }

  /* ---------- Repintado de lo que llega de fuera ----------
     Si hay algo a medio editar se espera a que se cierre: repintar en ese
     momento se llevaría por delante lo que se esté escribiendo. */
  var pendingPaint = {};

  function repaint(key) {
    if (busyWith(key)) { pendingPaint[key] = true; return; }

    pendingPaint[key] = false;

    if (key === S_FOODS) { rebuildCards(); }
    else if (key === S_RECIPES) { refreshRecipes(); }
    else if (key === S_INTAKES) { refreshIntakes(); }
  }

  function busyWith(key) {
    if (key === S_FOODS) { return !!document.querySelector('.card--editing'); }
    if (key === S_RECIPES) { return ui.current === 'form'; }
    if (key === S_INTAKES) { return !!(iu.modal && iu.modal.hasAttribute('open')); }
    return false;
  }

  function repaintPending() {
    STORES.forEach(function (key) {
      if (pendingPaint[key]) { repaint(key); }
    });
  }

  /* ---------- Avisos de sincronización ---------- */

  function errText(e) {
    if (!e) { return 'error desconocido'; }
    return e.message ? e.message : String(e);
  }

  function syncFail(text) {
    lastError = text || '';
    syncStatus();
  }

  /* Una sola línea de estado: en el modal de Ajustes siempre, y arriba solo
     cuando hay algo que contar (error, sin conexión o sin nube). */
  function syncStatus() {
    var banner = document.getElementById('sync-note');
    var line = document.getElementById('settings-sync');
    var pend = outbox.length;
    var left = pend === 1 ? '1 cambio pendiente' : pend + ' cambios pendientes';
    var note = '';
    var text;

    if (lastError) {
      text = lastError;
      note = lastError;
    } else if (!fbReady) {
      text = 'Sin nube: los cambios se guardan solo en este dispositivo.';
      note = text;
    } else if (!fbOnline) {
      text = 'Sin conexión' + (pend ? ' · ' + left : '') + '.';
      note = 'Sin conexión: los cambios se subirán al recuperarla.';
    } else {
      text = pend ? 'Subiendo ' + left + '…' : 'Sincronizado en la nube.';
    }

    if (line) { line.textContent = text; }

    if (banner) {
      banner.textContent = note;
      banner.hidden = !note;
      banner.classList.toggle('sync-note--bad', !!lastError);
    }
  }

  /* ---------- Alimentos ---------- */

  function loadData() {
    return storeCopy(S_FOODS);
  }

  function persist() {
    var items = {};

    // Alimentos del HTML: solo se guarda lo que difiere del original
    Object.keys(seeds).forEach(function (id) {
      var card = byId(id);
      if (!card) { items[id] = { deleted: true }; return; }

      var seed = seeds[id];
      var rec = {};
      if (card.state !== seed.state) { rec.state = card.state; }
      if (card.name !== seed.name) { rec.name = card.name; }
      if (Object.keys(rec).length) { items[id] = rec; }
    });

    // Alimentos añadidos por el usuario: se guardan enteros
    cards.forEach(function (card) {
      if (!card.custom) { return; }
      items[card.id] = {
        custom: true,
        group: card.group,
        name: card.name,
        state: card.state
      };
    });

    storeCommit(S_FOODS, items);
  }

  /* ---------- Tarjetas ---------- */

  function makeCard(data) {
    var card = {
      id: data.id,
      group: data.group,
      name: data.name,
      state: STATES.indexOf(data.state) !== -1 ? data.state : 'todo',
      custom: !!data.custom,
      el: null
    };
    card.el = buildCardEl(card);
    cards.push(card);
    return card;
  }

  function buildCardEl(card) {
    var li = document.createElement('li');
    li.className = 'card';
    li.dataset.id = card.id;
    li.setAttribute('draggable', 'true');

    var name = document.createElement('span');
    name.className = 'card__name';
    name.textContent = card.name;

    var actions = document.createElement('span');
    actions.className = 'card__actions';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', 'Acciones de ' + card.name);

    actions.appendChild(makeButton('act act--edit', '✏️', 'Editar ' + card.name, { action: 'edit' }));
    actions.appendChild(makeButton('act act--del', '🗑️', 'Eliminar ' + card.name, { action: 'delete' }));

    li.appendChild(name);
    li.appendChild(actions);
    return li;
  }

  function makeButton(className, icon, label, dataset) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = icon;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    Object.keys(dataset).forEach(function (k) { btn.dataset[k] = dataset[k]; });
    return btn;
  }

  function refreshCardEl(card) {
    card.el.querySelector('.card__name').textContent = card.name;
    card.el.querySelector('.card__actions').setAttribute('aria-label', 'Acciones de ' + card.name);
    card.el.querySelectorAll('.act').forEach(function (btn) {
      if (btn.dataset.action === 'edit') {
        btn.setAttribute('aria-label', 'Editar ' + card.name);
        btn.title = 'Editar ' + card.name;
      } else {
        btn.setAttribute('aria-label', 'Eliminar ' + card.name);
        btn.title = 'Eliminar ' + card.name;
      }
    });
  }

  function flash(card) {
    card.el.classList.remove('card--flash');
    void card.el.offsetWidth;   // reinicia la animación
    card.el.classList.add('card--flash');
  }

  /* ---------- Pintado ---------- */

  function render() {
    var active = document.activeElement;
    var focusId = active && active.closest && active.closest('.card')
      ? active.closest('.card').dataset.id : null;
    var focusSel = focusId && active.dataset.action
      ? '.act--' + (active.dataset.action === 'edit' ? 'edit' : 'del')
      : null;

    cards
      .slice()
      .sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); })
      .forEach(function (card) {
        lists[card.group + ':' + card.state].appendChild(card.el);
        refreshCardEl(card);
      });

    Object.keys(lists).forEach(function (key) {
      var ul = lists[key];
      var state = key.split(':')[1];
      var placeholder = ul.querySelector('.empty');
      var total = ul.querySelectorAll('.card').length;

      if (placeholder) { ul.removeChild(placeholder); }

      var counter = ul.closest('.column').querySelector('.count');
      if (counter) { counter.textContent = total; }

      if (total === 0) {
        var li = document.createElement('li');
        li.className = 'empty';
        li.textContent = EMPTY[state];
        ul.appendChild(li);
      }
    });

    // El navegador puede perder el foco al mover la tarjeta de columna
    if (focusSel) {
      var card = byId(focusId);
      var btn = card && card.el.querySelector(focusSel);
      if (btn) { btn.focus(); }
    }
  }

  /* ---------- Acciones ---------- */

  function setState(card, state) {
    if (!card || card.state === state || STATES.indexOf(state) === -1) { return; }
    card.state = state;
    flash(card);
    render();
    persist();
  }

  function removeCard(card) {
    if (!card) { return; }
    if (!window.confirm('¿Eliminar «' + card.name + '»?')) { return; }
    cards.splice(cards.indexOf(card), 1);
    if (card.el.parentNode) { card.el.parentNode.removeChild(card.el); }
    render();
    persist();
  }

  function addCard(group, state, text) {
    var name = cleanName(text);
    if (!name) { return null; }

    var card = makeCard({
      id: group + '/c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      group: group,
      name: name,
      state: state,
      custom: true
    });

    render();
    flash(card);
    persist();
    return card;
  }

  /* ---------- Edición en línea ---------- */

  function startEdit(card) {
    if (!card || card.el.classList.contains('card--editing')) { return; }

    var el = card.el;
    var hidden = Array.prototype.slice.call(el.children);
    el.classList.add('card--editing');

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'card__input';
    input.value = card.name;
    input.setAttribute('aria-label', 'Editar alimento');
    input.maxLength = 60;

    var done = false;

    function close(save) {
      if (done) { return; }
      done = true;

      if (save) {
        var name = cleanName(input.value);
        if (name) { card.name = name; }
      }

      el.removeChild(input);
      hidden.forEach(function (node) { node.hidden = false; });
      el.classList.remove('card--editing');
      refreshCardEl(card);

      if (save) { render(); persist(); }
      repaintPending();   // lo que llegó de la nube mientras se editaba
    }

    hidden.forEach(function (node) { node.hidden = true; });
    el.appendChild(input);
    input.focus();
    input.select();

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      else if (e.key === 'Escape') { e.preventDefault(); close(false); }
    });
    input.addEventListener('blur', function () { close(true); });
  }

  /* ---------- Formulario de "añadir" por columna ---------- */

  function buildAdder(column, group, state) {
    var wrap = document.createElement('div');
    wrap.className = 'adder';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'adder__btn';
    btn.textContent = '+ Añadir alimento';
    btn.setAttribute('aria-label', 'Añadir alimento a ' + LABELS[state]);

    var form = document.createElement('form');
    form.className = 'adder__form';
    form.hidden = true;

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'adder__input';
    input.placeholder = 'Ej. Aguacate';
    input.setAttribute('aria-label', 'Nombre del alimento');
    input.maxLength = 60;

    var ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'adder__ok';
    ok.textContent = 'Añadir';

    form.appendChild(input);
    form.appendChild(ok);
    wrap.appendChild(btn);
    wrap.appendChild(form);
    column.insertBefore(wrap, column.querySelector('.cards'));   // arriba, antes de la lista

    function open() {
      form.hidden = false;
      btn.hidden = true;
      input.focus();
    }

    function close() {
      form.hidden = true;
      btn.hidden = false;
      input.value = '';
    }

    btn.addEventListener('click', open);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (addCard(group, state, input.value)) {
        input.value = '';
        input.focus();          // se queda abierto para encadenar altas
      }
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
    });

    input.addEventListener('blur', function () {
      // Se cierra solo si no hay nada escrito y el foco sale del formulario
      window.setTimeout(function () {
        if (!form.contains(document.activeElement) && !input.value.trim()) { close(); }
      }, 120);
    });
  }

  /* ---------- Recetario ---------- */

  var recipes = [];
  var editingRecipe = null;
  var ui = {};

  /* Etiquetas permitidas en el campo con formato de "Preparación" */
  var ALLOWED_TAGS = {
    B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1,
    UL: 1, OL: 1, LI: 1, P: 1, BR: 1, DIV: 1, SPAN: 1
  };

  /* Deja solo etiquetas de formato y sin atributos */
  function sanitizeHtml(html) {
    var box = document.createElement('div');
    box.innerHTML = String(html || '');   // asignar innerHTML no ejecuta scripts

    (function clean(node) {
      var child = node.firstChild;

      while (child) {
        var next = child.nextSibling;

        if (child.nodeType === 3) {
          /* texto: se conserva */
        } else if (child.nodeType !== 1 || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') {
          node.removeChild(child);
        } else if (!ALLOWED_TAGS[child.tagName]) {
          var first = child.firstChild;
          while (child.firstChild) { node.insertBefore(child.firstChild, child); }
          node.removeChild(child);
          next = first || next;          // se revisa también lo desenvuelto
        } else {
          Array.prototype.slice.call(child.attributes).forEach(function (attr) {
            child.removeAttribute(attr.name);
          });
          clean(child);
        }

        child = next;
      }
    }(box));

    return box.innerHTML;
  }

  function htmlIsEmpty(html) {
    var box = document.createElement('div');
    box.innerHTML = String(html || '');
    return !box.textContent.replace(/\u00a0/g, ' ').trim() && !box.querySelector('li, br');
  }

  /* Las recetas antiguas guardaban texto plano */
  function stepsHtmlOf(recipe) {
    if (recipe.rich) { return sanitizeHtml(recipe.steps); }

    var box = document.createElement('div');
    box.textContent = String(recipe.steps || '');
    return box.innerHTML.replace(/\n/g, '<br>');
  }

  function loadRecipes() {
    return mapToList(storeGet(S_RECIPES))
      .filter(function (r) { return r && r.id && r.name; });
  }

  function saveRecipes() {
    storeCommit(S_RECIPES, listToMap(recipes));
  }

  /* ---------- Pantallas del recetario ---------- */

  var currentRecipe = null;   // receta abierta en la pantalla de detalle
  var formReturnsTo = 'list'; // a dónde vuelve el formulario al cerrarse

  function showView(name) {
    Object.keys(ui.views).forEach(function (key) {
      ui.views[key].hidden = (key !== name);
    });
    ui.current = name;
  }

  function ingredientsOf(recipe) {
    return String(recipe.ingredients || '')
      .split('\n')
      .map(function (line) { return line.replace(/^[-•*]\s*/, '').trim(); })
      .filter(Boolean);
  }

  /* ---------- Pantalla 1: listado ---------- */

  function buildRecipeRow(recipe) {
    var li = document.createElement('li');
    li.className = 'recipe-row';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recipe-row__btn';
    btn.dataset.id = recipe.id;

    var name = document.createElement('span');
    name.className = 'recipe-row__name';
    name.textContent = recipe.name;

    var time = null;
    if (recipe.time) {
      time = document.createElement('span');
      time.className = 'recipe-row__time';
      time.textContent = '⏱ ' + recipe.time;
    }

    var chevron = document.createElement('span');
    chevron.className = 'recipe-row__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';

    btn.appendChild(name);
    if (time) { btn.appendChild(time); }
    btn.appendChild(chevron);
    li.appendChild(btn);
    return li;
  }

  function renderRecipes() {
    ui.list.textContent = '';

    if (!recipes.length) {
      var empty = document.createElement('li');
      empty.className = 'recipe-empty';
      empty.textContent = 'Todavía no has guardado ninguna receta.';
      ui.list.appendChild(empty);
      return;
    }

    recipes
      .slice()
      .sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); })
      .forEach(function (recipe) { ui.list.appendChild(buildRecipeRow(recipe)); });
  }

  /* ---------- Pantalla 2: detalle ---------- */

  function renderDetail(recipe) {
    currentRecipe = recipe;
    ui.detailTitle.textContent = recipe.name;
    ui.detail.textContent = '';

    if (recipe.time) {
      var meta = document.createElement('p');
      meta.className = 'recipe__meta';
      meta.textContent = '⏱ ' + recipe.time;
      ui.detail.appendChild(meta);
    }

    var ingredients = ingredientsOf(recipe);

    if (ingredients.length) {
      var ingTitle = document.createElement('p');
      ingTitle.className = 'recipe__section';
      ingTitle.textContent = 'Ingredientes';
      ui.detail.appendChild(ingTitle);

      var ul = document.createElement('ul');
      ul.className = 'recipe__ing';
      ingredients.forEach(function (item) {
        var entry = document.createElement('li');
        entry.textContent = item;
        ul.appendChild(entry);
      });
      ui.detail.appendChild(ul);
    }

    var stepsHtml = stepsHtmlOf(recipe);

    if (!htmlIsEmpty(stepsHtml)) {
      var stepsTitle = document.createElement('p');
      stepsTitle.className = 'recipe__section';
      stepsTitle.textContent = 'Preparación';
      ui.detail.appendChild(stepsTitle);

      var steps = document.createElement('div');
      steps.className = 'recipe__steps';
      steps.innerHTML = stepsHtml;      // ya saneado
      ui.detail.appendChild(steps);
    }

    if (!ui.detail.children.length) {
      var blank = document.createElement('p');
      blank.className = 'recipe-empty';
      blank.textContent = 'Esta receta todavía no tiene ingredientes ni preparación.';
      ui.detail.appendChild(blank);
    }

    showView('detail');
  }

  function openRecipe(id) {
    for (var i = 0; i < recipes.length; i++) {
      if (recipes[i].id === id) { renderDetail(recipes[i]); return; }
    }
  }

  /* ---------- Pantalla 3: formulario ---------- */

  function openRecipeForm(recipe) {
    editingRecipe = recipe || null;
    formReturnsTo = recipe ? 'detail' : 'list';

    ui.formTitle.textContent = recipe ? 'Editar receta' : 'Nueva receta';
    ui.name.value = recipe ? recipe.name : '';
    ui.time.value = recipe ? (recipe.time || '') : '';
    ui.ingredients.value = recipe ? (recipe.ingredients || '') : '';
    ui.steps.innerHTML = recipe ? stepsHtmlOf(recipe) : '';

    showView('form');
    ui.name.focus();
  }

  function closeRecipeForm() {
    var back = formReturnsTo;

    editingRecipe = null;
    ui.form.reset();
    ui.steps.innerHTML = '';       // el contenteditable no lo limpia reset()

    if (back === 'detail' && currentRecipe) { renderDetail(currentRecipe); }
    else { showView('list'); }

    repaintPending();   // lo que llegó de la nube mientras se editaba
  }

  function submitRecipe(e) {
    e.preventDefault();

    var name = cleanName(ui.name.value);
    if (!name) { ui.name.focus(); return; }

    var steps = sanitizeHtml(ui.steps.innerHTML);

    var data = {
      name: name,
      time: cleanName(ui.time.value),
      ingredients: ui.ingredients.value.trim(),
      steps: htmlIsEmpty(steps) ? '' : steps,
      rich: true
    };

    var saved;

    if (editingRecipe) {
      editingRecipe.name = data.name;
      editingRecipe.time = data.time;
      editingRecipe.ingredients = data.ingredients;
      editingRecipe.steps = data.steps;
      editingRecipe.rich = true;
      saved = editingRecipe;
    } else {
      data.id = 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      recipes.push(data);
      saved = data;
    }

    editingRecipe = null;
    ui.form.reset();
    ui.steps.innerHTML = '';

    renderRecipes();
    saveRecipes();
    renderDetail(saved);           // tras guardar se muestra la receta
    repaintPending();
  }

  /* "Sopa" -> "Sopa (copia)" -> "Sopa (copia 2)"... */
  function copyName(name) {
    var base = name.replace(/\s*\(copia(?:\s+\d+)?\)$/i, '');

    function taken(candidate) {
      return recipes.some(function (r) { return r.name.toLowerCase() === candidate.toLowerCase(); });
    }

    var candidate = base + ' (copia)';
    var n = 2;
    while (taken(candidate)) {
      candidate = base + ' (copia ' + n + ')';
      n++;
    }
    return candidate;
  }

  function duplicateRecipe(recipe) {
    if (!recipe) { return; }

    var copy = {
      id: 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: copyName(recipe.name),
      time: recipe.time || '',
      ingredients: recipe.ingredients || '',
      steps: recipe.steps || '',
      rich: !!recipe.rich
    };

    recipes.push(copy);
    renderRecipes();
    saveRecipes();
    renderDetail(copy);        // se abre la copia recién creada
  }

  function removeRecipe(recipe) {
    if (!recipe) { return; }
    if (!window.confirm('¿Eliminar la receta «' + recipe.name + '»?')) { return; }

    recipes.splice(recipes.indexOf(recipe), 1);
    if (editingRecipe === recipe) { editingRecipe = null; }
    if (currentRecipe === recipe) { currentRecipe = null; }

    renderRecipes();
    saveRecipes();
    showView('list');
  }

  /* Barra de formato del campo "Preparación" */
  function setupEditor() {
    var bar = ui.form.querySelector('.editor__bar');
    if (!bar) { return; }

    bar.addEventListener('mousedown', function (e) {
      // Evita que el campo pierda la selección al pulsar un botón
      if (e.target.closest('.editor__btn')) { e.preventDefault(); }
    });

    bar.addEventListener('click', function (e) {
      var btn = e.target.closest('.editor__btn');
      if (!btn) { return; }

      ui.steps.focus();
      try {
        document.execCommand(btn.dataset.cmd, false, null);
      } catch (err) {
        /* navegador sin soporte: el texto se guarda igualmente, sin formato */
      }
      syncEditorButtons();
    });

    ['keyup', 'mouseup', 'focus'].forEach(function (evt) {
      ui.steps.addEventListener(evt, syncEditorButtons);
    });

    // Pega siempre como texto plano, para no arrastrar estilos de fuera
    ui.steps.addEventListener('paste', function (e) {
      if (!e.clipboardData) { return; }
      e.preventDefault();
      var text = e.clipboardData.getData('text/plain');
      try {
        document.execCommand('insertText', false, text);
      } catch (err) {
        ui.steps.textContent += text;
      }
    });

    ui.steps.addEventListener('input', function () {
      ui.steps.classList.toggle('is-empty', !ui.steps.textContent.trim() && !ui.steps.querySelector('li'));
    });
  }

  function syncEditorButtons() {
    ui.form.querySelectorAll('.editor__btn').forEach(function (btn) {
      var active = false;
      try { active = document.queryCommandState(btn.dataset.cmd); } catch (e) { active = false; }
      btn.setAttribute('aria-pressed', String(!!active));
    });
  }

  function initRecipes() {
    ui.list = document.getElementById('recipe-list');
    ui.form = document.getElementById('recipe-form');
    ui.newBtn = document.getElementById('recipe-new');
    if (!ui.list || !ui.form || !ui.newBtn) { return; }

    ui.views = {
      list: document.getElementById('view-list'),
      detail: document.getElementById('view-detail'),
      form: document.getElementById('view-form')
    };

    ui.detail = document.getElementById('recipe-detail');
    ui.detailTitle = document.getElementById('detail-title');
    ui.formTitle = document.getElementById('recipe-form-title');
    ui.name = document.getElementById('recipe-name');
    ui.time = document.getElementById('recipe-time');
    ui.ingredients = document.getElementById('recipe-ingredients');
    ui.steps = document.getElementById('recipe-steps');

    recipes = loadRecipes();
    renderRecipes();
    showView('list');
    setupEditor();

    ui.newBtn.addEventListener('click', function () { openRecipeForm(null); });
    ui.form.addEventListener('submit', submitRecipe);
    document.getElementById('recipe-cancel').addEventListener('click', closeRecipeForm);

    document.getElementById('detail-edit').addEventListener('click', function () {
      if (currentRecipe) { openRecipeForm(currentRecipe); }
    });

    document.getElementById('detail-duplicate').addEventListener('click', function () {
      duplicateRecipe(currentRecipe);
    });

    document.getElementById('detail-delete').addEventListener('click', function () {
      removeRecipe(currentRecipe);
    });

    /* Botones "←" de las cabeceras */
    document.querySelectorAll('#panel-recetario [data-back]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (ui.current === 'form') { closeRecipeForm(); } else { showView('list'); }
      });
    });

    /* Una fila = una receta */
    ui.list.addEventListener('click', function (e) {
      var btn = e.target.closest('.recipe-row__btn');
      if (btn) { openRecipe(btn.dataset.id); }
    });

    ui.form.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closeRecipeForm(); }
    });

  }

  /* Vuelve a pintar el recetario con lo que acaba de llegar de la nube */
  function refreshRecipes() {
    if (!ui.list) { return; }

    recipes = loadRecipes();
    renderRecipes();

    if (currentRecipe) {
      var still = null;
      recipes.forEach(function (r) { if (r.id === currentRecipe.id) { still = r; } });

      if (still) { currentRecipe = still; if (ui.current === 'detail') { renderDetail(still); } }
      else if (ui.current === 'detail') { currentRecipe = null; showView('list'); }
    }
  }


  /* ---------- Ingestas ---------- */

  var INTAKE_TITLES = ['Desayuno', 'Almuerzo', 'Cena', 'Snack'];
  var INTAKE_TITLE = 'Ingesta';   // el título de las ingestas guardadas antes de los botones
  var intakes = [];
  var iu = {};

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Clave del día en formato "AAAA-MM-DD" (hora local, no UTC) */
  function dayKeyOf(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function timeOf(date) {
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  /* Acepta "9:30", "09.30"... y devuelve "09:30"; "" si no es una hora */
  function cleanTime(value) {
    var match = /^\s*(\d{1,2})\s*[:.]?\s*(\d{2})\s*$/.exec(String(value || ''));
    if (!match) { return ''; }

    var hours = Number(match[1]);
    var minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) { return ''; }

    return pad2(hours) + ':' + pad2(minutes);
  }

  /* Acepta "AAAA-MM-DD"; "" si no es una fecha real (p. ej. el 31 de febrero) */
  function cleanDay(value) {
    var match = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(String(value || ''));
    if (!match) { return ''; }

    var key = match[1] + '-' + match[2] + '-' + match[3];
    var date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

    return dayKeyOf(date) === key ? key : '';
  }

  /* Solo valen los cuatro títulos de los botones; "" si es cualquier otra cosa */
  function cleanTitle(value) {
    var text = cleanName(value);
    return INTAKE_TITLES.indexOf(text) === -1 ? '' : text;
  }

  /* Propuesta según la hora, para que dar de alta sea un solo toque */
  function titleForHour(hour) {
    if (hour >= 6 && hour < 12) { return 'Desayuno'; }
    if (hour >= 12 && hour < 17) { return 'Almuerzo'; }
    if (hour >= 20) { return 'Cena'; }
    return 'Snack';
  }

  /* Los botones de título son radios: se leen y se marcan por el nombre del grupo */
  function readChoice(name) {
    var checked = document.querySelector('input[name="' + name + '"]:checked');
    return checked ? checked.value : '';
  }

  function setChoice(name, value) {
    document.querySelectorAll('input[name="' + name + '"]').forEach(function (radio) {
      radio.checked = (radio.value === value);
    });
  }

  /* "2026-09-12" -> Date local (no UTC: si no, se va un día en según qué zona) */
  function dateOf(key) {
    var parts = key.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function upperFirst(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /* "2026-09-12" -> "Hoy", "Ayer" o "Viernes, 12 de septiembre de 2026" */
  function dayLabel(key) {
    var today = new Date();
    if (key === dayKeyOf(today)) { return 'Hoy'; }

    var yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (key === dayKeyOf(yesterday)) { return 'Ayer'; }

    return upperFirst(dateOf(key).toLocaleDateString('es-ES', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    }));
  }

  /* "Hoy", "Ayer" o "Lunes 8": en el resumen, la semana ya dice el mes */
  function dayShort(key) {
    var label = dayLabel(key);
    if (label === 'Hoy' || label === 'Ayer') { return label; }

    var date = dateOf(key);
    return upperFirst(date.toLocaleDateString('es-ES', { weekday: 'long' })) + ' ' + date.getDate();
  }

  /* Clave de la semana a la que pertenece un día: su lunes */
  function weekKeyOf(key) {
    var date = dateOf(key);
    date.setDate(date.getDate() - (date.getDay() + 6) % 7);   // getDay(): 0 = domingo
    return dayKeyOf(date);
  }

  /* "Del 8 al 14 de septiembre de 2026", con mes o año a los dos lados si cambian */
  function weekLabel(key) {
    var start = dateOf(key);
    var end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);

    var sameYear = start.getFullYear() === end.getFullYear();
    var sameMonth = sameYear && start.getMonth() === end.getMonth();

    var from = sameMonth
      ? String(start.getDate())
      : start.toLocaleDateString('es-ES', sameYear
        ? { day: 'numeric', month: 'long' }
        : { day: 'numeric', month: 'long', year: 'numeric' });

    var to = end.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });

    return 'Del ' + from + ' al ' + to;
  }

  function loadIntakes() {
    return mapToList(storeGet(S_INTAKES))
      .filter(function (item) { return item && item.id && cleanDay(item.day) && cleanTime(item.time); })
      .map(function (item) {
        return {
          id: item.id,
          day: cleanDay(item.day),
          time: cleanTime(item.time),
          title: cleanName(item.title) || INTAKE_TITLE
        };
      });
  }

  function saveIntakes() {
    storeCommit(S_INTAKES, listToMap(intakes));
  }

  function intakeById(id) {
    for (var i = 0; i < intakes.length; i++) {
      if (intakes[i].id === id) { return intakes[i]; }
    }
    return null;
  }

  /* Momento de una ingesta en minutos, para poder restar dos.
     En UTC a propósito: así un cambio de hora no inventa ni se come una hora. */
  function minutesOf(intake) {
    var day = intake.day.split('-');
    var time = intake.time.split(':');

    return Date.UTC(
      Number(day[0]), Number(day[1]) - 1, Number(day[2]),
      Number(time[0]), Number(time[1])
    ) / 60000;
  }

  /* 234 -> "3 h 54 min"; 45 -> "45 min"; 120 -> "2 h" */
  function gapLabel(minutes) {
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;

    if (hours && rest) { return hours + ' h ' + rest + ' min'; }
    if (hours) { return hours + ' h'; }
    return rest + ' min';
  }

  /* Como en el listado de recetas: la fila entera es el botón que abre el modal.
     `gap` son los minutos desde la ingesta anterior; la primera de todas no tiene. */
  function buildIntakeRow(intake, gap) {
    var li = document.createElement('li');
    li.className = 'intake-row';

    var label = 'Editar ' + intake.title + ' de las ' + intake.time;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'intake-row__btn';
    btn.dataset.id = intake.id;

    var time = document.createElement('span');
    time.className = 'intake-row__time';
    time.textContent = intake.time;

    var title = document.createElement('span');
    title.className = 'intake-row__title';
    title.textContent = intake.title;

    var text = document.createElement('span');
    text.className = 'intake-row__text';
    text.appendChild(title);

    if (typeof gap === 'number') {
      var since = document.createElement('span');
      since.className = 'intake-row__gap';
      since.textContent = 'Después de ' + gapLabel(gap);
      text.appendChild(since);

      /* El aria-label tapa el contenido: si no se repite aquí, no se lee */
      label += ', después de ' + gapLabel(gap);
    }

    btn.setAttribute('aria-label', label);

    btn.appendChild(time);
    btn.appendChild(text);

    li.appendChild(btn);
    return li;
  }

  function buildIntakeDay(key, list, gaps) {
    var section = document.createElement('section');
    section.className = 'intake-day';

    var head = document.createElement('header');
    head.className = 'intake-day__head';

    var title = document.createElement('h2');
    title.textContent = dayLabel(key);

    var count = document.createElement('span');
    count.className = 'count';
    count.textContent = list.length;

    head.appendChild(title);
    head.appendChild(count);

    var ul = document.createElement('ul');
    ul.className = 'intake-list';
    list.forEach(function (intake) { ul.appendChild(buildIntakeRow(intake, gaps[intake.id])); });

    section.appendChild(head);
    section.appendChild(ul);
    return section;
  }

  function emptyIntakes() {
    var p = document.createElement('p');
    p.className = 'recipe-empty';
    p.textContent = 'Todavía no has registrado ninguna ingesta.';
    return p;
  }

  /* Las dos subpestañas se pintan siempre; cuál se ve lo decide el CSS */
  function renderIntakes() {
    renderHistory();
    renderSummary();
  }

  function renderHistory() {
    iu.days.textContent = '';

    if (!intakes.length) {
      iu.keys = [];
      if (iu.pager) { iu.pager.hidden = true; }
      iu.days.appendChild(emptyIntakes());
      return;
    }

    /* De la más antigua a la más reciente: así cada una sabe cuánto pasó desde
       la anterior, y de paso cada día queda ya ordenado por hora ascendente */
    var ordered = intakes.slice().sort(function (a, b) {
      return minutesOf(a) - minutesOf(b);
    });

    /* Los huecos se calculan sobre todas, no solo sobre el día que se ve:
       la primera ingesta del día se mide contra la última de la víspera */
    var gaps = {};
    ordered.forEach(function (intake, i) {
      if (i > 0) { gaps[intake.id] = minutesOf(intake) - minutesOf(ordered[i - 1]); }
    });

    var days = {};

    iu.keys = [];

    ordered.forEach(function (intake) {
      if (!days[intake.day]) { days[intake.day] = []; iu.keys.push(intake.day); }
      days[intake.day].push(intake);
    });

    iu.keys.sort().reverse();       // el día más reciente, primero

    /* Se ve un día cada vez; si el que se estaba viendo ya no existe, el más reciente */
    var index = iu.keys.indexOf(iu.day);
    if (index === -1) { index = 0; }
    iu.day = iu.keys[index];

    renderIntakePager(index);
    iu.days.appendChild(buildIntakeDay(iu.day, days[iu.day], gaps));
  }

  function renderIntakePager(index) {
    if (!iu.pager) { return; }

    iu.pager.hidden = iu.keys.length < 2;    // con un solo día no hay nada que paginar
    iu.pos.textContent = (index + 1) + ' de ' + iu.keys.length;
    iu.prev.disabled = index === 0;
    iu.next.disabled = index >= iu.keys.length - 1;
  }

  /* -1 va hacia los días más recientes; +1, hacia los más antiguos */
  function goToDay(step) {
    var index = iu.keys.indexOf(iu.day) + step;
    if (index < 0 || index >= iu.keys.length) { return; }

    iu.day = iu.keys[index];
    renderHistory();
  }

  /* ---------- Resumen: una tarjeta por día, paginado por semanas ---------- */

  function buildSummaryRow(key, total) {
    var li = document.createElement('li');
    li.className = 'summary-row';

    var day = document.createElement('span');
    day.className = 'summary-row__day';
    day.textContent = dayShort(key);

    var count = document.createElement('span');
    count.className = 'count';
    count.textContent = total;

    li.appendChild(day);
    li.appendChild(count);
    return li;
  }

  function renderSummary() {
    if (!iu.summary) { return; }

    iu.summary.textContent = '';

    if (!intakes.length) {
      iu.weeks = [];
      if (iu.summaryPager) { iu.summaryPager.hidden = true; }
      iu.summary.appendChild(emptyIntakes());
      return;
    }

    /* Cuántas ingestas tiene cada día, y a qué semana va cada día */
    var totals = {};
    var weeks = {};

    iu.weeks = [];

    intakes.forEach(function (intake) {
      var week = weekKeyOf(intake.day);

      if (!totals[intake.day]) {
        totals[intake.day] = 0;
        if (!weeks[week]) { weeks[week] = []; iu.weeks.push(week); }
        weeks[week].push(intake.day);
      }

      totals[intake.day] += 1;
    });

    iu.weeks.sort().reverse();      // la semana más reciente, primero

    var index = iu.weeks.indexOf(iu.week);
    if (index === -1) { index = 0; }
    iu.week = iu.weeks[index];

    renderSummaryPager(index);

    var head = document.createElement('header');
    head.className = 'intake-day__head';

    var title = document.createElement('h2');
    title.textContent = weekLabel(iu.week);
    head.appendChild(title);

    var ul = document.createElement('ul');
    ul.className = 'summary-list';

    /* Dentro de la semana, de lunes a domingo */
    weeks[iu.week].sort().forEach(function (key) {
      ul.appendChild(buildSummaryRow(key, totals[key]));
    });

    iu.summary.appendChild(head);
    iu.summary.appendChild(ul);
  }

  function renderSummaryPager(index) {
    if (!iu.summaryPager) { return; }

    iu.summaryPager.hidden = iu.weeks.length < 2;
    iu.summaryPos.textContent = (index + 1) + ' de ' + iu.weeks.length;
    iu.summaryPrev.disabled = index === 0;
    iu.summaryNext.disabled = index >= iu.weeks.length - 1;
  }

  function goToWeek(step) {
    var index = iu.weeks.indexOf(iu.week) + step;
    if (index < 0 || index >= iu.weeks.length) { return; }

    iu.week = iu.weeks[index];
    renderSummary();
  }

  function addIntake(dayValue, timeValue, titleValue) {
    var day = cleanDay(dayValue);
    var time = cleanTime(timeValue);
    var title = cleanTitle(titleValue);
    if (!day || !time || !title) { return false; }

    intakes.push({
      id: 'i-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      day: day,
      time: time,
      title: title
    });

    iu.day = day;                   // se salta al día de lo que se acaba de guardar
    iu.week = weekKeyOf(day);
    renderIntakes();
    saveIntakes();
    return true;
  }

  /* ---------- Modal: la única forma de dar de alta y de editar ---------- */

  /* El mismo modal da de alta y edita: con ingesta se edita, sin ella se crea */
  function openIntakeModal(intake) {
    var editing = intake || null;
    var now = new Date();
    var day = editing ? editing.day : dayKeyOf(now);
    var time = editing ? editing.time : timeOf(now);

    /* Creando no se marca nada: el tipo se elige a mano. Editando se marca el suyo,
       y si es de las viejas («Ingesta») se propone el que le toca por la hora. */
    var title = editing
      ? (cleanTitle(editing.title) || titleForHour(Number(time.slice(0, 2))))
      : '';

    iu.editing = editing;
    iu.modalHead.textContent = editing ? 'Editar ingesta' : 'Nueva ingesta';
    iu.modalDelete.hidden = !editing;          // solo se puede borrar lo que ya existe
    iu.modalDate.value = day;
    iu.modalTime.value = time;

    if (iu.modalType) { iu.modalType.classList.remove('choices--error'); }
    setChoice('intake-modal-title', title);

    if (typeof iu.modal.showModal === 'function') { iu.modal.showModal(); }
    else { iu.modal.setAttribute('open', ''); }   // navegador sin <dialog>

    iu.modalTime.focus();
  }

  function closeIntakeModal() {
    iu.editing = null;

    if (typeof iu.modal.close === 'function') {
      iu.modal.close();          // <dialog> devuelve el foco al FAB por su cuenta
    } else {
      iu.modal.removeAttribute('open');
      iu.fab.focus();
    }

    repaintPending();            // lo que llegó de la nube con el modal abierto
  }

  /* Al guardar desde el FAB se salta a Ingestas para ver el registro */
  function showIntakesTab() {
    var tab = document.getElementById('tab-ingestas');
    if (!tab) { return; }
    tab.checked = true;          // marcarlo por código no dispara 'change'
    saveTab(tab.id);
  }

  /* Sin tipo no se guarda: se marca el campo en rojo y se lleva el foco al primero.
     Los radios no llevan `required` porque, al estar ocultos, el navegador no puede
     enfocarlos para su aviso nativo y se queda sin poder enviar el formulario. */
  function markTypeMissing() {
    var first = document.querySelector('input[name="intake-modal-title"]');

    if (iu.modalType) { iu.modalType.classList.add('choices--error'); }
    if (first) { first.focus(); }
  }

  function submitIntakeModal(e) {
    e.preventDefault();

    var day = cleanDay(iu.modalDate.value);
    if (!day) { iu.modalDate.focus(); return; }

    var time = cleanTime(iu.modalTime.value);
    if (!time) { iu.modalTime.focus(); return; }

    /* Ya no viene nada preseleccionado, así que el tipo hay que elegirlo */
    var title = cleanTitle(readChoice('intake-modal-title'));
    if (!title) { markTypeMissing(); return; }

    /* Al editar no se salta de pestaña: ya estamos viendo el registro */
    if (iu.editing) {
      iu.editing.day = day;
      iu.editing.time = time;
      iu.editing.title = title;
      iu.day = day;                 // si se ha movido de día, se sigue hasta allí
      iu.week = weekKeyOf(day);
      renderIntakes();
      saveIntakes();
      closeIntakeModal();
      return;
    }

    addIntake(day, time, title);
    closeIntakeModal();
    showIntakesTab();
  }

  /* Devuelve si se llegó a borrar: en el modal hace falta para saber si cerrarlo */
  function removeIntake(intake) {
    if (!intake) { return false; }
    if (!window.confirm('¿Eliminar ' + intake.title + ' de las ' + intake.time + '?')) { return false; }

    intakes.splice(intakes.indexOf(intake), 1);
    renderIntakes();
    saveIntakes();
    return true;
  }

  function initIntakes() {
    iu.days = document.getElementById('intake-days');
    if (!iu.days) { return; }

    /* Historial: un día cada vez, empezando por el más reciente */
    iu.pager = document.getElementById('intake-pager');
    iu.pos = document.getElementById('intake-pos');
    iu.prev = document.getElementById('intake-prev');
    iu.next = document.getElementById('intake-next');

    if (iu.pager) {
      iu.prev.addEventListener('click', function () { goToDay(-1); });
      iu.next.addEventListener('click', function () { goToDay(1); });
    }

    /* Resumen: una semana cada vez, también de la más reciente hacia atrás */
    iu.summary = document.getElementById('summary');
    iu.summaryPager = document.getElementById('summary-pager');
    iu.summaryPos = document.getElementById('summary-pos');
    iu.summaryPrev = document.getElementById('summary-prev');
    iu.summaryNext = document.getElementById('summary-next');

    if (iu.summaryPager) {
      iu.summaryPrev.addEventListener('click', function () { goToWeek(-1); });
      iu.summaryNext.addEventListener('click', function () { goToWeek(1); });
    }

    intakes = loadIntakes();
    renderIntakes();

    /* Sin modal no hay alta ni edición, pero el registro se sigue viendo */
    iu.modal = document.getElementById('intake-modal');
    if (!iu.modal) { return; }

    iu.fab = document.getElementById('intake-fab');
    iu.newBtn = document.getElementById('intake-new');
    iu.modalForm = document.getElementById('intake-modal-form');
    iu.modalDate = document.getElementById('intake-modal-date');
    iu.modalTime = document.getElementById('intake-modal-time');
    iu.modalHead = document.getElementById('intake-modal-title');
    iu.modalType = document.getElementById('intake-modal-type');
    iu.modalDelete = document.getElementById('intake-modal-delete');

    /* En cuanto se elige un tipo, se retira el aviso de que faltaba */
    if (iu.modalType) {
      iu.modalType.addEventListener('change', function () {
        iu.modalType.classList.remove('choices--error');
      });
    }

    /* Dos puertas de entrada al mismo modal: el botón del panel y el FAB */
    if (iu.newBtn) { iu.newBtn.addEventListener('click', function () { openIntakeModal(); }); }
    if (iu.fab) { iu.fab.addEventListener('click', function () { openIntakeModal(); }); }

    iu.modalForm.addEventListener('submit', submitIntakeModal);
    document.getElementById('intake-modal-close').addEventListener('click', closeIntakeModal);
    document.getElementById('intake-modal-cancel').addEventListener('click', closeIntakeModal);

    iu.modalDelete.addEventListener('click', function () {
      if (removeIntake(iu.editing)) { closeIntakeModal(); }
    });

    /* Clic en el fondo oscuro = cerrar (Esc ya lo gestiona <dialog>) */
    iu.modal.addEventListener('click', function (e) {
      if (e.target === iu.modal) { closeIntakeModal(); }
    });

    /* Cerrar con Esc no pasa por closeIntakeModal(): hay que soltar la edición igual */
    iu.modal.addEventListener('close', function () {
      iu.editing = null;
      repaintPending();
    });

    /* Pulsar cualquier punto de la fila abre el modal para editarla */
    iu.days.addEventListener('click', function (e) {
      var btn = e.target.closest('.intake-row__btn');
      if (!btn) { return; }

      var intake = intakeById(btn.dataset.id);
      if (intake) { openIntakeModal(intake); }
    });
  }

  /* Vuelve a pintar el registro con lo que acaba de llegar de la nube */
  function refreshIntakes() {
    if (!iu.days) { return; }
    intakes = loadIntakes();
    renderIntakes();
  }


  /* ---------- Ajustes: exportar e importar ---------- */

  var BACKUP_APP = 'misAlimentos';   // marca del archivo, para no importar cualquier JSON
  var su = {};

  /* Todo lo guardado en un único objeto. Las preferencias de la interfaz
     (pestaña activa, secciones abiertas) se quedan fuera a propósito:
     son de este navegador, no datos que merezca la pena llevarse. */
  function backupData() {
    return {
      app: BACKUP_APP,
      version: 1,
      exported: new Date().toISOString(),
      alimentos: { version: 2, items: storeCopy(S_FOODS) },
      recetas: mapToList(storeGet(S_RECIPES)),
      ingestas: mapToList(storeGet(S_INTAKES))
    };
  }

  /* Descarga de toda la vida: el archivo cae donde diga el navegador */
  function downloadFile(text, name) {
    var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    var link = document.createElement('a');

    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    /* La URL tiene que seguir viva hasta que arranca la descarga */
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* Preguntar dónde guardar solo lo permite showSaveFilePicker() (Chrome y Edge,
     y solo si la página se sirve por http(s); abierta como file:// suele fallar).
     Donde no lo haya —o falle— se cae a la descarga normal, sin molestar. */
  function exportData() {
    var text = JSON.stringify(backupData(), null, 2);
    var name = 'alimentacion-' + dayKeyOf(new Date()) + '.json';

    if (typeof window.showSaveFilePicker !== 'function') {
      downloadFile(text, name);
      settingsMsg('Archivo descargado.');
      return;
    }

    window.showSaveFilePicker({
      suggestedName: name,
      types: [{
        description: 'Copia de la app (JSON)',
        accept: { 'application/json': ['.json'] }
      }]
    }).then(function (handle) {
      return handle.createWritable().then(function (stream) {
        return stream.write(text).then(function () { return stream.close(); });
      });
    }).then(function () {
      settingsMsg('Archivo guardado.');
    }).catch(function (e) {
      /* Cancelar el diálogo no es un error: no se guarda nada y no se dice nada */
      if (e && e.name === 'AbortError') { settingsMsg(''); return; }
      downloadFile(text, name);
      settingsMsg('No se ha podido elegir la carpeta: el archivo está en tus descargas.');
    });
  }

  /* Se queda solo con lo que reconoce y lo valida igual que al cargarlo de
     el almacén; devuelve null si el archivo no es una copia de la app. */
  function readBackup(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return null; }
    if (!data || typeof data !== 'object' || data.app !== BACKUP_APP) { return null; }

    var backup = {};

    if (data.alimentos && typeof data.alimentos === 'object' &&
        data.alimentos.items && typeof data.alimentos.items === 'object') {
      backup.alimentos = { version: 2, items: data.alimentos.items };
    }

    if (Array.isArray(data.recetas)) {
      backup.recetas = data.recetas
        .filter(function (r) { return r && r.id && r.name; })
        .map(function (r) {
          return {
            id: String(r.id),
            name: cleanName(r.name),
            time: cleanName(r.time),
            ingredients: String(r.ingredients || ''),
            /* El HTML que viene de fuera pasa por el mismo filtro que el de dentro */
            steps: r.rich ? sanitizeHtml(r.steps) : String(r.steps || ''),
            rich: !!r.rich
          };
        });
    }

    if (Array.isArray(data.ingestas)) {
      backup.ingestas = data.ingestas
        .filter(function (i) { return i && i.id && cleanDay(i.day) && cleanTime(i.time); })
        .map(function (i) {
          return {
            id: String(i.id),
            day: cleanDay(i.day),
            time: cleanTime(i.time),
            title: cleanName(i.title) || INTAKE_TITLE
          };
        });
    }

    return Object.keys(backup).length ? backup : null;
  }

  /* "los alimentos, 4 recetas y 12 ingestas", para el aviso de confirmación */
  function backupSummary(backup) {
    var parts = [];

    if (backup.alimentos) { parts.push('los alimentos'); }
    if (backup.recetas) {
      parts.push(backup.recetas.length + (backup.recetas.length === 1 ? ' receta' : ' recetas'));
    }
    if (backup.ingestas) {
      parts.push(backup.ingestas.length + (backup.ingestas.length === 1 ? ' ingesta' : ' ingestas'));
    }

    if (parts.length < 2) { return parts[0] || ''; }
    return parts.slice(0, -1).join(', ') + ' y ' + parts[parts.length - 1];
  }

  /* Escribe solo las secciones que trae el archivo: una copia sin recetas
     no se lleva por delante las que ya haya guardadas. Como cualquier otro
     cambio, va al almacén local y a la nube. */
  function writeBackup(backup) {
    if (backup.alimentos) { storeCommit(S_FOODS, backup.alimentos.items); }
    if (backup.recetas) { storeCommit(S_RECIPES, listToMap(backup.recetas)); }
    if (backup.ingestas) { storeCommit(S_INTAKES, listToMap(backup.ingestas)); }
  }

  function settingsMsg(text, bad) {
    if (!su.msg) { return; }
    su.msg.textContent = text || '';
    su.msg.classList.toggle('settings-msg--bad', !!bad);
  }

  function importFile(file) {
    if (!file) { return; }

    var reader = new FileReader();

    reader.onload = function () {
      var backup = readBackup(reader.result);
      if (!backup) {
        settingsMsg('Ese archivo no es una copia de esta app.', true);
        return;
      }

      var what = backupSummary(backup);
      if (!window.confirm('Se sustituirán ' + what + ' por lo que trae el archivo. ' +
                          'Lo que tengas guardado ahora se perderá. ¿Continuar?')) {
        settingsMsg('');
        return;
      }

      writeBackup(backup);

      /* Se repintan las tres secciones en vez de recargar la página: recargar
         cortaría las escrituras que aún van camino de la nube. */
      if (backup.alimentos) { rebuildCards(); }
      if (backup.recetas) { refreshRecipes(); }
      if (backup.ingestas) { refreshIntakes(); }

      settingsMsg('Datos importados.');
    };

    reader.onerror = function () { settingsMsg('No se ha podido leer el archivo.', true); };
    reader.readAsText(file);
  }

  function openSettingsModal() {
    settingsMsg('');
    syncStatus();      // el estado de la nube, al día cada vez que se abre

    /* En móvil el cajón sigue abierto detrás: se cierra al abrir el modal */
    var toggle = document.getElementById('nav-toggle');
    if (toggle) { toggle.checked = false; }

    if (typeof su.modal.showModal === 'function') { su.modal.showModal(); }
    else { su.modal.setAttribute('open', ''); }   // navegador sin <dialog>
  }

  function closeSettingsModal() {
    if (typeof su.modal.close === 'function') {
      su.modal.close();          // <dialog> devuelve el foco al botón por su cuenta
    } else {
      su.modal.removeAttribute('open');
      su.openBtn.focus();
    }
  }

  function initSettings() {
    su.modal = document.getElementById('settings-modal');
    su.openBtn = document.getElementById('settings-open');
    if (!su.modal || !su.openBtn) { return; }

    su.msg = document.getElementById('settings-msg');
    su.file = document.getElementById('settings-file');

    su.openBtn.addEventListener('click', openSettingsModal);
    document.getElementById('settings-close').addEventListener('click', closeSettingsModal);

    /* El mensaje lo pone exportData(): con selector de carpeta, tarda lo que tarde */
    document.getElementById('settings-export').addEventListener('click', exportData);

    /* El <input type="file"> está oculto: se abre desde el botón */
    document.getElementById('settings-import').addEventListener('click', function () {
      su.file.click();
    });

    su.file.addEventListener('change', function () {
      importFile(su.file.files[0]);
      su.file.value = '';        // así vuelve a saltar 'change' con el mismo archivo
    });

    /* Sesión: cerrarla recarga, para no dejar datos de nadie en pantalla */
    var out = document.getElementById('settings-logout');
    if (out) {
      out.addEventListener('click', function () {
        if (!fauth) { return; }
        fauth.signOut().then(function () { window.location.reload(); });
      });
    }

    /* Clic en el fondo oscuro = cerrar (Esc ya lo gestiona <dialog>) */
    su.modal.addEventListener('click', function (e) {
      if (e.target === su.modal) { closeSettingsModal(); }
    });
  }


  /* ---------- Inicialización ---------- */

  function collectSeeds() {
    document.querySelectorAll('.panel').forEach(function (panel) {
      var group = panel.id.replace(/^panel-/, '');
      if (!panel.querySelector('.board')) { return; }   // p. ej. el recetario

      STATES.forEach(function (state) {
        var column = panel.querySelector('.column--' + state);
        var ul = column.querySelector('.cards');

        column.dataset.state = state;
        column.dataset.group = group;
        lists[group + ':' + state] = ul;

        ul.querySelectorAll('.card').forEach(function (li) {
          var name = cleanName(li.textContent);

          seeds[group + '/' + slug(name)] = {
            group: group,
            name: name,
            state: state
          };
          ul.removeChild(li);   // se vuelve a crear desde los datos
        });

        buildAdder(column, group, state);
      });
    });
  }

  function build(saved) {
    cards.length = 0;

    Object.keys(seeds).forEach(function (id) {
      var seed = seeds[id];
      var rec = saved[id] || {};
      if (rec.deleted) { return; }

      makeCard({
        id: id,
        group: seed.group,
        name: rec.name || seed.name,
        state: rec.state || seed.state,
        custom: false
      });
    });

    Object.keys(saved).forEach(function (id) {
      var rec = saved[id];
      if (!rec || !rec.custom || seeds[id] || !lists[rec.group + ':todo']) { return; }
      makeCard({
        id: id,
        group: rec.group,
        name: rec.name,
        state: rec.state,
        custom: true
      });
    });
  }

  /* Vuelve a pintar los tableros con lo que acaba de llegar de la nube:
     las tarjetas se tiran y se reconstruyen desde los datos. */
  function rebuildCards() {
    cards.forEach(function (card) {
      if (card.el.parentNode) { card.el.parentNode.removeChild(card.el); }
    });

    build(loadData());
    render();
  }

  /* Recuerda en qué pestaña estabas: al recargar se vuelve a ella */
  function saveTab(id) {
    try { localStorage.setItem(TAB_KEY, id); } catch (e) { /* nada que hacer */ }
  }

  function keepTabState() {
    var saved = null;

    try { saved = localStorage.getItem(TAB_KEY); } catch (e) { /* se queda la del HTML */ }

    if (saved) {
      var tab = document.getElementById(saved);
      if (tab && tab.type === 'radio' && tab.classList.contains('tab-state')) { tab.checked = true; }
    }

    document.querySelectorAll('input.tab-state[type="radio"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (radio.checked) { saveTab(radio.id); }
      });
    });
  }

  /* Recuerda qué secciones de la barra lateral quedaron abiertas */
  function keepNavGroupState() {
    document.querySelectorAll('.nav-group[id]').forEach(function (group) {
      var key = NAV_KEY + '.' + group.id;

      try {
        if (localStorage.getItem(key) === 'closed') { group.open = false; }
      } catch (e) { /* sin persistencia: se queda abierta */ }

      group.addEventListener('toggle', function () {
        try { localStorage.setItem(key, group.open ? 'open' : 'closed'); } catch (err) { /* nada que hacer */ }
      });
    });
  }

  /* En móvil el menú se cierra solo al elegir pestaña o al pulsar Escape */
  function closeNavOnPick() {
    var toggle = document.getElementById('nav-toggle');
    if (!toggle) { return; }

    document.querySelectorAll('.nav__item').forEach(function (item) {
      item.addEventListener('click', function () { toggle.checked = false; });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.checked) { toggle.checked = false; }
    });
  }

  function init() {
    keepTabState();              // lo primero, para no enseñar la pestaña equivocada
    collectSeeds();
    build(loadData());
    render();
    initRecipes();
    initIntakes();
    initSettings();
    keepNavGroupState();
    closeNavOnPick();

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.act');
      if (btn) {
        var card = cardOf(btn);
        if (btn.dataset.action === 'edit') { startEdit(card); }
        else if (btn.dataset.action === 'delete') { removeCard(card); }
      }
    });

    /* Doble clic sobre la tarjeta = editar */
    document.addEventListener('dblclick', function (e) {
      if (e.target.closest('.act')) { return; }
      var card = cardOf(e.target);
      if (card) { startEdit(card); }
    });

    /* Arrastrar y soltar */
    document.addEventListener('dragstart', function (e) {
      var el = e.target.closest ? e.target.closest('.card') : null;
      if (!el || el.classList.contains('card--editing')) { return; }
      dragged = byId(el.dataset.id);
      el.classList.add('card--dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', el.dataset.id);
      }
    });

    document.addEventListener('dragend', function (e) {
      var el = e.target.closest ? e.target.closest('.card') : null;
      if (el) { el.classList.remove('card--dragging'); }
      dragged = null;
      document.querySelectorAll('.column--over').forEach(function (c) {
        c.classList.remove('column--over');
      });
    });

    document.addEventListener('dragover', function (e) {
      var column = e.target.closest ? e.target.closest('.column') : null;
      if (!column || !dragged) { return; }
      e.preventDefault();
      if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
      document.querySelectorAll('.column--over').forEach(function (c) {
        if (c !== column) { c.classList.remove('column--over'); }
      });
      column.classList.add('column--over');
    });

    document.addEventListener('dragleave', function (e) {
      var column = e.target.closest ? e.target.closest('.column') : null;
      if (column && !column.contains(e.relatedTarget)) {
        column.classList.remove('column--over');
      }
    });

    document.addEventListener('drop', function (e) {
      var column = e.target.closest ? e.target.closest('.column') : null;
      if (!column || !dragged) { return; }
      e.preventDefault();
      column.classList.remove('column--over');
      if (dragged.group === column.dataset.group) { setState(dragged, column.dataset.state); }
      dragged = null;
    });
  }


  /* =========================================================
     Arranque: primero la sesión, después los datos
     ========================================================= */

  var started = false;
  var signedIn = false;

  /* Se pinta con el respaldo local (instantáneo, funciona sin conexión) y
     después se engancha la nube, que es la copia que manda. El orden importa:
     enganchar la nube antes de leer el almacén local haría que el primer
     snapshot se llevara por delante lo que hubiera guardado aquí. */
  function startApp() {
    if (started) { return; }
    started = true;

    openStore(function () {
      init();
      if (signedIn) { startSync(); }
      syncStatus();
    });
  }

  function sessionEmail(email) {
    var el = document.getElementById('settings-email');
    if (el) { el.textContent = email || '—'; }
  }

  /* Mientras se comprueba la sesión, el HTML lleva la clase `auth-pending` y
     el CSS tapa la app. Al resolverse: sin sesión, `auth-out` saca el login;
     con sesión, fuera las dos y se ve la app. */
  function initAuth() {
    var root = document.documentElement;
    var form = document.getElementById('login-form');
    var error = document.getElementById('login-error');

    /* Sin el SDK (abierta sin conexión, por ejemplo) no hay nube ni login:
       la app funciona con el respaldo local de este dispositivo. */
    if (!window.firebase ||
        typeof window.firebase.initializeApp !== 'function' ||
        typeof window.firebase.database !== 'function' ||
        typeof window.firebase.auth !== 'function') {
      root.classList.remove('auth-pending');
      startApp();
      return;
    }

    try {
      firebase.initializeApp(FB_CONFIG);
      fdb = firebase.database();
      fauth = firebase.auth();
    } catch (e) {
      fdb = null;
      fauth = null;
      syncFail('No se ha podido conectar con la nube: ' + errText(e));
      root.classList.remove('auth-pending');
      startApp();
      return;
    }

    fauth.onAuthStateChanged(function (user) {
      if (user) {
        signedIn = true;
        root.classList.remove('auth-pending');
        root.classList.remove('auth-out');
        sessionEmail(user.email || '');
        startApp();
      } else {
        root.classList.remove('auth-pending');
        root.classList.add('auth-out');
      }
    });

    if (!form) { return; }

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var email = document.getElementById('login-email').value;
      var password = document.getElementById('login-password').value;

      error.textContent = '';

      fauth.signInWithEmailAndPassword(email, password).catch(function (err) {
        var code = err && err.code ? err.code : '';
        error.textContent = code === 'auth/network-request-failed'
          ? 'No hay conexión con la nube.'
          : 'Email o contraseña incorrectos.';
      });
    });
  }

  initAuth();
}());
