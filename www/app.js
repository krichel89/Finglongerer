'use strict';
const core = STCore.createCore(STNative);
const $ = (s, el = document) => el.querySelector(s);
let cfg = {speakers: [], groupName: 'Gruppe'}, state = [], dragging = false, inflight = 0, cfgSig = '';
let duoMode = null, duoBalRead = false, lastRefresh = 0;
const pending = {}; // Knopf-Schlüssel -> Ablaufzeit (Infinity solange der Befehl läuft)

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

// ---- Zustandsanzeige der Knöpfe: orange leuchtend = an, orange blinkend = wartet auf die Box
const online = () => state.filter(s => s.online);
const PRED = {
  'all-aux': () => online().length > 0 && online().every(s => s.source === 'AUX'),
  'all-off': () => online().length > 0 && online().every(s => s.standby),
  group: () => {
    const m = state.filter((s, i) => cfg.speakers[i] && cfg.speakers[i].group && s.ip);
    return m.length > 0 && m.every(s => s.online && s.source === 'AUX');
  },
  pair: () => { const L = state[+$('#sel-left').value]; return !!(L && L.group && L.group.paired); },
};
function pred(key) {
  if (key.startsWith('aux:')) { const s = state[+key.slice(4)]; return !!(s && s.online && s.source === 'AUX'); }
  if (key.startsWith('off:')) { const s = state[+key.slice(4)]; return !!(s && s.online && s.standby); }
  return PRED[key] ? PRED[key]() : false;
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

function badge(s) {
  if (!s.online) return ['nicht erreichbar', 'err'];
  if (s.standby) return ['Standby', ''];
  return [s.source === 'AUX' ? 'AUX' : (s.source || 'an'), 'on'];
}
function render() {
  const sig = JSON.stringify(cfg);
  if (sig !== cfgSig) { cfgSig = sig; fillSelects(); buildAdv(); }
  const g = cfg.speakers.filter(s => s.group && s.ip).length;
  const gb = $('#btn-group'); gb.hidden = g === 0; gb.textContent = 'Gruppe „' + cfg.groupName + '": AUX an';
  if (dragging) return;
  const box = $('#cards'); box.textContent = '';
  state.forEach((s, i) => {
    const [btxt, bcls] = badge(s);
    const vol = typeof s.volume === 'number' ? s.volume : 0;
    const sub = s.error ? s.error : (s.group && s.group.paired
      ? 'Stereopaar' + (s.group.role ? ' (' + (s.group.role === 'LEFT' ? 'links' : s.group.role === 'RIGHT' ? 'rechts' : s.group.role) + ')' : '')
      : s.ip);
    const slider = el('input', {type: 'range', min: 0, max: s.max, value: Math.min(vol, s.max), 'data-i': i, 'data-role': 'slider'});
    const v = el('span', {class: 'v', text: 'Lautstärke ' + (typeof s.volume === 'number' ? s.volume : '-') + ' / max ' + s.max});
    box.append(el('div', {class: 'card'},
      el('div', {class: 'head'}, el('h2', {text: s.name}), el('span', {class: 'badge ' + bcls, text: btxt})),
      el('div', {class: 'sub', text: sub}),
      el('div', {class: 'row2'},
        el('button', {text: 'AUX an', 'data-act': 'aux', 'data-i': i, 'data-key': 'aux:' + i}),
        el('button', {text: 'Aus', 'data-act': 'off', 'data-i': i, 'data-key': 'off:' + i})),
      el('div', {class: 'vol'},
        el('button', {text: '−', 'data-act': 'down', 'data-i': i}),
        slider,
        el('button', {text: '+', 'data-act': 'up', 'data-i': i}),
        v)));
  });
  updateDuo(); paint();
}
function fillSelects() {
  const l = $('#sel-left'), r = $('#sel-right');
  const pl = l.value, pr = r.value;
  for (const s of [l, r]) {
    s.textContent = '';
    cfg.speakers.forEach((sp, i) => s.append(el('option', {value: i, text: sp.name})));
  }
  l.value = pl !== '' && pl < cfg.speakers.length ? pl : 0;
  r.value = pr !== '' && pr < cfg.speakers.length ? pr : Math.min(1, cfg.speakers.length - 1);
}

// ---- Beide Boxen: Gesamtlautstärke + Balance
function duoIdx() { return [+$('#sel-left').value, +$('#sel-right').value]; }
function balText(b) { return b === 0 ? 'Balance: Mitte' : 'Balance: ' + (b < 0 ? 'links ' + (-b) : 'rechts ' + b) + ' %'; }
async function updateDuo() {
  if (dragging) return;
  const [li, ri] = duoIdx();
  const L = state[li], R = state[ri];
  const vol = $('#duo-vol'), bal = $('#duo-bal');
  if (!L || !R || li === ri) { $('#duo-mode').textContent = ''; return; }
  const cap = Math.min(L.max, R.max);
  vol.max = cap;
  const paired = !!(L.group && L.group.paired);
  const mode = paired ? 'pair' : 'virtual';
  $('#duo-mode').textContent = paired ? 'Stereopaar: echte Balance' : 'virtuelle Balance';
  $('#duo-mode').className = 'badge' + (paired ? ' on' : '');
  $('#duo-hint').textContent = paired
    ? 'Die Balance wird in den Boxen verstellt. Laut Bose entfällt im Stereopaar der AUX-Eingang – zum Umschalten auf AUX das Paar vorher auflösen.'
    : 'Ohne Stereopaar regelt die Balance die Lautstärke der beiden Boxen gegeneinander (die abgewandte Box wird leiser).';
  const vl = typeof L.volume === 'number' ? L.volume : 0, vr = typeof R.volume === 'number' ? R.volume : 0;
  const m = paired ? vl : Math.max(vl, vr);
  vol.value = Math.min(m, cap);
  $('#duo-vol-txt').textContent = 'Gesamtlautstärke ' + m + ' / max ' + cap;
  if (!paired) {
    let b = 0;
    if (vl < vr) b = Math.round((1 - vl / vr) * 20) * 5;
    else if (vr < vl) b = -Math.round((1 - vr / vl) * 20) * 5;
    bal.value = b; $('#duo-bal-txt').textContent = balText(b);
    duoBalRead = false;
  } else if (mode !== duoMode || !duoBalRead) {
    duoBalRead = true;
    try {
      const j = await api('/api/duo', {action: 'read', left: li, right: ri});
      if (typeof j.balance === 'number') { bal.value = j.balance; $('#duo-bal-txt').textContent = balText(j.balance); }
    } catch (e) { /* Balance bleibt wie sie ist */ }
  }
  duoMode = mode;
}
function sendDuo(vol) {
  const [li, ri] = duoIdx();
  if (li === ri) return toast('Links und rechts müssen verschieden sein', true);
  act('/api/duo', {action: 'set', left: li, right: ri, master: +(vol === undefined ? $('#duo-vol').value : vol), balance: +$('#duo-bal').value});
}

async function refresh(force) {
  if (!force && (document.hidden || inflight || dragging)) return;
  try { const j = await api('/api/state'); cfg = j.config; state = j.speakers; lastRefresh = Date.now(); render(); }
  catch (e) { toast(e.message, true); }
}

// ---- Bedienung
$('#cards').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-act]'); if (!b) return;
  const idx = +b.dataset.i, a = b.dataset.act;
  if (a === 'aux') act('/api/aux', {idx}, null, ['aux:' + idx]);
  else if (a === 'off') act('/api/off', {idx}, null, ['off:' + idx]);
  else if (a === 'up') act('/api/volume', {idx, delta: 3}, b);
  else if (a === 'down') act('/api/volume', {idx, delta: -3}, b);
});
document.addEventListener('pointerdown', ev => { if (ev.target.type === 'range') dragging = true; });
window.addEventListener('pointerup', () => { setTimeout(() => dragging = false, 50); });
$('#cards').addEventListener('input', ev => {
  if (ev.target.dataset.role === 'slider') {
    ev.target.parentElement.querySelector('.v').textContent = 'Lautstärke ' + ev.target.value + ' / max ' + ev.target.max;
  }
});
$('#cards').addEventListener('change', ev => {
  if (ev.target.dataset.role === 'slider') {
    dragging = false;
    act('/api/volume', {idx: +ev.target.dataset.i, value: +ev.target.value});
  }
});
$('#all-aux').onclick = () => act('/api/aux', {idx: 'all'}, null, ['all-aux']);
$('#all-off').onclick = () => act('/api/off', {idx: 'all'}, null, ['all-off']);
$('#btn-group').onclick = () => act('/api/group', {}, null, ['group']);
const duoChanged = () => { duoBalRead = false; updateDuo(); paint(); };
$('#btn-swap').onclick = () => { const l = $('#sel-left'), r = $('#sel-right'); const t = l.value; l.value = r.value; r.value = t; duoChanged(); };
$('#sel-left').onchange = $('#sel-right').onchange = duoChanged;
$('#duo-vol').addEventListener('input', e => { $('#duo-vol-txt').textContent = 'Gesamtlautstärke ' + e.target.value + ' / max ' + e.target.max; });
$('#duo-bal').addEventListener('input', e => { $('#duo-bal-txt').textContent = balText(+e.target.value); });
$('#duo-vol').addEventListener('change', () => { dragging = false; sendDuo(); });
$('#duo-bal').addEventListener('change', () => { dragging = false; sendDuo(); });
$('#duo-down').onclick = () => { const v = $('#duo-vol'); sendDuo(Math.max(0, +v.value - 3)); };
$('#duo-up').onclick = () => { const v = $('#duo-vol'); sendDuo(Math.min(+v.max, +v.value + 3)); };
$('#duo-center').onclick = () => { $('#duo-bal').value = 0; $('#duo-bal-txt').textContent = balText(0); sendDuo(); };
$('#btn-pair').onclick = () => {
  const left = +$('#sel-left').value, right = +$('#sel-right').value;
  if (left === right) return toast('Links und rechts müssen verschieden sein', true);
  act('/api/stereo', {action: 'pair', left, right}, null, ['pair']);
};
$('#btn-unpair').onclick = e => act('/api/stereo', {action: 'unpair', left: +$('#sel-left').value, right: +$('#sel-right').value}, e.currentTarget);

