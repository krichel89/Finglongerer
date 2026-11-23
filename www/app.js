'use strict';
const core = STCore.createCore(STNative);
const $ = (s, el = document) => el.querySelector(s);
let cfg = {speakers: [], groups: []}, state = [], dragging = false, inflight = 0, cfgSig = '', lastRefresh = 0;
const pending = {};            // Knopf-Schlüssel -> Ablaufzeit (Infinity solange der Befehl läuft)
const balCache = {}, balRead = {}; // pro Gruppe: letzte bekannte Stereopaar-Balance / schon gelesen?
const newId = () => Math.random().toString(36).slice(2, 8);

// ---- gemerkter Zustand der Oberfläche: Reihenfolge, aufgeklappte Einträge
const UI_KEY = 'steasyremote.ui';
const ui = {order: [], open: {}, sort: false};
try { const r = STNative.storage.getItem(UI_KEY); if (r) { const o = JSON.parse(r); ui.order = o.order || []; ui.open = o.open || {}; } } catch (e) { /* neu anfangen */ }
const saveUi = () => { try { STNative.storage.setItem(UI_KEY, JSON.stringify({order: ui.order, open: ui.open})); } catch (e) { /* egal */ } };
const presetNames = {};

async function api(path, body) {
  // Direkt an die Boxen (kein Server): Kernlogik aus core.js, Transport aus native.js
  const j = await core.route(path, body);
  if (j && j.ok === false) throw new Error(j.error || 'Fehler');
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
  const [, gid, what] = key.split(':');
  const g = cfg.groups.find(x => x.id === gid); if (!g) return false;
  const S = gState(g);
  if (what === 'aux') return S.length > 0 && S.every(s => s.online && s.source === 'AUX');
  if (what === 'bt') return S.length > 0 && S.every(s => s.online && s.source === 'BLUETOOTH');
  if (what === 'off') return S.length > 0 && S.every(s => s.online && s.standby);
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
  toast('Sende ...');
  try {
    const j = await api(path, body); toast(j.message || 'OK');
    keys.forEach(k => { if (pending[k] === Infinity) pending[k] = Date.now() + 12000; });
  } catch (e) { toast(e.message, true); keys.forEach(k => { delete pending[k]; }); }
  finally { inflight--; if (btn) btn.disabled = false; await refresh(true); paint(); }
}

// ---- Anzeige: Gruppen und Einzelboxen gleichrangig
function sourceBadge(S) {
  if (!S.length || S.every(s => !s.online)) return ['nicht erreichbar', 'err'];
  const off = S.filter(s => !s.online).length;
  if (off) return [off + ' nicht erreichbar', 'err'];
  if (S.every(s => s.standby)) return ['Standby', ''];
  if (S.every(s => s.source === 'AUX')) return ['AUX', 'on'];
  if (S.every(s => s.source === 'BLUETOOTH')) return ['Bluetooth', 'on'];
  if (S.every(s => s.source === S[0].source)) return [S[0].source || 'an', 'on'];
  return ['gemischt', ''];
}
function balText(b) { return b === 0 ? 'Balance: Mitte' : 'Balance: ' + (b < 0 ? 'links ' + (-b) : 'rechts ' + b) + ' %'; }
function volText(m, cap) { return 'Gesamtlautstärke ' + m + ' / max ' + cap; }

function entries() {
  const all = cfg.groups.map(g => ({key: 'g:' + g.id, g})).concat(cfg.speakers.map((s, i) => ({key: 'b:' + s.id, i})));
  const byKey = new Map(all.map(e => [e.key, e])), out = [];
  ui.order.forEach(k => { if (byKey.has(k)) { out.push(byKey.get(k)); byKey.delete(k); } });
  byKey.forEach(e => out.push(e));
  return out;
}
const srcRow = (act, key) => el('div', {class: 'row3'},
  el('button', {text: 'AUX an', 'data-act': act + 'aux', 'data-key': key('aux')}),
  el('button', {text: 'Bluetooth', 'data-act': act + 'bt', 'data-key': key('bt')}),
  el('button', {text: 'Aus', 'data-act': act + 'off', 'data-key': key('off')}));

