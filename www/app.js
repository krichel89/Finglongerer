'use strict';
const core = STCore.createCore(STNative);
const $ = (s, el = document) => el.querySelector(s);
const t = (key, ...a) => STI18n.t(STNative.lang(), key, ...a);   // Sprache: Einstellung oder Systemsprache
// feste Texte der Seite (data-i18n="Schlüssel", data-i18n-ph = Platzhalter, data-i18n-title/-aria = Hinweis/Beschriftung)
function applyStatic() {
  document.documentElement.lang = STNative.lang();
  document.querySelectorAll('[data-i18n]').forEach(e => { e.textContent = t(e.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(e => { e.placeholder = t(e.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach(e => { e.title = t(e.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-aria]').forEach(e => { e.setAttribute('aria-label', t(e.dataset.i18nAria)); });
  document.querySelectorAll('#set-rows [data-f=name]').forEach(e => { e.placeholder = t('ph.name'); });
  document.querySelectorAll('#set-rows [data-f=max]').forEach(e => { e.placeholder = t('ph.max'); });
  if ($('#version').textContent) $('#version').textContent = t('set.version', window.APP_VERSION || '?');
}
applyStatic();
let cfg = {speakers: [], groups: []}, state = [], dragging = false, inflight = 0, cfgSig = '', lastRefresh = 0;
const pending = {};            // Knopf-Schlüssel -> Ablaufzeit (Infinity solange der Befehl läuft)
const balCache = {}, balRead = {}; // pro Gruppe: letzte bekannte Stereopaar-Balance / schon gelesen?
const newId = () => Math.random().toString(36).slice(2, 8);

// ---- gemerkter Zustand der Oberfläche: Reihenfolge, aufgeklappte Einträge
const UI_KEY = 'finglongerer.ui';
const ui = {order: [], open: {}, sort: false, tab: 'bose', tabs: {bose: true, tv: true}};
try { const r = STNative.storage.getItem(UI_KEY); if (r) { const o = JSON.parse(r); ui.order = o.order || []; ui.open = o.open || {}; ui.tab = o.tab === 'tv' ? 'tv' : 'bose'; if (o.tabs) ui.tabs = {bose: o.tabs.bose !== false, tv: o.tabs.tv !== false}; } } catch (e) { /* neu anfangen */ }
{ const first = Object.keys(ui.open).find(k => /^[gb]:/.test(k) && ui.open[k]);   // alte Stände: nur einen offen lassen
  Object.keys(ui.open).forEach(k => { if (/^[gb]:/.test(k) && k !== first) ui.open[k] = false; }); }
const saveUi = () => { try { STNative.storage.setItem(UI_KEY, JSON.stringify({order: ui.order, open: ui.open, tab: ui.tab, tabs: ui.tabs})); } catch (e) { /* egal */ } };
const presetNames = {}, presetLoc = {}, presetRows = {}, presetRow2 = {};

async function api(path, body) {
  // Direkt an die Boxen (kein Server): Kernlogik aus core.js, Transport aus native.js
  const j = await core.route(path, body);
  if (j && j.ok === false) throw new Error(j.error || t('ui.error'));
  return j;
}
let toastTimer;
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = '', err ? 6000 : 3000);
}
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('data-')) e.setAttribute(k, v); else e[k] = v;
  }
  for (const c of kids) if (c) e.append(c);
  return e;
}

// ---- Gruppen-Hilfen
const gIdx = g => g.members.map(id => cfg.speakers.findIndex(s => s.id === id)).filter(i => i >= 0);
const gState = g => gIdx(g).map(i => state[i]).filter(Boolean);

// ---- Zustandsanzeige der Knöpfe: orange = an, orange blinkend = wartet auf die Box
function pred(key) {
  if (key.startsWith('aux:')) { const s = state[+key.slice(4)]; return !!(s && s.online && s.source === 'AUX'); }
  if (key.startsWith('bt:')) { const s = state[+key.slice(3)]; return !!(s && s.online && s.source === 'BLUETOOTH'); }
  if (key.startsWith('off:')) { const s = state[+key.slice(4)]; return !!(s && s.online && s.standby); }
  if (key.startsWith('p:')) {       // p:<ekey>:<n> -> gewählte Sendertaste (Stand der ersten Box des Eintrags)
    const [, kind, id, n] = key.split(':'), loc = (presetLoc[kind + ':' + id] || {})[n];
    const g = kind === 'g' ? cfg.groups.find(x => x.id === id) : null;
    const sp = g ? gState(g)[0] : state[cfg.speakers.findIndex(x => x.id === id)];
    return !!(loc && sp && sp.online && sp.item === loc);
  }
  const [, gid, what] = key.split(':');
  const g = cfg.groups.find(x => x.id === gid); if (!g) return false;
  const S = gState(g);
  if (what === 'aux') return S.length > 0 && S.every(s => s.online && s.source === 'AUX');
  if (what === 'bt') return S.length > 0 && S.every(s => s.online && s.source === 'BLUETOOTH');
  if (what === 'off') return S.length > 0 && S.every(s => s.online && s.standby);
  if (what === 'on') return S.length > 0 && S.every(s => s.online && !s.standby);
  if (what === 'pair') return S.length === 2 && !!(S[0].group && S[0].group.paired);
  return false;
}
function paint() {
  const now = Date.now();
  for (const k of Object.keys(pending)) if (pred(k) || pending[k] < now) delete pending[k];
  document.querySelectorAll('[data-key]').forEach(b => {
    const k = b.dataset.key; if (!k) return;
    const on = pred(k), w = k in pending && !on;
    b.classList.toggle('lit', on && !w); b.classList.toggle('wait', w);
  });
}
async function act(path, body, btn, keys = []) {
  if (keys.some(k => k in pending)) return; // läuft schon
  inflight++; if (btn) btn.disabled = true;
  keys.forEach(k => { pending[k] = Infinity; }); paint();
  toast(t('ui.sending'));
  try {
    const j = await api(path, body); toast(j.message || t('ui.ok'));
    keys.forEach(k => { if (pending[k] === Infinity) pending[k] = Date.now() + 12000; });
  } catch (e) { toast(e.message, true); keys.forEach(k => { delete pending[k]; }); }
  finally { inflight--; if (btn) btn.disabled = false; await refresh(true); paint(); }
}

// ---- Anzeige: Gruppen und Einzelboxen gleichrangig
const SRC_NAMES = {LOCAL_INTERNET_RADIO: 'src.radio', INTERNET_RADIO: 'src.radio', STORED_MUSIC: 'src.library', PRODUCT: 'src.input', NOTIFICATION: 'src.notice',
  TUNEIN: 'TuneIn', BLUETOOTH: 'BT', AIRPLAY: 'AirPlay', SPOTIFY: 'Spotify', DEEZER: 'Deezer', QPLAY: 'QPlay', AUX: 'AUX'};
const srcName = x => SRC_NAMES[x] ? (SRC_NAMES[x].includes('.') ? t(SRC_NAMES[x]) : SRC_NAMES[x]) : (x ? x.charAt(0) + x.slice(1).toLowerCase().replace(/_/g, ' ') : t('badge.on'));
function sourceBadge(S) {
  if (!S.length || S.every(s => !s.online)) return [t('badge.unreachable'), 'err'];
  const off = S.filter(s => !s.online).length;
  if (off) return [t('badge.nUnreachable', off), 'err'];
  if (S.every(s => s.standby)) return [t('badge.standby'), ''];
  if (S.every(s => s.source === 'AUX')) return ['AUX', 'on'];
  if (S.every(s => s.source === 'BLUETOOTH')) return ['BT', 'on'];
  if (S.every(s => s.source === S[0].source)) return [srcName(S[0].source), 'on'];
  return [t('badge.mixed'), ''];
}
function balText(b) { return ''; }
function volText(m, cap) { return String(m); }

// ---- Laufender Titel und Player-Tasten (Daten der Master-Box)
const RADIO_SRC = new Set(['LOCAL_INTERNET_RADIO', 'INTERNET_RADIO', 'TUNEIN', 'RADIO_BROWSER']);
// Alles, was die Quelle meldet, in Zeilen (nichts abschneiden): Titel, Interpret, Album, Sender; dazu das Cover
function nowInfo(s) {
  if (!s || !s.online || s.standby || s.source === 'AUX') return null;
  const m = s.ma && s.ma.active && s.ma.title ? s.ma : s;       // spielt Music Assistant, gilt dessen Titel
  const lines = [m.title, m.artist, m.album, s.station].filter((v, i, a) => v && a.indexOf(v) === i);
  const art = m.art || s.art || '';
  return lines.length || art ? {lines, art} : null;
}
const ICON = {
  power: '<path d="M11 3h2v10h-2zM7.05 6.05l1.41 1.41A6 6 0 1 0 15.54 7.46l1.41-1.41A8 8 0 1 1 7.05 6.05z"/>',
  prev: '<path d="M6 6h2v12H6zM20 6v12L9.5 12z"/>', next: '<path d="M16 6h2v12h-2zM4 6l10.5 6L4 18z"/>',
  play: '<path d="M8 5v14l11-7z"/>', pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'};
// Stereopaar: ein einziger Ein/Aus-Knopf (Symbol), grau = aus, orange = an
function pwrRow(g) {
  const b = el('button', {class: 'pwr', 'data-act': 'gpwr', 'data-key': 'g:' + g.id + ':on', title: t('ui.on')}); b.setAttribute('aria-label', t('ui.on'));
  b.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">' + ICON.power + '</svg>';
  return el('div', {class: 'pwrrow'}, b);
}
function playerRow(s) {
  if (!s || !s.online || s.standby || s.source === 'AUX' || s.source === 'PRODUCT') return null;
  const mk = (a, icon, label) => {
    const b = el('button', {'data-act': a, title: label}); b.setAttribute('aria-label', label);
    b.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">' + ICON[icon] + '</svg>';
    return b;
  };
  const viaMa = !!(s.ma && s.ma.active);
  const playing = viaMa ? s.ma.state === 'playing' : s.play !== 'PAUSE_STATE' && s.play !== 'STOP_STATE', skip = viaMa || !RADIO_SRC.has(s.source);
  return el('div', {class: 'player' + (skip ? '' : ' single')},
    skip ? mk('prev', 'prev', t('player.prev')) : null, mk('pp', playing ? 'pause' : 'play', playing ? t('player.pause') : t('player.play')), skip ? mk('next', 'next', t('player.next')) : null);
}
// Umziehen: laufende Musik auf eine andere Box/Gruppe übergeben oder diese dazunehmen
const mvTo = {};
function moveBlock(ekey) {
  const d = el('details', {class: 'movebox'}, el('summary', {text: t('move.title')}));
  const sel = el('select', {'data-role': 'mvto'}), others = entries().filter(e => e.key !== ekey);
  others.forEach(e => sel.append(el('option', {value: e.key, text: e.g ? e.g.name : (cfg.speakers[e.i] || {}).name || '?'})));
  if (mvTo[ekey] && others.some(e => e.key === mvTo[ekey])) sel.value = mvTo[ekey];
  const ref = k => k.startsWith('g:') ? {gid: k.slice(2)} : {idx: cfg.speakers.findIndex(x => 'b:' + x.id === k)};
  const preWake = () => {      // Ziel-Box schon wecken, damit Umziehen nahtloser wird
    const cur = entries().find(e => e.key === ekey); if (!cur || !sel.value) return;
    api('/api/wake', {from: cur.g ? {gid: cur.g.id} : {idx: cur.i}, to: ref(sel.value)}).catch(() => { /* egal */ });
  };
  sel.addEventListener('change', () => { mvTo[ekey] = sel.value; sel.blur(); preWake(); });
  d.append(sel, el('div', {class: 'row2'}, el('button', {text: t('move.go'), 'data-act': 'mvgo'}), el('button', {text: t('move.add'), 'data-act': 'mvadd'})));
  d.open = !!ui.open['m:' + ekey];
  d.addEventListener('toggle', () => { if (!!ui.open['m:' + ekey] !== d.open) { ui.open['m:' + ekey] = d.open; saveUi(); if (d.open) preWake(); } });
  return others.length ? d : null;
}

function entries() {
  const all = cfg.groups.map(g => ({key: 'g:' + g.id, g})).concat(cfg.speakers.map((s, i) => ({key: 'b:' + s.id, i})));
  const byKey = new Map(all.map(e => [e.key, e])), out = [];
  ui.order.forEach(k => { if (byKey.has(k)) { out.push(byKey.get(k)); byKey.delete(k); } });
  byKey.forEach(e => out.push(e));
  return out;
}
const srcRow = (act, key) => el('div', {class: 'row3'},
  el('button', {text: 'AUX', 'data-act': act + 'aux', 'data-key': key('aux')}),
  el('button', {text: 'BT', 'data-act': act + 'bt', 'data-key': key('bt')}),
  el('button', {text: t('btn.off'), 'data-act': act + 'off', 'data-key': key('off')}));

async function loadPresetNames(ekey) {
  if (ekey in presetNames) return;
  presetNames[ekey] = {};
  const card = $('[data-ekey="' + ekey + '"]'); if (!card) return;
  const body = card.dataset.gid ? {gid: card.dataset.gid, action: 'presets'} : {idx: +card.dataset.i};
  try {
    const j = await api(card.dataset.gid ? '/api/group' : '/api/presets', body);
    const names = {}, locs = {}; (j.presets || []).forEach(p => { if (p.name) names[p.n] = p.name; if (p.item) locs[p.n] = p.item; });
    presetNames[ekey] = names; presetLoc[ekey] = locs; presetRows[ekey] = j.rows || 1; presetRow2[ekey] = j.row2 || null; paint();
    document.querySelectorAll('[data-ekey="' + ekey + '"] details.presets').forEach(d => addRow2(d, ekey));
    document.querySelectorAll('[data-ekey="' + ekey + '"] [data-act=preset]').forEach(b => {
      b.textContent = b.dataset.n + (names[b.dataset.n] ? ' · ' + names[b.dataset.n] : ''); });
  } catch (e) { /* ohne Namen */ }
}
// zweite Reihe (Taste doppelt gedrückt, Slots 7-12): nur wenn der STR-Agent sie meldet
function addRow2(d, ekey) {
  if (presetRows[ekey] !== 2 || d.querySelector('.row2box')) return;
  const r2 = presetRow2[ekey], used = r2 ? Object.keys(r2).map(Number).sort((a, b) => a - b) : [7, 8, 9, 10, 11, 12];
  if (!used.length) return;            // zweite Reihe ist leer: gar nicht anzeigen
  const box = el('details', {class: 'row2box'}, el('summary', {text: t('presets.more')}));
  const g2 = el('div', {class: 'pgrid'});
  used.forEach(n => g2.append(el('button', {text: n + (r2 && r2[n] ? ' · ' + r2[n] : ''), 'data-act': 'preset', 'data-n': n})));
  box.append(g2);
  box.open = !!ui.open['q:' + ekey];
  box.addEventListener('toggle', () => { if (!!ui.open['q:' + ekey] !== box.open) { ui.open['q:' + ekey] = box.open; saveUi(); } });
  d.append(box);
}
function presetBlock(ekey) {
  const d = el('details', {class: 'presets'}, el('summary', {text: t('presets.title')}));
  const names = presetNames[ekey] || {}, grid = el('div', {class: 'pgrid'});
  for (let n = 1; n <= 6; n++) grid.append(el('button', {text: n + (names[n] ? ' · ' + names[n] : ''), 'data-act': 'preset', 'data-n': n, 'data-key': 'p:' + ekey + ':' + n}));
  d.append(grid, el('p', {class: 'hint', text: t('presets.hint')})); addRow2(d, ekey);
  d.open = !!ui.open['p:' + ekey];
  d.addEventListener('toggle', () => {
    if (!!ui.open['p:' + ekey] === d.open) return;
    ui.open['p:' + ekey] = d.open; saveUi(); if (d.open) loadPresetNames(ekey);
  });
  if (d.open) setTimeout(() => loadPresetNames(ekey), 0);
  return d;
}

function groupBody(g, ekey) {
  const idx = gIdx(g), S = idx.map(i => state[i] || {name: '?', max: 70}), n = S.length;
  const cap = Math.min(...S.map(s => s.max));
  const vols = S.map(s => (typeof s.volume === 'number' ? s.volume : 0));
  const paired = n === 2 && !!(S[0].group && S[0].group.paired);
  const m = paired ? vols[0] : Math.max(...vols);
  const sub = S.map(s => s.name).join(' · ');
  const kids = [
    el('div', {class: 'head'}, el('div', {class: 'sub', text: sub})),
    playerRow(S[0]),
    paired ? pwrRow(g) : srcRow('g', w => 'g:' + g.id + ':' + w),
    el('div', {class: 'vol'},
      el('button', {text: '−', 'data-act': 'gdown'}),
      el('input', {type: 'range', min: 0, max: cap, value: Math.min(m, cap), 'data-role': 'gvol'}),
      el('button', {text: '+', 'data-act': 'gup'}),
      el('span', {class: 'v', text: volText(m, cap)}))];
  if (n === 2) {
    let b = 0;
    if (!paired) {
      const [vl, vr] = vols;
      if (vl < vr) b = Math.round((1 - vl / vr) * 20) * 5; else if (vr < vl) b = -Math.round((1 - vr / vl) * 20) * 5;
      balRead[g.id] = false;
    } else b = balCache[g.id] || 0;
    kids.push(
      el('div', {class: 'vol bal'}, el('span', {class: 'side', text: 'L'}),
        el('input', {type: 'range', min: -100, max: 100, step: 5, value: b, 'data-role': 'gbal'}),
        el('span', {class: 'side', text: 'R'}),
        el('span', {class: 'v', text: balText(b)})),
      el('button', {class: 'pairbtn', text: t('grp.pair'), 'data-act': 'gpairtoggle', 'data-key': 'g:' + g.id + ':pair'}));   // ein Knopf: orange = Paar besteht, Druck löst es, sonst bildet er es
    if (paired && !balRead[g.id]) {
      balRead[g.id] = true;
      api('/api/group', {gid: g.id, action: 'read'}).then(j => {
        if (typeof j.balance !== 'number') return;
        balCache[g.id] = j.balance;
        const r = $('[data-gid="' + g.id + '"] [data-role=gbal]');
        if (r && !dragging) { r.value = j.balance; r.parentElement.querySelector('.v').textContent = balText(j.balance); }
      }).catch(() => { /* Balance bleibt wie sie ist */ });
    }
  }
  kids.push(presetBlock(ekey), moveBlock(ekey));
  return kids;
}
function boxBody(s, i, ekey) {
  const vol = typeof s.volume === 'number' ? s.volume : 0;
  const sub = s.error ? s.error : (s.group && s.group.paired
    ? t('box.pair') + (s.group.role ? ' (' + (s.group.role === 'LEFT' ? t('box.left') : s.group.role === 'RIGHT' ? t('box.right') : s.group.role) + ')' : '')
    : s.ip);
  return [
    el('div', {class: 'sub', text: sub}),
    playerRow(s),
    srcRow('', w => w + ':' + i),
    el('div', {class: 'vol'},
      el('button', {text: '−', 'data-act': 'down', 'data-i': i}),
      el('input', {type: 'range', min: 0, max: s.max, value: Math.min(vol, s.max), 'data-i': i, 'data-role': 'slider'}),
      el('button', {text: '+', 'data-act': 'up', 'data-i': i}),
      el('span', {class: 'v', text: typeof s.volume === 'number' ? String(s.volume) : '-'})),
    presetBlock(ekey), moveBlock(ekey)];
}
// Spielt eine Gruppe (mind. zwei Boxen, alle an, gleicher Inhalt), liegt Titel/Cover bei der Gruppe, nicht bei den Einzelboxen
function inPlayingGroup(i) {
  return cfg.groups.some(g => {
    const idx = gIdx(g); if (idx.length < 2 || !idx.includes(i)) return false;
    const S = idx.map(k => state[k]);
    if (!S.every(x => x && x.online && !x.standby && x.source !== 'AUX' && x.source !== 'BLUETOOTH')) return false;
    return !!S[0].item && S.every(x => x.item === S[0].item) || S.every(x => x.ma && x.ma.active) && new Set(S.map(x => x.ma.title)).size === 1;
  });
}
function entryCard(e, pos, total) {
  const open = !!ui.open[e.key];
  const S = e.g ? gState(e.g) : [state[e.i]].filter(Boolean);
  const name = e.g ? e.g.name : (cfg.speakers[e.i] || {}).name;
  const [btxt, bcls] = sourceBadge(S);
  const right = ui.sort
    ? el('div', {class: 'sortbtns'},
        el('button', {text: '▲', disabled: pos === 0, 'data-act': 'eup'}), el('button', {text: '▼', disabled: pos === total - 1, 'data-act': 'edown'}))
    : el('span', {class: 'chev', text: open ? '▴' : '▾'});
  const head = el('button', {class: 'etoggle', 'data-act': 'toggle', disabled: ui.sort},
    el('span', {class: 'ename', text: (e.g ? '' : '') + name}), el('span', {class: 'badge ' + bcls, text: btxt}), ui.sort ? null : right);
  const props = {class: 'card entry' + (ui.sort ? ' sorting' : ''), 'data-ekey': e.key};
  if (e.g) props['data-gid'] = e.g.id; else props['data-i'] = e.i;
  if (ui.sort) return el('div', props, el('div', {class: 'ehead'}, el('span', {class: 'ename', text: name}), el('span', {class: 'badge ' + bcls, text: btxt}), right));
  const note = !e.g && inPlayingGroup(e.i);       // Box ist Teil einer spielenden Gruppe: Titel und Cover zeigt die Gruppe
  if (note) head.querySelector('.ename').append(el('span', {class: 'gnote', text: ' ♪', title: t('ui.groupPlays')}));
  const card = el('div', props, head), np = note ? null : nowInfo(S[0]);
  if (np) {
    const box = el('div', {class: 'enp'});
    if (np.art) { const im = el('img', {src: np.art, alt: '', loading: 'lazy'}); im.referrerPolicy = 'no-referrer'; im.onerror = () => im.remove(); box.append(im); }
    box.append(el('div', {class: 'enl'}, ...np.lines.map((t, i) => el('div', {class: i ? 'l2' : 'l1', text: t}))));
    card.append(box);
  }
  if (open) card.append(el('div', {class: 'ebody'}, ...(e.g ? groupBody(e.g, e.key) : boxBody(state[e.i] || {name: '?', max: 70}, e.i, e.key))));
  return card;
}

function render() {
  cfgSig = JSON.stringify(cfg);
  if (dragging) return;
  const ae = document.activeElement; if (ae && ae.tagName === 'SELECT' && ae.dataset.role === 'mvto') return;   // Auswahl nicht wegzeichnen
  const box = $('#groups'); box.textContent = '';
  const list = entries();
  if (!list.length) box.append(el('div', {class: 'card'}, el('p', {class: 'hint', text: t('ui.none')})));
  list.forEach((e, pos) => box.append(entryCard(e, pos, list.length)));
  $('#btn-sort').classList.toggle('lit', ui.sort);
  const ma = $('#ma-open'); ma.hidden = !cfg.ma; if (cfg.ma) ma.href = cfg.ma;
  fillUrlTargets();
  paint();
}

async function refresh(force) {
  if (!force && (document.hidden || inflight || dragging)) return;
  try { const j = await api('/api/state'); cfg = j.config; state = j.speakers; lastRefresh = Date.now(); render(); }
  catch (e) { toast(e.message, true); }
}

// ---- Bedienung
function gSend(card, volOverride) {
  const gid = card.dataset.gid;
  const vol = card.querySelector('[data-role=gvol]'), bal = card.querySelector('[data-role=gbal]');
  const balance = bal ? +bal.value : 0; balCache[gid] = balance;
  return act('/api/group', {gid, action: 'volume', master: volOverride === undefined ? +vol.value : volOverride, balance});
}
// Langer Druck auf eine Sendertaste: speichert, was gerade läuft
let holdTimer = null, held = false;
const holdEnd = () => { clearTimeout(holdTimer); holdTimer = null; };
function holdStart(b) {
  held = false; holdEnd();
  holdTimer = setTimeout(() => {
    held = true; holdTimer = null;
    const ecard = b.closest('[data-ekey]'), n = +b.dataset.n, ekey = ecard.dataset.ekey;
    const label = String(n), old = (presetNames[ekey] || {})[n];
    if (!confirm(t('presets.confirm', label, old ? ' (' + old + ')' : ''))) return;
    act('/api/save', ecard.dataset.gid ? {gid: ecard.dataset.gid, n} : {idx: +ecard.dataset.i, n}, b)
      .then(() => { delete presetNames[ekey]; if (ui.open['p:' + ekey]) loadPresetNames(ekey); });
  }, 700);
}
document.addEventListener('pointerdown', ev => {
  const b = ev.target.closest('button[data-act=preset]'); if (!b) return;
  holdStart(b);
});
['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach(t => document.addEventListener(t, holdEnd, true));
document.addEventListener('contextmenu', ev => { if (ev.target.closest('button[data-act=preset]')) ev.preventDefault(); });
// Fernbedienung (Google TV): OK kurz = Sendertaste, OK gehalten = speichern. Der Klick wird erst beim Loslassen ausgelöst.
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Enter' || !document.documentElement.classList.contains('tv')) return;
  const b = ev.target.closest && ev.target.closest('button[data-act=preset]'); if (!b) return;
  ev.preventDefault();
  if (!ev.repeat) holdStart(b);
});
document.addEventListener('keyup', ev => {
  if (ev.key !== 'Enter' || !document.documentElement.classList.contains('tv')) return;
  const b = ev.target.closest && ev.target.closest('button[data-act=preset]'); if (!b) return;
  ev.preventDefault();
  if (holdTimer) { holdEnd(); held = false; b.click(); }
});
document.addEventListener('click', async ev => {
  if (held && ev.target.closest('button[data-act=preset]')) { held = false; return; }   // Klick nach langem Druck ignorieren
  const b = ev.target.closest('button[data-act]'); if (!b) return;
  const a = b.dataset.act, card = b.closest('[data-gid]'), gid = card && card.dataset.gid;
  const ecard = b.closest('[data-ekey]'), ekey = ecard && ecard.dataset.ekey;
  const idx = +(b.dataset.i !== undefined ? b.dataset.i : (ecard && ecard.dataset.i));
  if (a === 'toggle') {
    const was = !!ui.open[ekey];
    entries().forEach(e => { ui.open[e.key] = false; });      // immer nur ein Eintrag offen
    ui.open[ekey] = !was; saveUi(); dragging = false; render();
  }
  else if (a === 'eup' || a === 'edown') {
    const keys = entries().map(e => e.key), p = keys.indexOf(ekey), q = p + (a === 'eup' ? -1 : 1);
    if (q >= 0 && q < keys.length) { [keys[p], keys[q]] = [keys[q], keys[p]]; ui.order = keys; saveUi(); render(); }
  }
  else if (a === 'preset') {
    const n = +b.dataset.n;
    if (ecard.dataset.gid) act('/api/group', {gid: ecard.dataset.gid, action: 'preset', n}, b);
    else act('/api/preset', {idx: +ecard.dataset.i, n}, b);
  }
  else if (a === 'pp' || a === 'prev' || a === 'next') {
    const key = {pp: 'PLAY_PAUSE', prev: 'PREV_TRACK', next: 'NEXT_TRACK'}[a];
    act('/api/key', ecard.dataset.gid ? {gid: ecard.dataset.gid, key} : {idx: +ecard.dataset.i, key}, b).then(() => setTimeout(() => refresh(true), 1500));
  }
  else if (a === 'mvgo' || a === 'mvadd') {
    const to = $('[data-role=mvto]', ecard).value, ref = k => k.startsWith('g:') ? {gid: k.slice(2)} : {idx: cfg.speakers.findIndex(x => 'b:' + x.id === k)};
    if (!to) return;
    act('/api/move', {from: ecard.dataset.gid ? {gid: ecard.dataset.gid} : {idx: +ecard.dataset.i}, to: ref(to), mode: a === 'mvadd' ? 'add' : 'move'}, b);
  }
  else if (a === 'bt') act('/api/bt', {idx}, null, ['bt:' + idx]);
  else if (a === 'gbt') act('/api/group', {gid, action: 'bt'}, null, ['g:' + gid + ':bt']);
  else if (a === 'aux') act('/api/aux', {idx}, null, ['aux:' + idx]);
  else if (a === 'off') act('/api/off', {idx}, null, ['off:' + idx]);
  else if (a === 'up') act('/api/volume', {idx, delta: 3}, b);
  else if (a === 'down') act('/api/volume', {idx, delta: -3}, b);
  else if (a === 'gaux') act('/api/group', {gid, action: 'aux'}, null, ['g:' + gid + ':aux']);
  else if (a === 'goff') act('/api/group', {gid, action: 'off'}, null, ['g:' + gid + ':off']);
  else if (a === 'gpwr') { const on = pred('g:' + gid + ':on'); act('/api/group', {gid, action: on ? 'off' : 'on'}, null, on ? ['g:' + gid + ':off'] : ['g:' + gid + ':on']); }
  else if (a === 'gup' || a === 'gdown') {
    const v = card.querySelector('[data-role=gvol]');
    gSend(card, Math.max(0, Math.min(+v.max, +v.value + (a === 'gup' ? 3 : -3))));
  } else if (a === 'gpair') { balRead[gid] = false; act('/api/group', {gid, action: 'pair'}, null, ['g:' + gid + ':pair']); }
  else if (a === 'gpairtoggle') { balRead[gid] = false; const on = pred('g:' + gid + ':pair'); act('/api/group', {gid, action: on ? 'unpair' : 'pair'}, null, on ? [] : ['g:' + gid + ':pair']); }
});
document.addEventListener('pointerdown', ev => { if (ev.target.type === 'range') dragging = true; });
window.addEventListener('pointerup', () => { setTimeout(() => dragging = false, 50); });
document.addEventListener('input', ev => {
  const t = ev.target, role = t.dataset && t.dataset.role; if (!role) return;
  const v = t.parentElement.querySelector('.v');
  if (role === 'slider') v.textContent = t.value;
  else if (role === 'gvol') v.textContent = volText(t.value, t.max);
  else if (role === 'gbal') v.textContent = balText(+t.value);
});
// Doppeltipp auf den Balanceregler setzt ihn in die Mitte
let lastBalTap = 0;
document.addEventListener('pointerup', ev => {
  const t = ev.target; if (!t.dataset || t.dataset.role !== 'gbal') return;
  const now = Date.now();
  if (now - lastBalTap < 400) {
    lastBalTap = 0; t.value = 0; t.parentElement.querySelector('.v').textContent = balText(0);
    const card = t.closest('[data-gid]'); if (card) setTimeout(() => gSend(card), 60);
  } else lastBalTap = now;
});
document.addEventListener('change', ev => {
  const t = ev.target, role = t.dataset && t.dataset.role; if (!role) return;
  dragging = false;
  if (role === 'slider') act('/api/volume', {idx: +t.dataset.i, value: +t.value});
  else if (role === 'gvol' || role === 'gbal') gSend(t.closest('[data-gid]'));
});

// ---- Einstellungen: Boxen, Auto-Suche, Gruppen
let editGroups = [];
const rowsOf = () => [...$('#set-rows').children];
const rowVal = (r, k) => $('[data-f=' + k + ']', r).value.trim();
function addRow(sp) {
  const row = el('div', {class: 'srow', 'data-id': sp.id || newId()},
    el('input', {placeholder: t('ph.name'), value: sp.name || '', maxLength: 40, 'data-f': 'name', oninput: renderGroupEditor}),
    el('input', {placeholder: '192.168.x.y', value: sp.ip || '', inputMode: 'decimal', 'data-f': 'ip'}),
    el('input', {placeholder: t('ph.max'), value: sp.max || 70, type: 'number', min: 10, max: 100, 'data-f': 'max'}),
    el('button', {type: 'button', text: '✕', onclick: () => {
      editGroups.forEach(g => { g.members = g.members.filter(id => id !== row.dataset.id); });
      row.remove(); renderGroupEditor(); }}),
    el('div', {class: 'soff'},
      el('label', {text: t('set.maxAux')}, el('input', {type: 'number', min: 10, max: 100, value: sp.maxAux || '', placeholder: '=', 'data-f': 'maxAux'})),
      el('label', {text: t('set.maxBt')}, el('input', {type: 'number', min: 10, max: 100, value: sp.maxBt || '', placeholder: '=', 'data-f': 'maxBt'}))));
  $('#set-rows').append(row);
  return row;
}
function renderGroupEditor() {
  const box = $('#grp-edit'); box.textContent = '';
  const rows = rowsOf().map(r => ({id: r.dataset.id, name: rowVal(r, 'name') || t('def.box')}));
  editGroups.forEach((g, gi) => {
    const members = el('div', {class: 'members inline'});
    rows.forEach(r => members.append(el('label', {},
      el('input', {type: 'checkbox', checked: g.members.includes(r.id), onchange: e => {
        g.members = e.target.checked ? g.members.concat(r.id) : g.members.filter(id => id !== r.id); }}),
      el('span', {text: r.name}))));
    const mem = g.members.filter(id => rows.some(r => r.id === id)), nm = id => (rows.find(r => r.id === id) || {}).name;
    const lr = mem.length === 2 ? el('div', {class: 'lr'},
      el('span', {text: t('grp.leftRight', nm(mem[0]), nm(mem[1]))}),
      el('button', {type: 'button', text: t('grp.swap'), onclick: () => { g.members = mem.slice().reverse(); renderGroupEditor(); }})) : null;
    box.append(el('div', {class: 'gedit'},
      el('div', {class: 'ghead'},
        el('input', {value: g.name, maxLength: 30, placeholder: t('ph.groupName'), oninput: e => { g.name = e.target.value; }}),
        el('button', {type: 'button', text: '✕', title: t('grp.delete'), onclick: () => { editGroups.splice(gi, 1); renderGroupEditor(); }})),
      members, lr));
  });
}
function takeFound(f) {
  const rows = rowsOf();
  if (rows.some(r => rowVal(r, 'ip') === f.ip)) return;
  const row = rows.find(r => rowVal(r, 'ip') === '' && rowVal(r, 'name').toLowerCase() === f.name.toLowerCase())
    || rows.find(r => rowVal(r, 'ip') === '' && rowVal(r, 'name') === '');
  if (row) { $('[data-f=ip]', row).value = f.ip; if (!rowVal(row, 'name')) $('[data-f=name]', row).value = f.name; }
  else addRow({name: f.name, ip: f.ip, max: 70});
  renderGroupEditor();
}
$('#btn-settings').onclick = () => {
  $('#set-rows').textContent = '';
  (cfg.speakers.length ? cfg.speakers : [{}]).forEach(addRow);
  editGroups = cfg.groups.map(g => ({id: g.id, name: g.name, members: g.members.slice()}));
  renderGroupEditor();
  $('#scan-res').textContent = ''; $('#dlg-err').textContent = ''; $('#ma-url').value = cfg.ma || ''; $('#ma-token').value = cfg.maToken || ''; $('#ma-res').textContent = ''; $('#diag-out').hidden = true;
  $('#version').textContent = t('set.version', window.APP_VERSION || '?'); $('#lang-sel').value = STNative.langPref();
  const rs = $('#reboot-sel'); rs.textContent = '';
  cfg.speakers.forEach((sp, i) => { if (sp.ip) rs.append(el('option', {value: i, text: sp.name})); });
  $('#reboot-go').disabled = !rs.options.length;
  $('#tab-bose').checked = ui.tabs.bose; $('#tab-tv').checked = ui.tabs.tv; $('#proj-mac').value = projMac(); $('#proj-res').textContent = ''; $('#tv-ip').value = tvLoad().ip; tvMac = tvLoad().mac; $('#tv-code-row').hidden = true; $('#tv-res').textContent = ''; $('#tv-found').textContent = '';
  $('#dlg').showModal();
};
$('#reboot-go').onclick = async e => {
  const b = e.currentTarget, rs = $('#reboot-sel'), i = +rs.value, sp = cfg.speakers[i];
  if (!sp || !confirm(t('set.rebootAsk', sp.name))) return;
  b.disabled = true; b.classList.add('wait');
  try { const j = await api('/api/reboot', {idx: i}); toast(j.message); }
  catch (ex) { $('#dlg-err').textContent = ex.message; }
  finally { b.disabled = false; b.classList.remove('wait'); }
};
$('#set-add').onclick = () => { addRow({max: 70}); renderGroupEditor(); };
$('#grp-add').onclick = () => { editGroups.push({name: t('grp.defaultName', editGroups.length + 1), members: []}); renderGroupEditor(); };
$('#scan-go').onclick = async e => {
  const b = e.currentTarget, v = $('#scan-net').value.trim(), err = $('#dlg-err');
  b.disabled = true; b.classList.add('wait'); err.textContent = ''; $('#scan-res').textContent = '';
  try {
    const j = await api('/api/scan', v ? {prefixes: v.split(/[,\s]+/).filter(Boolean)} : {});
    const box = $('#scan-res'); box.className = 'found';
    const known = new Set(rowsOf().map(r => rowVal(r, 'ip')));
    if (!j.found.length) err.textContent = t('scan.none', j.prefixes.join(', '));
    j.found.forEach(f => box.append(el('button', {
      type: 'button', text: '+ ' + f.name + ' · ' + f.ip + (f.type ? ' · ' + f.type : '') + (known.has(f.ip) ? t('scan.known') : ''),
      disabled: known.has(f.ip), onclick: ev => { takeFound(f); ev.currentTarget.disabled = true; }})));
    if (j.found.filter(f => !known.has(f.ip)).length > 1)
      box.append(el('button', {type: 'button', text: t('scan.all'), onclick: () => {
        j.found.forEach(takeFound); [...box.querySelectorAll('button')].forEach(x => { x.disabled = true; }); }}));
  } catch (ex) { err.textContent = ex.message; }
  finally { b.disabled = false; b.classList.remove('wait'); }
};
$('#ma-scan').onclick = async e => {
  const b = e.currentTarget, err = $('#dlg-err'), v = $('#scan-net').value.trim();
  b.disabled = true; b.classList.add('wait'); err.textContent = ''; $('#ma-res').textContent = '';
  try {
    const j = await api('/api/ma/scan', v ? {prefixes: v.split(/[,\s]+/).filter(Boolean)} : {});
    if (!j.found.length) err.textContent = t('scan.maNone', j.prefixes.join(', '));
    j.found.forEach(f => $('#ma-res').append(el('button', {type: 'button', text: t('scan.take', f.url + (f.version ? ' · ' + f.version : '')),
      onclick: () => { $('#ma-url').value = f.url; }})));
  } catch (ex) { err.textContent = ex.message; }
  finally { b.disabled = false; b.classList.remove('wait'); }
};
$('#diag-go').onclick = async e => {
  const b = e.currentTarget, out = $('#diag-out'), err = $('#dlg-err');
  b.disabled = true; b.classList.add('wait'); err.textContent = '';
  try { const j = await api('/api/diag'); out.value = j.text; out.hidden = false; }
  catch (ex) { err.textContent = ex.message; }
  finally { b.disabled = false; b.classList.remove('wait'); }
};
$('#diag-copy').onclick = async () => {
  const out = $('#diag-out'); if (out.hidden || !out.value) { toast(t('toast.copyFirst'), true); return; }
  try { await navigator.clipboard.writeText(out.value); toast(t('toast.copied')); }
  catch (e) { out.focus(); out.select(); try { document.execCommand('copy'); toast(t('toast.copied')); } catch (x) { toast(t('toast.copyManual'), true); } }
};
$('#ma-test').onclick = async e => {       // erst speichern (Adresse/Token), dann prüfen
  const b = e.currentTarget, err = $('#dlg-err'), res = $('#ma-res');
  b.disabled = true; b.classList.add('wait'); err.textContent = ''; res.textContent = '';
  try {
    const speakers = rowsOf().map(r => ({id: r.dataset.id, name: rowVal(r, 'name'), ip: rowVal(r, 'ip'), max: +rowVal(r, 'max') || 70, maxAux: +rowVal(r, 'maxAux') || 0, maxBt: +rowVal(r, 'maxBt') || 0}));
    await api('/api/config', {speakers, groups: editGroups, ma: $('#ma-url').value, maToken: $('#ma-token').value});
    const j = await api('/api/ma/test'); res.append(el('p', {class: 'hint', text: j.message}));
    j.lines.forEach(t => res.append(el('p', {class: 'hint', text: t})));
  } catch (ex) { err.textContent = ex.message; }
  finally { b.disabled = false; b.classList.remove('wait'); }
};
$('#dlg-form').addEventListener('submit', async ev => {
  if (ev.submitter && ev.submitter.value !== 'ok') return; // Abbrechen: schließt einfach
  ev.preventDefault();
  const speakers = rowsOf().map(r => ({id: r.dataset.id, name: rowVal(r, 'name'), ip: rowVal(r, 'ip'), max: +rowVal(r, 'max') || 70, maxAux: +rowVal(r, 'maxAux') || 0, maxBt: +rowVal(r, 'maxBt') || 0}));
  try {
    await api('/api/config', {speakers, groups: editGroups, ma: $('#ma-url').value, maToken: $('#ma-token').value});
    $('#dlg').close(); toast(t('toast.saved')); refresh(true);
  } catch (e) { $('#dlg-err').textContent = e.message; }
});

// ---- Stream-URL: Adresse (auch aus „Teilen") an eine Box oder Gruppe schicken
function fillUrlTargets() {
  const sel = $('#url-to'), keep = sel.value || ui.urlTo;
  sel.textContent = '';
  entries().forEach(e => sel.append(el('option', {value: e.key, text: e.g ? e.g.name : (cfg.speakers[e.i] || {}).name || '?'})));
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
}
$('#url-go').onclick = e => {
  const text = $('#url-in').value.trim(), key = $('#url-to').value;
  if (!text) { toast(t('toast.needUrl'), true); return; }
  const en = entries().find(x => x.key === key); if (!en) { toast(t('toast.needTarget'), true); return; }
  ui.urlTo = key; saveUi();
  act('/api/url', en.g ? {gid: en.g.id, url: text} : {idx: en.i, url: text}, e.currentTarget);
};
window.STShareCheck = () => {            // Android „Teilen" -> Text steht in der Brücke bereit
  try {
    const t = window.STShare && window.STShare.take && window.STShare.take();
    if (t) { $('#url-in').value = t; $('#urlbox').open = true; $('#urlbox').scrollIntoView(); toast(t('toast.linkTaken')); }
  } catch (x) { /* nicht in der App */ }
};
window.addEventListener('focus', () => window.STShareCheck());
document.addEventListener('visibilitychange', () => { if (!document.hidden) window.STShareCheck(); });
setTimeout(() => window.STShareCheck(), 800);
$('#lang-sel').onchange = e => {       // Sprache sofort umschalten (auto = Systemsprache)
  STNative.setLangPref(e.target.value); applyStatic(); renderGroupEditor(); render(); buildTv();
};
$('#btn-sort').onclick = () => { ui.sort = !ui.sort; dragging = false; render(); };
document.addEventListener('visibilitychange', () => refresh());
refresh(true);
setInterval(() => { if (Object.keys(pending).length || Date.now() - lastRefresh >= 5000) refresh(); }, 1500);

// Zurück-Taste (Android/Fernbedienung): schließt zuerst Einstellungen, dann zuletzt aufgeklappte Bereiche; true = etwas wurde geschlossen
window.STBack = () => {
  const dlg = $('#dlg'); if (dlg && dlg.open) { dlg.close('cancel'); return true; }
  const open = Array.from(document.querySelectorAll('details[open]'));
  if (open.length) { const d = open[open.length - 1]; d.open = false; d.dispatchEvent(new Event('toggle')); const sm = d.querySelector('summary'); if (sm) sm.focus(); return true; }
  return false;
};
// Fernseher: OK in einem Textfeld öffnet die Tastatur (auch die Handy-Tastatur der Google-TV-App), statt das Formular abzuschicken
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Enter' || !document.documentElement.classList.contains('tv')) return;
  const el = ev.target; if (!el || el.tagName !== 'INPUT' || !/^(text|password|url|search|)$/.test(el.type)) return;
  ev.preventDefault(); el.focus();
  try { window.STDevice.showKeyboard(); } catch (e) { /* kein Fernseher */ }
});

// ---- Fernseher (Google TV), direkt angesprochen
const TV_KEY = 'finglongerer.tv';
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const tvLoad = () => { try { const o = JSON.parse(STNative.storage.getItem(TV_KEY) || '{}'); return {ip: IP_RE.test(o.ip || '') ? o.ip : '', paired: !!o.paired, mac: /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(o.mac || '') ? o.mac : ''}; } catch (e) { return {ip: '', paired: false, mac: ''}; } };
const tvSave = o => { try { STNative.storage.setItem(TV_KEY, JSON.stringify(o)); } catch (e) { /* egal */ } };
let tvMac = '';
// Projektor (z. B. LG webOS): wird per Weckruf eingeschaltet und weckt den Stick über HDMI-CEC (SIMPLINK) mit
const PROJ_KEY = 'finglongerer.proj', MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const projMac = () => { try { const m = String(STNative.storage.getItem(PROJ_KEY) || ''); return MAC_RE.test(m) ? m : ''; } catch (e) { return ''; } };       // MAC des gerade gesuchten/gekoppelten Fernsehers
const tvBusy = async (b, fn) => {
  b.disabled = true; b.classList.add('wait');
  try { await new Promise(r => setTimeout(r, 30)); await fn(); } finally { b.disabled = false; b.classList.remove('wait'); }
};
function buildTv() {
  const c = tvLoad(), body = $('#tvbody'); body.textContent = '';
  if (!(c.ip && c.paired)) {
    body.append(el('p', {class: 'hint', text: t('tv.notPaired')}), el('button', {type: 'button', text: t('tv.openSettings'), 'data-tvsettings': '1'}));
    return;
  }
  // Symbole als Linienzeichnung (Farbe folgt dem Text)
  const ICON = {
    power: '<path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    back: '<path d="M20 12H5M11 6l-6 6 6 6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    play: '<path d="M4 5l8 7-8 7z"/><path d="M16 5v14M20 5v14"/>',
    prev: '<path d="M6 5v14M19 5l-10 7 10 7z"/>',
    next: '<path d="M18 5v14M5 5l10 7-10 7z"/>',
    kbd: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'
  };
  const icon = n => '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[n] + '</svg>';
  const k = (label, key, title, cls) => {
    const b = el('button', {type: 'button', title: title || '', 'aria-label': title || label, class: cls || '', 'data-tvkey': key});
    if (ICON[label]) b.innerHTML = icon(label); else b.textContent = label;
    return b;
  };
  const off = el('button', {type: 'button', class: 'tvoff', title: t('tv.off'), 'aria-label': t('tv.off'), 'data-tvpower': 'off'});
  off.innerHTML = icon('power');
  const on = el('button', {type: 'button', class: 'tvon', title: t('tv.on'), 'aria-label': t('tv.on'), 'data-projon': '1'});
  on.innerHTML = icon('power');
  const skip = (n, tip) => { const b = el('button', {type: 'button', title: tip, 'aria-label': tip, 'data-tvskip': n}); b.innerHTML = icon(n); return b; };
  const gap = () => el('span');
  // Tastatur: Taste öffnet die Handy-Tastatur über ein unsichtbares Feld; der Text erscheint in der Taste und live auf dem Fernseher
  const kb = el('button', {type: 'button', class: 'kbd', title: t('tv.kbd'), 'aria-label': t('tv.kbd'), 'data-tvkbd': '1'});
  kb.innerHTML = icon('kbd'); kb.append(el('span', {class: 'kbtxt', text: t('tv.kbd')}));
  const form = el('form', {class: 'tvq', autocomplete: 'off'},
    el('input', {type: 'text', id: 'tv-q', name: 'tvq', enterkeyhint: 'send', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-hidden': 'true', tabindex: '-1'}));
  body.append(
    el('div', {class: projMac() ? 'tvrow' : 'tvrow two'}, ...(projMac() ? [on] : []), off, (() => { const m = el('button', {type: 'button', title: t('tv.searchTip'), 'aria-label': t('tv.searchTip'), 'data-tvvoice': '1'}); m.innerHTML = icon('mic'); return m; })()),
    el('div', {class: 'tvrow'}, skip('prev', t('tv.prev')), k('play', 85, t('tv.play')), skip('next', t('tv.next'))),
    el('div', {class: 'dpad'}, gap(), k('▲', 19), gap(), k('◀', 21), k('OK', 23, '', 'okb'), k('▶', 22), gap(), k('▼', 20), gap()),
    el('div', {class: 'tvrow'}, k('back', 4, t('tv.back')), k('home', 3, t('tv.home')), k('menu', 82, t('tv.menu'))),
    kb, form);
}
function setTab(name) {
  ui.tab = name === 'tv' ? 'tv' : 'bose'; saveUi();
  $('#boseview').hidden = ui.tab === 'tv'; $('#tvview').hidden = ui.tab !== 'tv';
  $('#btn-sort').hidden = ui.tab === 'tv';
  document.documentElement.classList.toggle('tvmode', ui.tab === 'tv');
  document.querySelectorAll('#tabs .tab').forEach(b => { const on = b.dataset.tab === ui.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
}
// Einstellungen: Reiter ein-/ausblenden; bei nur einem Reiter entfällt die Symbolreihe, mindestens einer bleibt
function applyTabs() {
  if (!ui.tabs.bose && !ui.tabs.tv) ui.tabs.bose = true;
  if (!ui.tabs[ui.tab]) ui.tab = ui.tabs.bose ? 'bose' : 'tv';
  document.querySelectorAll('#tabs .tab').forEach(b => { b.hidden = !ui.tabs[b.dataset.tab]; });
  $('#tabs').hidden = !(ui.tabs.bose && ui.tabs.tv);
  $('#tab-bose').checked = ui.tabs.bose; $('#tab-tv').checked = ui.tabs.tv;
  setTab(ui.tab);
}
['bose', 'tv'].forEach(n => $('#tab-' + n).addEventListener('change', e => { ui.tabs[n] = e.target.checked; applyTabs(); }));
$('#tabs').addEventListener('click', ev => { const b = ev.target.closest('.tab'); if (b) setTab(b.dataset.tab); });
// Text am Handy eintippen, Enter: wird in das Feld getippt, das auf dem Fernseher gerade Fokus hat, danach Enter
// Texteingabe: jede Änderung wird als ganzer Feldinhalt an das Eingabefeld des Fernsehers geschickt (wie die Google-TV-App).
// Meldet der Fernseher kein Eingabefeld, wird beim Senden ersatzweise Taste für Taste getippt.
const KEYS = ch => /[a-z]/.test(ch) ? 29 + ch.charCodeAt(0) - 97 : /[0-9]/.test(ch) ? 7 + ch.charCodeAt(0) - 48 : ch === ' ' ? 62 : ch === '.' ? 56 : ch === '-' ? 69 : 0;
const tvText = {live: true, timer: 0, chain: Promise.resolve()};
function kbShow() {
  const inp = $('#tv-q'), span = $('#tvbody .kbtxt'); if (!span) return;
  span.textContent = inp.value || t('tv.kbd'); $('#tvbody .kbd').classList.toggle('typing', document.activeElement === inp);
}
const tvSend = v => { tvText.chain = tvText.chain.then(async () => {
  if (!tvText.live) return;
  const r = await STNative.tv.text(tvLoad().ip, v);
  if (r === 'nofield') { tvText.live = false; toast(t('tv.noField')); }
}).catch(e => toast(e.message, true)); return tvText.chain; };
$('#tvbody').addEventListener('input', ev => {
  if (ev.target.id !== 'tv-q') return;
  kbShow(); clearTimeout(tvText.timer);
  const v = ev.target.value; tvText.timer = setTimeout(() => tvSend(v), 150);
});
$('#tvbody').addEventListener('focusin', ev => { if (ev.target.id === 'tv-q') { tvText.live = true; kbShow(); } });
$('#tvbody').addEventListener('focusout', ev => { if (ev.target.id === 'tv-q') setTimeout(kbShow, 0); });
$('#tvbody').addEventListener('submit', ev => {
  ev.preventDefault();
  const inp = $('#tv-q'), ip = tvLoad().ip, v = inp.value;
  clearTimeout(tvText.timer); inp.blur();
  (async () => {
    if (tvText.live) { await tvSend(v); }
    if (!tvText.live) { for (const ch of v.toLowerCase()) { const c = KEYS(ch); if (c) await STNative.tv.key(ip, c); } }
    await STNative.tv.key(ip, 66);
    inp.value = ''; kbShow();
  })().catch(e => toast(e.message, true));
});
// Sprachsuche: Mikrofon des Handys wird an den Fernseher gestreamt; erster Druck startet, zweiter beendet (nach 20 s automatisch)
let voiceOn = false, voiceTimer = 0;
async function voiceStop() {
  clearTimeout(voiceTimer); voiceOn = false;
  document.querySelectorAll('[data-tvvoice]').forEach(x => x.classList.remove('rec'));
  try { await STNative.tv.voice(tvLoad().ip, false); } catch (e) { /* egal */ }
}
// Vor/Zurück: kurzer Druck = Titel springen, langer Druck = Vor-/Zurückspulen solange gehalten
const SKIP = {prev: [88, 89], next: [87, 90]};
let skipHold = null;
$('#tvbody').addEventListener('pointerdown', ev => {
  const b = ev.target.closest('[data-tvskip]'); if (!b) return;
  const ip = tvLoad().ip, keys = SKIP[b.dataset.tvskip];
  try { b.setPointerCapture(ev.pointerId); } catch (e) { /* egal */ }
  const h = {ip, skip: keys[0], seek: keys[1], long: false};
  h.timer = setTimeout(() => { h.long = true; STNative.tv.keyd(ip, h.seek, 1).catch(e => toast(e.message, true)); }, 450);
  skipHold = h;
});
const skipEnd = ev => {
  if (!skipHold) return;
  const h = skipHold; skipHold = null; clearTimeout(h.timer);
  const p = h.long ? STNative.tv.keyd(h.ip, h.seek, 2) : ev.type === 'pointerup' ? STNative.tv.key(h.ip, h.skip) : Promise.resolve();
  p.catch(e => toast(e.message, true));
};
['pointerup', 'pointercancel'].forEach(n => $('#tvbody').addEventListener(n, skipEnd));
$('#tvbody').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.dataset.tvsettings) { $('#btn-settings').click(); return; }
  if (b.dataset.tvskip) return;
  if (b.dataset.tvkbd) { const inp = $('#tv-q'); inp.value = ''; tvText.live = true; inp.focus(); kbShow(); return; }      // läuft über Zeiger-Ereignisse (kurz/lang)
  const c = tvLoad();
  tvBusy(b, async () => {
    if (b.dataset.tvkey) await STNative.tv.key(c.ip, +b.dataset.tvkey);
    else if (b.dataset.projon) {
      // mehrere Weckrufe kurz hintereinander: Geräte im WLAN-Standby verpassen einzelne Pakete leicht
      const mac = projMac();
      for (let i = 0; i < 5; i++) { await STNative.tv.wake(mac); await new Promise(r => setTimeout(r, 300)); }
      toast(t('tv.projOn'));
    }
    else if (b.dataset.tvvoice) {
      if (!voiceOn) { await STNative.tv.voice(c.ip, true); voiceOn = true; b.classList.add('rec'); toast(t('tv.voiceOff')); voiceTimer = setTimeout(voiceStop, 21000); }
      else await voiceStop();
    }
    else if (b.dataset.tvpower) {
      const on = b.dataset.tvpower === 'on';
      // Ein: erst Weckruf (Wake-on-LAN) an die MAC-Adresse, dann Einschalttaste über die Verbindung
      let woke = false;
      if (on && c.mac) { try { await STNative.tv.wake(c.mac); woke = true; } catch (e) { /* weiter */ } }
      try { await STNative.tv.power(c.ip, on); }
      catch (e) { if (woke) { toast(t('tv.woke')); return; } throw e; }
    }
  }).catch(e => toast(e.message, true));
});
// Fernseher im Heimnetz suchen; Treffer zum Auswählen anzeigen. Gibt die Treffer zurück.
async function tvFind(b) {
  const err = $('#dlg-err'), box = $('#tv-found'); err.textContent = ''; box.textContent = '';
  let list = [];
  await tvBusy(b, async () => { list = await STNative.tv.scan($('#scan-net').value.trim()); });
  if (!list.length) { err.textContent = t('tv.none'); return list; }
  const take = f => { $('#tv-ip').value = f.ip; tvMac = f.mac; box.textContent = ''; };
  if (list.length === 1) { take(list[0]); return list; }
  box.append(el('p', {class: 'hint', text: t('tv.pick')}), ...list.map(f => el('button', {type: 'button', text: f.name + ' (' + f.ip + ')', onclick: () => take(f)})));
  return list;
}
$('#proj-mac').addEventListener('change', e => {
  const v = e.target.value.trim().toUpperCase().replace(/-/g, ':'); $('#dlg-err').textContent = '';
  if (v && !MAC_RE.test(v)) { $('#dlg-err').textContent = t('tv.badMac'); return; }
  e.target.value = v;
  try { STNative.storage.setItem(PROJ_KEY, v); } catch (ex) { /* egal */ }
  buildTv();
});
// Projektor suchen: Hintergrundsuche im Handy, Stand jede Sekunde abfragen; am Projektor muss die Anfrage bestätigt werden
$('#proj-find').onclick = async e => {
  const b = e.currentTarget, res = $('#proj-res'), err = $('#dlg-err'); err.textContent = ''; res.textContent = t('proj.scan');
  b.disabled = true; b.classList.add('wait');
  try {
    await STNative.tv.projFind($('#scan-net').value.trim());
    for (let i = 0; i < 150; i++) {          // höchstens etwa 2,5 Minuten
      await new Promise(r => setTimeout(r, 1000));
      const st = STNative.tv.projPoll(), f = st.split(':');
      if (f[0] === 'run') { res.textContent = f[1] === 'prompt' ? t('proj.prompt', f.slice(2).join(':')) : f[1] === 'connect' ? t('proj.connect', f.slice(2).join(':')) : t('proj.scan'); continue; }
      if (f[0] === 'ok') {
        const [mac, ip] = st.slice(3).split('\t');
        $('#proj-mac').value = mac; $('#proj-mac').dispatchEvent(new Event('change'));
        res.textContent = t('proj.found', mac, ip); return;
      }
      if (f[0] === 'err') { res.textContent = ''; err.textContent = st === 'err:none' ? t('proj.none') : t('proj.fail', st.slice(4)); return; }
    }
    res.textContent = '';
  } catch (ex) { res.textContent = ''; err.textContent = ex.message; }
  finally { b.disabled = false; b.classList.remove('wait'); }
};
$('#tv-find').onclick = e => { tvFind(e.currentTarget).catch(ex => { $('#dlg-err').textContent = ex.message; }); };
// Ist keine IP eingetragen, wird automatisch gesucht (genau ein Treffer wird übernommen)
async function tvIpOrFind(b) {
  let ip = $('#tv-ip').value.trim();
  if (!ip) { await tvFind(b); ip = $('#tv-ip').value.trim(); }
  return ip;
}
$('#tv-pair').onclick = async e => {
  const b = e.currentTarget, err = $('#dlg-err'), res = $('#tv-res'); err.textContent = ''; res.textContent = '';
  try {
    const ip = await tvIpOrFind(b);
    if (!ip) return;
    if (!IP_RE.test(ip)) { err.textContent = t('tv.needIp'); return; }
    await tvBusy(b, async () => {
      await STNative.tv.pairStart(ip);
      const info = STNative.tv.info(); if (info.mac) tvMac = info.mac;
      tvSave({ip, paired: false, mac: tvMac}); buildTv();
      $('#tv-code-row').hidden = false; res.textContent = t('tv.codeShown'); $('#tv-code').value = ''; $('#tv-code').focus();
    });
  } catch (ex) { err.textContent = ex.message; }
};
$('#tv-code-go').onclick = e => {
  const code = $('#tv-code').value.trim().toLowerCase(), err = $('#dlg-err'), res = $('#tv-res'); err.textContent = '';
  if (!/^[0-9a-f]{6}$/.test(code)) { err.textContent = t('tv.needCode'); return; }
  tvBusy(e.currentTarget, async () => {
    await STNative.tv.pairFinish(code);
    tvSave({ip: tvLoad().ip, paired: true, mac: tvLoad().mac || tvMac}); buildTv();
    $('#tv-code-row').hidden = true; res.textContent = t('tv.paired');
  }).catch(ex => { err.textContent = ex.message; });
};
$('#tv-code').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); $('#tv-code-go').click(); } });
$('#tv-test').onclick = async e => {
  const b = e.currentTarget, err = $('#dlg-err'), res = $('#tv-res'); err.textContent = ''; res.textContent = '';
  try {
    const ip = await tvIpOrFind(b);
    if (!ip) return;
    if (!IP_RE.test(ip)) { err.textContent = t('tv.needIp'); return; }
    await tvBusy(b, async () => {
      await STNative.tv.connect(ip);
      tvSave({ip, paired: true, mac: tvLoad().mac || tvMac}); buildTv(); res.textContent = t('tv.connected');
    });
  } catch (ex) { err.textContent = ex.message; }
};
buildTv(); applyTabs();
