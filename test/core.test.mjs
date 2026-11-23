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
const core = STCore.createCore({ http: nodeHttp, WebSocket, storage }); // wsPorts Standard: 8080 (verweigert) -> 8090

let n = 0;
const ok = (name) => console.log('ok', ++n, name);
const call = (p, b) => core.route(p, b);

try {
  await assert.rejects(call('/api/config', { speakers: [{ name: 'X', ip: '8.8.8.8' }] }), /Ungültige IP/); ok('öffentliche IP abgelehnt');
  await call('/api/config', { speakers: [{ name: 'Musikzimmer', ip: '127.0.0.2', max: 70 }, { name: 'Bibliothek', ip: '127.0.0.3', max: 60 }] });
  let st = await call('/api/state');
  assert.equal(st.speakers.length, 2); assert.equal(st.speakers[0].standby, true); assert.equal(st.speakers[1].group.paired, false); ok('Status: beide im Standby, kein Paar');

  const t0 = Date.now();
  let r = await call('/api/aux', { idx: 'all' });
  assert.match(r.message, /Musikzimmer: AUX an/); assert.match(r.message, /Bibliothek: AUX an/);
  st = await call('/api/state'); assert.equal(st.speakers[0].source, 'AUX'); ok('AUX an für alle (weckt aus Standby, ' + (Date.now() - t0) + ' ms)');

  r = await call('/api/volume', { idx: 0, value: 90 }); assert.match(r.message, /Lautstärke 70/); ok('Lautstärke begrenzt auf max');
  r = await call('/api/volume', { idx: 1, delta: -9 }); st = await call('/api/state'); assert.equal(st.speakers[1].volume, 11); ok('Lautstärke relativ (20-9)');

  r = await call('/api/duo', { action: 'set', left: 0, right: 1, master: 40, balance: 50 });
  assert.match(r.message, /links 20, rechts 40/); ok('virtuelle Balance +50 → links 20, rechts 40');
  r = await call('/api/duo', { action: 'set', left: 0, right: 1, master: 99, balance: -25 });
  assert.match(r.message, /links 60, rechts 45/); ok('Gesamtlautstärke auf kleineres max (60) begrenzt, Balance -25');
  r = await call('/api/duo', { action: 'read', left: 0, right: 1 }); assert.equal(r.mode, 'virtual'); ok('Modus ungepaart = virtual');

  r = await call('/api/stereo', { action: 'pair', left: 0, right: 1 }); assert.match(r.message, /gebildet/); ok('Stereopaar bilden');
  r = await call('/api/duo', { action: 'read', left: 0, right: 1 }); assert.equal(r.mode, 'pair'); assert.equal(r.balance, 0); ok('Modus gepaart, Balance 0');
  r = await call('/api/duo', { action: 'set', left: 0, right: 1, master: 30, balance: 50 });
  assert.match(r.message, /Stereopaar: Lautstärke 30, Balance \+4/); ok('echte Balance per WebSocket (Port 8080 verweigert → Fallback 8090)');
  r = await call('/api/duo', { action: 'read', left: 0, right: 1 }); assert.equal(r.balance, 57); ok('Balance zurückgelesen (+4/7 = 57 %)');
  await call('/api/duo', { action: 'set', left: 0, right: 1, master: 30, balance: -100 });
  r = await call('/api/duo', { action: 'read', left: 0, right: 1 }); assert.equal(r.balance, -100); ok('Balance -100 → -7');

  r = await call('/api/stereo', { action: 'unpair', left: 0, right: 1 }); assert.match(r.message, /aufgelöst/); ok('Stereopaar auflösen');
  r = await call('/api/stereo', { action: 'unpair', left: 0, right: 1 }); assert.match(r.message, /Kein Stereopaar/); ok('erneut auflösen: nichts zu tun');
  await assert.rejects(call('/api/duo', { action: 'set', left: 0, right: 0, master: 1, balance: 0 }), /ungültig/); ok('links == rechts abgelehnt');

  r = await call('/api/off', { idx: 'all' }); assert.match(r.message, /Musikzimmer: aus/);
  r = await call('/api/off', { idx: 'all' }); assert.match(r.message, /war schon aus/); ok('Aus / erneut Aus');
  console.log('\nalle', n, 'Tests bestanden');
} catch (e) { console.error('FEHLER nach Test', n, '\n', e); process.exitCode = 1; }
stop();