async function loadPresetNames(ekey) {
  if (ekey in presetNames) return;
  presetNames[ekey] = {};
  const card = $('[data-ekey="' + ekey + '"]'); if (!card) return;
  const body = card.dataset.gid ? {gid: card.dataset.gid, action: 'presets'} : {idx: +card.dataset.i};
  try {
    const j = await api(card.dataset.gid ? '/api/group' : '/api/presets', body);
    const names = {}; (j.presets || []).forEach(p => { if (p.name) names[p.n] = p.name; });
    presetNames[ekey] = names;
    document.querySelectorAll('[data-ekey="' + ekey + '"] [data-act=preset]').forEach(b => {
      b.textContent = b.dataset.n + (names[b.dataset.n] ? ' · ' + names[b.dataset.n] : ''); });
  } catch (e) { /* ohne Namen */ }
}
function presetBlock(ekey) {
  const d = el('details', {class: 'presets'}, el('summary', {text: 'Sender (Tasten 1–6)'}));
  const names = presetNames[ekey] || {}, grid = el('div', {class: 'pgrid'});
  for (let n = 1; n <= 6; n++) grid.append(el('button', {text: n + (names[n] ? ' · ' + names[n] : ''), 'data-act': 'preset', 'data-n': n}));
  d.append(grid);
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
  const sub = n === 2 ? 'Links: ' + S[0].name + ' · Rechts: ' + S[1].name : S.map(s => s.name).join(' · ');
  const kids = [
    el('div', {class: 'head'}, el('div', {class: 'sub', text: sub}),
      n === 2 ? el('button', {class: 'swap', text: '⇆', title: 'Links/Rechts tauschen', 'data-act': 'gswap'}) : null),
    srcRow('g', w => 'g:' + g.id + ':' + w),
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
        el('span', {class: 'v', text: balText(b) + (paired ? ' (echt)' : ' (virtuell)')}),
        el('button', {class: 'small', text: 'Mitte', 'data-act': 'gcenter'})),
      el('div', {class: 'row2'},
        el('button', {text: 'Stereopaar bilden', 'data-act': 'gpair', 'data-key': 'g:' + g.id + ':pair'}),
        el('button', {text: 'Auflösen', 'data-act': 'gunpair'})),
      el('p', {class: 'hint', text: paired
        ? 'Die Balance wird in den Boxen verstellt. Laut Bose entfällt im Stereopaar der AUX-Eingang – zum Umschalten auf AUX das Paar vorher auflösen.'
        : 'Ohne Stereopaar regelt die Balance die Lautstärke der beiden Boxen gegeneinander (die abgewandte Box wird leiser).'}));
    if (paired && !balRead[g.id]) {
      balRead[g.id] = true;
      api('/api/group', {gid: g.id, action: 'read'}).then(j => {
        if (typeof j.balance !== 'number') return;
        balCache[g.id] = j.balance;
        const r = $('[data-gid="' + g.id + '"] [data-role=gbal]');
        if (r && !dragging) { r.value = j.balance; r.parentElement.querySelector('.v').textContent = balText(j.balance) + ' (echt)'; }
      }).catch(() => { /* Balance bleibt wie sie ist */ });
    }
  }
  kids.push(presetBlock(ekey));
  return kids;
}
function boxBody(s, i, ekey) {
  const vol = typeof s.volume === 'number' ? s.volume : 0;
  const sub = s.error ? s.error : (s.group && s.group.paired
    ? 'Stereopaar' + (s.group.role ? ' (' + (s.group.role === 'LEFT' ? 'links' : s.group.role === 'RIGHT' ? 'rechts' : s.group.role) + ')' : '')
    : s.ip);
  return [
    el('div', {class: 'sub', text: sub}),
    srcRow('', w => w + ':' + i),
    el('div', {class: 'vol'},
      el('button', {text: '−', 'data-act': 'down', 'data-i': i}),
      el('input', {type: 'range', min: 0, max: s.max, value: Math.min(vol, s.max), 'data-i': i, 'data-role': 'slider'}),
      el('button', {text: '+', 'data-act': 'up', 'data-i': i}),
      el('span', {class: 'v', text: 'Lautstärke ' + (typeof s.volume === 'number' ? s.volume : '-') + ' / max ' + s.max})),
    presetBlock(ekey)];
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
  const card = el('div', props, head);
  if (open) card.append(el('div', {class: 'ebody'}, ...(e.g ? groupBody(e.g, e.key) : boxBody(state[e.i] || {name: '?', max: 70}, e.i, e.key))));
  return card;
}

