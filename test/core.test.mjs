// Test der Kernlogik gegen simulierte Boxen (test/mock_st.py). Aufruf: npm test
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const STCore = require('../www/core.js');

const mocks = [['127.0.0.2', 'Musikzimmer', 'DEV-A'], ['127.0.0.3', 'Bibliothek', 'DEV-B']]
  .map(a => spawn('python3', [new URL('./mock_st.py', import.meta.url).pathname, ...a], { stdio: 'ignore' }));
const stop = () => mocks.forEach(m => m.kill());
process.on('exit', stop);
await new Promise(r => setTimeout(r, 1200));

function nodeHttp(method, ip, port, path, body, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: ip, port, path, method, timeout,
      headers: body ? { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) } : {} }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => res.statusCode >= 400 ? reject(new Error('HTTP ' + res.statusCode)) : resolve(d));
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const mem = {};
const storage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } };
const core = STCore.createCore({ http: nodeHttp, WebSocket, storage, scanTimeout: 400 }); // wsPorts Standard: 8080 (verweigert) -> 8090

let n = 0;
const ok = (name) => console.log('ok', ++n, name);
const call = (p, b) => core.route(p, b);

try {
  await assert.rejects(call('/api/config', { speakers: [{ name: 'X', ip: '8.8.8.8' }] }), /Ungültige IP/); ok('öffentliche IP abgelehnt');

  // Übernahme einer Konfiguration der Version 0.2 (Markierung an den Boxen, eine Gruppe)
  mem['steasyremote.config'] = JSON.stringify({ groupName: 'Gruppe', speakers: [
    { name: 'Musikzimmer', ip: '127.0.0.2', max: 70, group: true }, { name: 'Bibliothek', ip: '127.0.0.3', max: 60, group: true }] });
  let st = await call('/api/state');
  assert.equal(st.config.groups.length, 1); assert.equal(st.config.groups[0].name, 'Beide Boxen'); assert.equal(st.config.groups[0].members.length, 2);
  const [A, B] = st.config.speakers.map(x => x.id); assert.ok(A && B && A !== B);
  assert.equal((await call('/api/state')).config.speakers[0].id, A); ok('Übernahme alter Config: Gruppe „Beide Boxen", IDs bleiben stabil');
  const G = st.config.groups[0].id;

  assert.equal(st.speakers[0].standby, true); assert.equal(st.speakers[1].group.paired, false); ok('Status: beide im Standby, kein Paar');
  const t0 = Date.now();
  let r = await call('/api/group', { gid: G, action: 'aux' });
  assert.match(r.message, /Musikzimmer: AUX an/); assert.match(r.message, /Bibliothek: AUX an/);
  st = await call('/api/state'); assert.equal(st.speakers[0].source, 'AUX'); ok('Gruppe: AUX an (weckt aus Standby, ' + (Date.now() - t0) + ' ms)');

  r = await call('/api/volume', { idx: 0, value: 90 }); assert.match(r.message, /Lautstärke 70/); ok('einzelne Box: Lautstärke begrenzt auf max');
  r = await call('/api/volume', { idx: 1, delta: -9 }); st = await call('/api/state'); assert.equal(st.speakers[1].volume, 11); ok('einzelne Box: Lautstärke relativ (20-9)');

  r = await call('/api/group', { gid: G, action: 'volume', master: 40, balance: 50 });
  assert.match(r.message, /links 20, rechts 40/); ok('2er-Gruppe: virtuelle Balance +50 → links 20, rechts 40');
  r = await call('/api/group', { gid: G, action: 'volume', master: 99, balance: -25 });
  assert.match(r.message, /links 60, rechts 45/); ok('Gesamtlautstärke auf kleineres max (60) begrenzt, Balance -25');
  r = await call('/api/group', { gid: G, action: 'read' }); assert.equal(r.mode, 'virtual'); ok('ungepaart = virtual');

  r = await call('/api/group', { gid: G, action: 'pair' }); assert.match(r.message, /gebildet/); ok('Stereopaar bilden');
  r = await call('/api/group', { gid: G, action: 'read' }); assert.equal(r.mode, 'pair'); assert.equal(r.balance, 0); ok('gepaart, Balance 0');
  r = await call('/api/group', { gid: G, action: 'volume', master: 30, balance: 50 });
  assert.match(r.message, /Stereopaar: Lautstärke 30, Balance \+4/); ok('echte Balance per WebSocket (Port 8080 verweigert → Fallback 8090)');
  r = await call('/api/group', { gid: G, action: 'read' }); assert.equal(r.balance, 57); ok('Balance zurückgelesen (+4/7 = 57 %)');
  await call('/api/group', { gid: G, action: 'volume', master: 30, balance: -100 });
  r = await call('/api/group', { gid: G, action: 'read' }); assert.equal(r.balance, -100); ok('Balance -100 → -7');
  r = await call('/api/group', { gid: G, action: 'unpair' }); assert.match(r.message, /aufgelöst/); ok('Stereopaar auflösen');
  r = await call('/api/group', { gid: G, action: 'unpair' }); assert.match(r.message, /Kein Stereopaar/); ok('erneut auflösen: nichts zu tun');

  r = await call('/api/group', { gid: G, action: 'off' }); assert.match(r.message, /Musikzimmer: aus/);
  r = await call('/api/group', { gid: G, action: 'off' }); assert.match(r.message, /war schon aus/); ok('Gruppe: Aus / erneut Aus');

  r = await call('/api/scan', { prefixes: ['127.0.0'] }); assert.deepEqual(r.found.map(f => f.ip + '|' + f.name + '|' + f.type), ['127.0.0.2|Musikzimmer|SoundTouch 10', '127.0.0.3|Bibliothek|SoundTouch 10']); ok('Auto-Suche findet beide Boxen');
  await assert.rejects(call('/api/scan', { prefixes: ['8.8.8'] }), /Ungültiger Suchbereich/); ok('Auto-Suche lehnt öffentliche Netze ab');

  // 3er-Gruppe, mehrere Gruppen, Gruppe mit einer Box
  const cfg3 = { speakers: [
    { id: 'a', name: 'Musikzimmer', ip: '127.0.0.2', max: 70 }, { id: 'b', name: 'Bibliothek', ip: '127.0.0.3', max: 60 }, { id: 'c', name: 'Küche', ip: '127.0.0.4', max: 50 }],
    groups: [{ id: 'g1', name: 'Alle drei', members: ['a', 'b', 'c'] }, { id: 'g2', name: 'Nur Musik', members: ['a'] }, { id: 'g3', name: 'Leer', members: ['x'] }] };
  r = await call('/api/config', cfg3); assert.equal(r.config.groups.length, 2); ok('Gruppen ohne gültige Mitglieder werden verworfen');
  const m3 = spawn('python3', [new URL('./mock_st.py', import.meta.url).pathname, '127.0.0.4', 'Küche', 'DEV-C'], { stdio: 'ignore' }); mocks.push(m3);
  await new Promise(r => setTimeout(r, 800));
  r = await call('/api/group', { gid: 'g1', action: 'aux' }); assert.match(r.message, /Küche: AUX an/); ok('3er-Gruppe: AUX an');
  r = await call('/api/group', { gid: 'g1', action: 'volume', master: 65, balance: 0 });
  st = await call('/api/state'); assert.deepEqual(st.speakers.map(x => x.volume), [65, 60, 50]); ok('3er-Gruppe: Lautstärke je Box auf deren max begrenzt');
  await assert.rejects(call('/api/group', { gid: 'g1', action: 'pair' }), /genau zwei/); ok('Stereopaar nur mit zwei Boxen');
  r = await call('/api/group', { gid: 'g2', action: 'off' }); st = await call('/api/state'); assert.equal(st.speakers[0].standby, true); assert.equal(st.speakers[1].standby, false); ok('Gruppe mit einer Box wirkt nur auf diese');
  // Bluetooth direkt, Ersatzweg, Gruppe; Presets
  r = await call('/api/bt', { idx: 0 }); st = await call('/api/state'); assert.equal(st.speakers[0].source, 'BLUETOOTH'); ok('Bluetooth per /select');
  r = await call('/api/group', { gid: 'g1', action: 'bt' }); st = await call('/api/state'); assert.deepEqual(st.speakers.map(x => x.source), ['BLUETOOTH', 'BLUETOOTH', 'BLUETOOTH']); ok('Gruppe: Bluetooth');
  r = await call('/api/group', { gid: 'g1', action: 'aux' }); st = await call('/api/state'); assert.equal(st.speakers[1].source, 'AUX'); ok('zurück auf AUX');
  const dbg = ip => nodeHttp('GET', ip, 8090, '/_dbg', null, 2000);
  r = await call('/api/preset', { idx: 1, n: 4 }); assert.equal(await dbg('127.0.0.3'), '4'); ok('einzelne Box: Taste 4');
  r = await call('/api/group', { gid: 'g1', action: 'preset', n: 2 }); assert.deepEqual([await dbg('127.0.0.2'), await dbg('127.0.0.3'), await dbg('127.0.0.4')], ['2', '2', '2']); ok('Gruppe: Taste 2 an allen Boxen');
  await assert.rejects(call('/api/preset', { idx: 0, n: 9 }), /Taste 1 bis 6/); ok('Taste 9 abgelehnt');
  r = await call('/api/presets', { idx: 0 }); assert.deepEqual(r.presets, [{ n: 1, name: 'Radio Eins' }, { n: 3, name: 'Klassik' }]); ok('Sendernamen aus /presets');
  const m5 = spawn('python3', [new URL('./mock_st.py', import.meta.url).pathname, '127.0.0.5', 'Flur', 'DEV-E'], { stdio: 'ignore', env: { ...process.env, MOCK_NO_BT_SELECT: '1' } }); mocks.push(m5);
  await new Promise(r => setTimeout(r, 800));
  await call('/api/config', { speakers: [{ id: 'e', name: 'Flur', ip: '127.0.0.5', max: 50 }], groups: [] });
  r = await call('/api/bt', { idx: 0 }); st = await call('/api/state'); assert.equal(st.speakers[0].source, 'BLUETOOTH'); ok('Bluetooth-Ersatzweg über AUX_INPUT, wenn /select nicht greift');
  await assert.rejects(call('/api/group', { gid: 'nix', action: 'aux' }), /Unbekannte Gruppe/); ok('unbekannte Gruppe abgelehnt');
  console.log('\nalle', n, 'Tests bestanden');
} catch (e) { console.error('FEHLER nach Test', n, '\n', e); process.exitCode = 1; }
stop();
