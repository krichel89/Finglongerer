'use strict';
const core = STCore.createCore(STNative);
const $ = (s, el = document) => el.querySelector(s);
let cfg = {speakers: []}, state = [], dragging = false, inflight = 0, cfgSig = '', duoMode = null, duoBalRead = false;

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
async function act(path, body, btn) {
  inflight++; if (btn) btn.disabled = true;
  toast('Sende ...');
  try { const j = await api(path, body); toast(j.message || 'OK'); }
  catch (e) { toast(e.message, true); }
  finally { inflight--; if (btn) btn.disabled = false; refresh(); }
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
function badge(s) {
  if (!s.online) return ['nicht erreichbar', 'err'];
  if (s.standby) return ['Standby', ''];
  return [s.source === 'AUX' ? 'AUX' : (s.source || 'an'), 'on'];
}
function render() {
  const sig = JSON.stringify(cfg);
  if (sig !== cfgSig) { cfgSig = sig; fillSelects(); }
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
    const card = el('div', {class: 'card'},
      el('div', {class: 'head'}, el('h2', {text: s.name}), el('span', {class: 'badge ' + bcls, text: btxt})),
      el('div', {class: 'sub', text: sub}),
      el('div', {class: 'row2'},
        el('button', {class: 'primary', text: 'AUX an', 'data-act': 'aux', 'data-i': i}),
        el('button', {text: 'Aus', 'data-act': 'off', 'data-i': i})),
      el('div', {class: 'vol'},
        el('button', {text: '−', 'data-act': 'down', 'data-i': i}),
        slider,
        el('button', {text: '+', 'data-act': 'up', 'data-i': i}),
        v));
    box.append(card);
  });
  updateDuo();
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
async function refresh() {
  if (document.hidden || inflight || dragging) return;
  try { const j = await api('/api/state'); cfg = j.config; state = j.speakers; render(); }
  catch (e) { toast(e.message, true); }
}
$('#cards').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-act]'); if (!b) return;
  const idx = +b.dataset.i;
  if (b.dataset.act === 'aux') act('/api/aux', {idx}, b);
  else if (b.dataset.act === 'off') act('/api/off', {idx}, b);
  else if (b.dataset.act === 'up') act('/api/volume', {idx, delta: 3}, b);
  else if (b.dataset.act === 'down') act('/api/volume', {idx, delta: -3}, b);
});
const cardsEl = $('#cards');
document.addEventListener('pointerdown', ev => { if (ev.target.type === 'range') dragging = true; });
window.addEventListener('pointerup', () => { setTimeout(() => dragging = false, 50); });
cardsEl.addEventListener('input', ev => {
  if (ev.target.dataset.role === 'slider') {
    const v = ev.target.parentElement.querySelector('.v');
    v.textContent = 'Lautstärke ' + ev.target.value + ' / max ' + ev.target.max;
  }
});
cardsEl.addEventListener('change', ev => {
  if (ev.target.dataset.role === 'slider') {
    dragging = false;
    act('/api/volume', {idx: +ev.target.dataset.i, value: +ev.target.value});
  }
});
$('#all-aux').onclick = e => act('/api/aux', {idx: 'all'}, e.currentTarget);
$('#all-off').onclick = e => act('/api/off', {idx: 'all'}, e.currentTarget);
$('#btn-swap').onclick = () => { const l = $('#sel-left'), r = $('#sel-right'); const t = l.value; l.value = r.value; r.value = t; duoBalRead = false; updateDuo(); };
$('#sel-left').onchange = $('#sel-right').onchange = () => { duoBalRead = false; updateDuo(); };
$('#duo-vol').addEventListener('input', e => { $('#duo-vol-txt').textContent = 'Gesamtlautstärke ' + e.target.value + ' / max ' + e.target.max; });
$('#duo-bal').addEventListener('input', e => { $('#duo-bal-txt').textContent = balText(+e.target.value); });
$('#duo-vol').addEventListener('change', () => { dragging = false; sendDuo(); });
$('#duo-bal').addEventListener('change', () => { dragging = false; sendDuo(); });
$('#duo-down').onclick = () => { const v = $('#duo-vol'); sendDuo(Math.max(0, +v.value - 3)); };
$('#duo-up').onclick = () => { const v = $('#duo-vol'); sendDuo(Math.min(+v.max, +v.value + 3)); };
$('#duo-center').onclick = () => { $('#duo-bal').value = 0; $('#duo-bal-txt').textContent = balText(0); sendDuo(); };
$('#btn-pair').onclick = e => {
  const left = +$('#sel-left').value, right = +$('#sel-right').value;
  if (left === right) return toast('Links und rechts müssen verschieden sein', true);
  act('/api/stereo', {action: 'pair', left, right}, e.currentTarget);
};
$('#btn-unpair').onclick = e => act('/api/stereo', {action: 'unpair', left: +$('#sel-left').value, right: +$('#sel-right').value}, e.currentTarget);

// Einstellungen
function addRow(sp) {
  const row = el('div', {class: 'srow'},
    el('input', {placeholder: 'Name', value: sp.name || '', maxLength: 40, 'data-f': 'name'}),
    el('input', {placeholder: '192.168.x.y', value: sp.ip || '', inputMode: 'decimal', 'data-f': 'ip'}),
    el('input', {placeholder: 'Max', value: sp.max || 70, type: 'number', min: 10, max: 100, 'data-f': 'max'}),
    el('button', {type: 'button', text: '✕', onclick: () => row.remove()}));
  $('#dlg-rows').append(row);
}
$('#btn-settings').onclick = () => {
  $('#dlg-rows').textContent = '';
  (cfg.speakers.length ? cfg.speakers : [{}]).forEach(addRow);
  $('#dlg').showModal();
};
$('#dlg-add').onclick = () => addRow({max: 70});
$('#dlg-form').addEventListener('submit', async ev => {
  if (ev.submitter && ev.submitter.value !== 'ok') return;
  const speakers = [...$('#dlg-rows').children].map(r => ({
    name: $('[data-f=name]', r).value, ip: $('[data-f=ip]', r).value, max: +$('[data-f=max]', r).value || 70}));
  try { await api('/api/config', {speakers}); toast('Gespeichert'); }
  catch (e) { toast(e.message, true); }
  refresh();
});
document.addEventListener('visibilitychange', refresh);
refresh(); setInterval(refresh, 5000);