function render() {
  cfgSig = JSON.stringify(cfg);
  if (dragging) return;
  const box = $('#groups'); box.textContent = '';
  const list = entries();
  if (!list.length) box.append(el('div', {class: 'card'}, el('p', {class: 'hint', text: 'Noch keine Box. Unter ⚙ Einstellungen kannst du Boxen suchen und Gruppen anlegen.'})));
  list.forEach((e, pos) => box.append(entryCard(e, pos, list.length)));
  $('#btn-sort').classList.toggle('lit', ui.sort);
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
document.addEventListener('click', async ev => {
  const b = ev.target.closest('button[data-act]'); if (!b) return;
  const a = b.dataset.act, card = b.closest('[data-gid]'), gid = card && card.dataset.gid;
  const ecard = b.closest('[data-ekey]'), ekey = ecard && ecard.dataset.ekey;
  const idx = +(b.dataset.i !== undefined ? b.dataset.i : (ecard && ecard.dataset.i));
  if (a === 'toggle') { ui.open[ekey] = !ui.open[ekey]; saveUi(); dragging = false; render(); }
  else if (a === 'eup' || a === 'edown') {
    const keys = entries().map(e => e.key), p = keys.indexOf(ekey), q = p + (a === 'eup' ? -1 : 1);
    if (q >= 0 && q < keys.length) { [keys[p], keys[q]] = [keys[q], keys[p]]; ui.order = keys; saveUi(); render(); }
  }
  else if (a === 'preset') {
    const n = +b.dataset.n;
    if (ecard.dataset.gid) act('/api/group', {gid: ecard.dataset.gid, action: 'preset', n}, b);
    else act('/api/preset', {idx: +ecard.dataset.i, n}, b);
  }
  else if (a === 'bt') act('/api/bt', {idx}, null, ['bt:' + idx]);
  else if (a === 'gbt') act('/api/group', {gid, action: 'bt'}, null, ['g:' + gid + ':bt']);
  else if (a === 'aux') act('/api/aux', {idx}, null, ['aux:' + idx]);
  else if (a === 'off') act('/api/off', {idx}, null, ['off:' + idx]);
  else if (a === 'up') act('/api/volume', {idx, delta: 3}, b);
  else if (a === 'down') act('/api/volume', {idx, delta: -3}, b);
  else if (a === 'gaux') act('/api/group', {gid, action: 'aux'}, null, ['g:' + gid + ':aux']);
  else if (a === 'goff') act('/api/group', {gid, action: 'off'}, null, ['g:' + gid + ':off']);
  else if (a === 'gup' || a === 'gdown') {
    const v = card.querySelector('[data-role=gvol]');
    gSend(card, Math.max(0, Math.min(+v.max, +v.value + (a === 'gup' ? 3 : -3))));
  } else if (a === 'gcenter') {
    const r = card.querySelector('[data-role=gbal]'); r.value = 0; r.parentElement.querySelector('.v').textContent = balText(0); gSend(card);
  } else if (a === 'gpair') { balRead[gid] = false; act('/api/group', {gid, action: 'pair'}, null, ['g:' + gid + ':pair']); }
  else if (a === 'gunpair') { balRead[gid] = false; act('/api/group', {gid, action: 'unpair'}, b); }
  else if (a === 'gswap') {
    const groups = cfg.groups.map(g => g.id === gid ? Object.assign({}, g, {members: g.members.slice().reverse()}) : g);
    try { await api('/api/config', {speakers: cfg.speakers, groups}); balRead[gid] = false; } catch (e) { toast(e.message, true); }
    refresh(true);
  }
});
document.addEventListener('pointerdown', ev => { if (ev.target.type === 'range') dragging = true; });
window.addEventListener('pointerup', () => { setTimeout(() => dragging = false, 50); });
document.addEventListener('input', ev => {
  const t = ev.target, role = t.dataset && t.dataset.role; if (!role) return;
  const v = t.parentElement.querySelector('.v');
  if (role === 'slider') v.textContent = 'Lautstärke ' + t.value + ' / max ' + t.max;
  else if (role === 'gvol') v.textContent = volText(t.value, t.max);
  else if (role === 'gbal') v.textContent = balText(+t.value);
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
    el('input', {placeholder: 'Name', value: sp.name || '', maxLength: 40, 'data-f': 'name', oninput: renderGroupEditor}),
    el('input', {placeholder: '192.168.x.y', value: sp.ip || '', inputMode: 'decimal', 'data-f': 'ip'}),
    el('input', {placeholder: 'Max', value: sp.max || 70, type: 'number', min: 10, max: 100, 'data-f': 'max'}),
    el('button', {type: 'button', text: '✕', onclick: () => {
      editGroups.forEach(g => { g.members = g.members.filter(id => id !== row.dataset.id); });
      row.remove(); renderGroupEditor(); }}));
  $('#set-rows').append(row);
  return row;
}
function renderGroupEditor() {
  const box = $('#grp-edit'); box.textContent = '';
  const rows = rowsOf().map(r => ({id: r.dataset.id, name: rowVal(r, 'name') || 'Box'}));
  editGroups.forEach((g, gi) => {
    const members = el('div', {class: 'members inline'});
    rows.forEach(r => members.append(el('label', {},
      el('input', {type: 'checkbox', checked: g.members.includes(r.id), onchange: e => {
        g.members = e.target.checked ? g.members.concat(r.id) : g.members.filter(id => id !== r.id); }}),
      el('span', {text: r.name}))));
    box.append(el('div', {class: 'gedit'},
      el('div', {class: 'ghead'},
        el('input', {value: g.name, maxLength: 30, placeholder: 'Name der Gruppe', oninput: e => { g.name = e.target.value; }}),
        el('button', {type: 'button', text: '✕', title: 'Gruppe löschen', onclick: () => { editGroups.splice(gi, 1); renderGroupEditor(); }})),
      members));
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
  $('#scan-res').textContent = ''; $('#dlg-err').textContent = '';
  $('#version').textContent = 'Version ' + (window.APP_VERSION || '?');
  $('#dlg').showModal();
};
$('#set-add').onclick = () => { addRow({max: 70}); renderGroupEditor(); };
$('#grp-add').onclick = () => { editGroups.push({name: 'Gruppe ' + (editGroups.length + 1), members: []}); renderGroupEditor(); };
$('#scan-go').onclick = async e => {
  const b = e.currentTarget, v = $('#scan-net').value.trim(), err = $('#dlg-err');
  b.disabled = true; b.classList.add('wait'); err.textContent = ''; $('#scan-res').textContent = '';
  try {
    const j = await api('/api/scan', v ? {prefixes: v.split(/[,\s]+/).filter(Boolean)} : {});
    const box = $('#scan-res'); box.className = 'found';
    const known = new Set(rowsOf().map(r => rowVal(r, 'ip')));
    if (!j.found.length) err.textContent = 'Keine Box gefunden (Suchbereich: ' + j.prefixes.join(', ') + ')';
    j.found.forEach(f => box.append(el('button', {
      type: 'button', text: '+ ' + f.name + ' · ' + f.ip + (f.type ? ' · ' + f.type : '') + (known.has(f.ip) ? ' (schon eingetragen)' : ''),
      disabled: known.has(f.ip), onclick: ev => { takeFound(f); ev.currentTarget.disabled = true; }})));
    if (j.found.filter(f => !known.has(f.ip)).length > 1)
      box.append(el('button', {type: 'button', text: 'Alle übernehmen', onclick: () => {
        j.found.forEach(takeFound); [...box.querySelectorAll('button')].forEach(x => { x.disabled = true; }); }}));
  } catch (ex) { err.textContent = ex.message; }
  finally { b.disabled = false; b.classList.remove('wait'); }
};
$('#dlg-form').addEventListener('submit', async ev => {
  if (ev.submitter && ev.submitter.value !== 'ok') return; // Abbrechen: schließt einfach
  ev.preventDefault();
  const speakers = rowsOf().map(r => ({id: r.dataset.id, name: rowVal(r, 'name'), ip: rowVal(r, 'ip'), max: +rowVal(r, 'max') || 70}));
  try {
    await api('/api/config', {speakers, groups: editGroups});
    $('#dlg').close(); toast('Gespeichert'); refresh(true);
  } catch (e) { $('#dlg-err').textContent = e.message; }
});

$('#btn-sort').onclick = () => { ui.sort = !ui.sort; dragging = false; render(); };
document.addEventListener('visibilitychange', () => refresh());
refresh(true);
setInterval(() => { if (Object.keys(pending).length || Date.now() - lastRefresh >= 5000) refresh(); }, 1500);