// ---- Erweitert: Boxen bearbeiten, automatische Suche
function addRow(sp) {
  const row = el('div', {class: 'srow'},
    el('input', {placeholder: 'Name', value: sp.name || '', maxLength: 40, 'data-f': 'name'}),
    el('input', {placeholder: '192.168.x.y', value: sp.ip || '', inputMode: 'decimal', 'data-f': 'ip'}),
    el('input', {placeholder: 'Max', value: sp.max || 70, type: 'number', min: 10, max: 100, 'data-f': 'max'}),
    el('button', {type: 'button', text: '✕', onclick: () => row.remove()}));
  row.dataset.group = sp.group ? '1' : '';
  $('#adv-rows').append(row);
  return row;
}
function buildAdv() {
  $('#adv-rows').textContent = '';
  (cfg.speakers.length ? cfg.speakers : [{}]).forEach(addRow);
}
$('#adv-add').onclick = () => addRow({max: 70});
$('#adv-save').onclick = async () => {
  const speakers = [...$('#adv-rows').children].map(r => ({
    name: $('[data-f=name]', r).value, ip: $('[data-f=ip]', r).value, max: +$('[data-f=max]', r).value || 70, group: !!r.dataset.group}));
  try { await api('/api/config', {speakers, groupName: cfg.groupName}); toast('Gespeichert'); }
  catch (e) { toast(e.message, true); }
  cfgSig = ''; refresh(true);
};
function takeFound(f) {
  const rows = [...$('#adv-rows').children];
  const val = (r, k) => $('[data-f=' + k + ']', r).value.trim();
  if (rows.some(r => val(r, 'ip') === f.ip)) return;
  const row = rows.find(r => val(r, 'ip') === '' && val(r, 'name').toLowerCase() === f.name.toLowerCase())
    || rows.find(r => val(r, 'ip') === '' && val(r, 'name') === '');
  if (row) { $('[data-f=ip]', row).value = f.ip; if (!val(row, 'name')) $('[data-f=name]', row).value = f.name; }
  else addRow({name: f.name, ip: f.ip, max: 70});
}
$('#scan-go').onclick = async e => {
  const b = e.currentTarget, v = $('#scan-net').value.trim();
  b.disabled = true; b.classList.add('wait'); toast('Suche läuft ...');
  try {
    const j = await api('/api/scan', v ? {prefixes: v.split(/[,\s]+/).filter(Boolean)} : {});
    const box = $('#scan-res'); box.textContent = ''; box.className = 'found';
    toast(j.found.length + ' Box(en) gefunden (' + j.prefixes.join(', ') + ')', j.found.length === 0);
    const known = new Set(cfg.speakers.map(s => s.ip));
    j.found.forEach(f => box.append(el('button', {
      type: 'button', text: '+ ' + f.name + ' · ' + f.ip + (f.type ? ' · ' + f.type : '') + (known.has(f.ip) ? ' (schon eingetragen)' : ''),
      disabled: known.has(f.ip), onclick: ev => { takeFound(f); ev.currentTarget.disabled = true; toast('Übernommen – unten „Boxen speichern" drücken'); }})));
    if (j.found.filter(f => !known.has(f.ip)).length > 1)
      box.append(el('button', {type: 'button', text: 'Alle übernehmen', onclick: () => {
        j.found.forEach(takeFound); [...box.querySelectorAll('button')].forEach(x => { x.disabled = true; });
        toast('Übernommen – unten „Boxen speichern" drücken'); }}));
  } catch (err) { toast(err.message, true); }
  finally { b.disabled = false; b.classList.remove('wait'); }
};

// ---- Einstellungen (Gruppe, Version)
$('#btn-settings').onclick = () => {
  $('#grp-name').value = cfg.groupName;
  const box = $('#grp-members'); box.textContent = '';
  cfg.speakers.forEach((s, i) => box.append(el('label', {},
    el('input', {type: 'checkbox', checked: !!s.group, 'data-i': i}), el('span', {text: s.name}))));
  $('#version').textContent = 'Version ' + (window.APP_VERSION || '?');
  $('#dlg').showModal();
};
$('#dlg-form').addEventListener('submit', async ev => {
  if (ev.submitter && ev.submitter.value !== 'ok') return;
  const speakers = cfg.speakers.map((s, i) => Object.assign({}, s, {group: $('#grp-members input[data-i="' + i + '"]').checked}));
  try { await api('/api/config', {speakers, groupName: $('#grp-name').value}); toast('Gespeichert'); }
  catch (e) { toast(e.message, true); }
  refresh(true);
});
document.addEventListener('visibilitychange', () => refresh());
refresh(true);
setInterval(() => { if (Object.keys(pending).length || Date.now() - lastRefresh >= 5000) refresh(); }, 1500);
