// Test der Kernlogik gegen simulierte Boxen (test/mock_st.py). Aufruf: npm test
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const STCore = require('../www/core.js');

const mocks = [['127.0.0.2', 'Alpha', 'DEV-A'], ['127.0.0.3', 'Bravo', 'DEV-B']]
  .map(a => spawn('python3', [new URL('./mock_st.py', import.meta.url).pathname, ...a], { stdio: 'ignore' }));
const stop = () => mocks.forEach(m => m.kill());
process.on('exit', stop);
await new Promise(r => setTimeout(r, 1200));

function nodeHttp(method, ip, port, path, body, timeout, extra) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: ip, port, path, method, timeout,
      headers: Object.assign(body ? { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) } : {}, extra || {}) }, res => {
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
let LANG = 'de', maStuck = false;   // maStuck: play_pause setzt eine pausierte Warteschlange nicht fort (wie bei AirPlay beobachtet)
const core = STCore.createCore({ http: nodeHttp, WebSocket, storage, scanTimeout: 400, lang: () => LANG }); // wsPorts Standard: 8080 (verweigert) -> 8090

let n = 0;
const ok = (name) => console.log('ok', ++n, name);
const call = (p, b) => core.route(p, b);

try {
  await assert.rejects(call('/api/config', { speakers: [{ name: 'X', ip: '8.8.8.8' }] }), /Ungültige IP/); ok('öffentliche IP abgelehnt');

  // keine Vorgaben: ohne Eintrag gibt es weder Boxen noch Gruppen
  let st = await call('/api/state'); assert.deepEqual(st.config.speakers, []); assert.deepEqual(st.config.groups, []); ok('Neustart ohne Vorgaben: keine Boxen, keine Gruppen');
  await call('/api/config', { speakers: [{ id: 'a1', name: 'Alpha', ip: '127.0.0.2', max: 70 }, { id: 'b1', name: 'Bravo', ip: '127.0.0.3', max: 60 }],
    groups: [{ id: 'gg', name: 'Beide Boxen', members: ['a1', 'b1'] }] });
  st = await call('/api/state'); assert.equal(st.config.groups.length, 1); assert.equal(st.config.groups[0].members.length, 2);
  const [A, B] = st.config.speakers.map(x => x.id); assert.ok(A && B && A !== B);
  assert.equal((await call('/api/state')).config.speakers[0].id, A); ok('Konfiguration: Gruppe mit zwei Boxen, IDs bleiben stabil');
  const G = st.config.groups[0].id;

  assert.equal(st.speakers[0].standby, true); assert.equal(st.speakers[1].group.paired, false); ok('Status: beide im Standby, kein Paar');
  const t0 = Date.now();
  let r = await call('/api/group', { gid: G, action: 'aux' });
  assert.match(r.message, /Alpha: AUX an/); assert.match(r.message, /Zone mit 1 weiteren/);
  st = await call('/api/state'); assert.equal(st.speakers[0].source, 'AUX'); assert.equal(st.speakers[1].standby, false);
  const zone = await nodeHttp('GET', '127.0.0.2', 8090, '/getZone', null, 2000); assert.match(zone, /master="DEV-A"/); assert.match(zone, /DEV-B/);
  ok('Gruppe: AUX an auf Master + Zone mit Folge-Box (weckt aus Standby, ' + (Date.now() - t0) + ' ms)');

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

  r = await call('/api/group', { gid: G, action: 'off' }); assert.match(r.message, /Alpha: aus/);
  r = await call('/api/group', { gid: G, action: 'off' }); assert.match(r.message, /war schon aus/); ok('Gruppe: Aus / erneut Aus');

  r = await call('/api/scan', { prefixes: ['127.0.0'] }); assert.deepEqual(r.found.map(f => f.ip + '|' + f.name + '|' + f.type), ['127.0.0.2|Alpha|SoundTouch 10', '127.0.0.3|Bravo|SoundTouch 10']); ok('Auto-Suche findet beide Boxen');
  await assert.rejects(call('/api/scan', { prefixes: ['8.8.8'] }), /Ungültiger Suchbereich/); ok('Auto-Suche lehnt öffentliche Netze ab');

  // 3er-Gruppe, mehrere Gruppen, Gruppe mit einer Box
  const cfg3 = { speakers: [
    { id: 'a', name: 'Alpha', ip: '127.0.0.2', max: 70 }, { id: 'b', name: 'Bravo', ip: '127.0.0.3', max: 60 }, { id: 'c', name: 'Charlie', ip: '127.0.0.4', max: 50 }],
    groups: [{ id: 'g1', name: 'Alle drei', members: ['a', 'b', 'c'] }, { id: 'g2', name: 'Nur Musik', members: ['a'] }, { id: 'g3', name: 'Leer', members: ['x'] }] };
  r = await call('/api/config', cfg3); assert.equal(r.config.groups.length, 2); ok('Gruppen ohne gültige Mitglieder werden verworfen');
  const m3 = spawn('python3', [new URL('./mock_st.py', import.meta.url).pathname, '127.0.0.4', 'Charlie', 'DEV-C'], { stdio: 'ignore' }); mocks.push(m3);
  await new Promise(r => setTimeout(r, 800));
  r = await call('/api/group', { gid: 'g1', action: 'aux' }); assert.match(r.message, /Zone mit 2 weiteren/); ok('3er-Gruppe: AUX an, Zone mit 2 weiteren');
  r = await call('/api/group', { gid: 'g1', action: 'volume', master: 65, balance: 0 });
  st = await call('/api/state'); assert.deepEqual(st.speakers.map(x => x.volume), [65, 60, 50]); ok('3er-Gruppe: Lautstärke je Box auf deren max begrenzt');
  await assert.rejects(call('/api/group', { gid: 'g1', action: 'pair' }), /genau zwei/); ok('Stereopaar nur mit zwei Boxen');
  r = await call('/api/group', { gid: 'g2', action: 'off' }); st = await call('/api/state'); assert.equal(st.speakers[0].standby, true); assert.equal(st.speakers[1].standby, false); ok('Gruppe mit einer Box wirkt nur auf diese');
  // Bluetooth direkt, Ersatzweg, Gruppe; Presets
  r = await call('/api/bt', { idx: 0 }); st = await call('/api/state'); assert.equal(st.speakers[0].source, 'BLUETOOTH'); ok('Bluetooth per /select');
  r = await call('/api/group', { gid: 'g1', action: 'bt' }); st = await call('/api/state'); assert.equal(st.speakers[0].source, 'BLUETOOTH'); assert.match(r.message, /Zone mit 2/); ok('Gruppe: Bluetooth (Master + Zone)');
  r = await call('/api/group', { gid: 'g1', action: 'aux' }); st = await call('/api/state'); assert.equal(st.speakers[1].source, 'AUX'); ok('zurück auf AUX');
  const dbg = ip => nodeHttp('GET', ip, 8090, '/_dbg', null, 2000);
  r = await call('/api/preset', { idx: 1, n: 4 }); assert.equal(await dbg('127.0.0.3'), '4'); ok('einzelne Box: Taste 4');
  r = await call('/api/group', { gid: 'g1', action: 'preset', n: 2 }); assert.deepEqual([await dbg('127.0.0.2'), await dbg('127.0.0.3'), await dbg('127.0.0.4')], ['2', '4', '0']); ok('Gruppe: Taste 2 nur am Master, Folge-Boxen per Zone');
  await assert.rejects(call('/api/preset', { idx: 0, n: 13 }), /Taste 1 bis 12/); ok('Taste 13 abgelehnt');
  await call('/api/preset', { idx: 1, n: 9 }); assert.equal(await dbg('127.0.0.3'), '9'); r = await call('/api/presets', { idx: 1 }); assert.equal(r.rows, 2); ok('zweite Reihe (Slot 9) über STR-Agent :8888');
  assert.deepEqual(r.row2, { 9: 'Jazz' }); ok('zweite Reihe: nur belegte Slots (9 = Jazz, leerer Slot 10 fehlt)');
  await call('/api/preset', { idx: 1, n: 2 }); r = await call('/api/save', { idx: 1, n: 5 }); assert.match(r.message, /Taste 5 gespeichert/);
  assert.equal(await nodeHttp('GET', '127.0.0.3', 8090, '/_saved', null, 2000), '{"slot":5}'); ok('langer Druck: save-playing mit Slot 5');
  r = await call('/api/save', { idx: 1, n: 8 }); assert.match(r.message, /Taste 8 gespeichert/);
  r = await call('/api/url', { idx: 1, url: 'Schau mal: https://example.org/musik/Sonate%20Nr1.flac?x=1, super' });
  assert.match(r.message, /spielt Sonate Nr1\.flac/);
  assert.deepEqual(JSON.parse(await nodeHttp('GET', '127.0.0.3', 8090, '/_played', null, 2000)), { url: 'https://example.org/musik/Sonate%20Nr1.flac?x=1', title: 'Sonate Nr1.flac' }); ok('URL abspielen: Adresse aus geteiltem Text, Titel aus Dateiname');
  await assert.rejects(call('/api/url', { idx: 1, url: 'kein link' }), /Keine Adresse/); await assert.rejects(call('/api/url', { idx: 1, url: 'ftp://x/y' }), /Keine Adresse/); ok('URL abspielen: ohne http(s)-Adresse abgelehnt');
  r = await call('/api/url', { gid: 'g1', url: 'http://jellyfin.lan:8096/Audio/abc/stream.mp3' }); assert.match(r.message, /Zone mit 2 weiteren/); ok('URL abspielen an Gruppe: Master + Zone');
  await assert.rejects(call('/api/save', { idx: 1, n: 0 }), /Taste 1 bis 12/); ok('Speichern auf Slot 8 (2. Reihe), Slot 0 abgelehnt');
  r = await call('/api/presets', { idx: 0 }); assert.deepEqual(r.presets.map(p => [p.n, p.name]), [[1, 'Radio Eins'], [3, 'Klassik']]); ok('Sendernamen aus /presets');
  await call('/api/preset', { idx: 0, n: 1 }); st = await call('/api/state'); r = await call('/api/presets', { idx: 0 });
  assert.equal(st.speakers[0].item, 'LOCAL_INTERNET_RADIO|x'); assert.equal(r.presets[0].item, 'LOCAL_INTERNET_RADIO|x'); assert.notEqual(r.presets[1].item, st.speakers[0].item); ok('laufende Quelle passt zur gewählten Sendertaste');
  // Titelanzeige und Player-Tasten, Umziehen (Mock: /select mit Internetradio übernimmt die Box)
  await call('/api/group', { gid: 'g2', action: 'aux' }); await call('/api/preset', { idx: 0, n: 1 });
  r = await call('/api/move', { from: { idx: 0 }, to: { idx: 1 } }); assert.match(r.message, /umgezogen auf Bravo/);
  st = await call('/api/state'); assert.equal(st.speakers[1].item, 'LOCAL_INTERNET_RADIO|x'); assert.equal(st.speakers[0].standby, true); ok('Umziehen Box → Box: läuft dort, Quelle aus');
  assert.deepEqual([st.speakers[1].title, st.speakers[1].artist, st.speakers[1].station, st.speakers[1].play], ['Titel 1', 'Interpret', 'Radio Eins', 'PLAY_STATE']); ok('Titelanzeige: Titel, Interpret, Sender, Status');
  assert.equal(st.speakers[0].title, ''); ok('Standby: keine Titelanzeige');
  await call('/api/key', { idx: 1, key: 'NEXT_TRACK' }); st = await call('/api/state'); assert.equal(st.speakers[1].title, 'Titel 2');
  await call('/api/key', { idx: 1, key: 'PLAY_PAUSE' }); st = await call('/api/state'); assert.equal(st.speakers[1].play, 'PAUSE_STATE');
  await call('/api/key', { idx: 1, key: 'PLAY_PAUSE' }); await call('/api/key', { idx: 1, key: 'PREV_TRACK' }); st = await call('/api/state');
  assert.deepEqual([st.speakers[1].title, st.speakers[1].play], ['Titel 1', 'PLAY_STATE']); ok('Player-Tasten: Weiter, Pause/Play, Zurück');
  await assert.rejects(call('/api/key', { idx: 1, key: 'POWER' }), /Unbekannte Taste/); await assert.rejects(call('/api/key', { idx: 0, key: 'NEXT_TRACK' }), /ist aus/); ok('Player-Tasten: nur Player-Tasten, nicht bei Standby');
  await assert.rejects(call('/api/move', { from: { idx: 0 }, to: { idx: 1 } }), /ist aus - es läuft nichts/); await assert.rejects(call('/api/move', { from: { idx: 1 }, to: { idx: 1 } }), /dasselbe/); ok('Umziehen: Quelle aus bzw. gleiches Ziel abgelehnt');
  r = await call('/api/move', { from: { idx: 1 }, to: { gid: 'g1' } }); assert.match(r.message, /umgezogen auf Alpha \+ Bravo \+ Charlie/);
  st = await call('/api/state'); assert.deepEqual(st.speakers.map(x => x.standby), [false, false, false]); assert.equal(st.speakers[0].item, 'LOCAL_INTERNET_RADIO|x');
  const zg = await nodeHttp('GET', '127.0.0.2', 8090, '/getZone', null, 2000); assert.match(zg, /master="DEV-A"/); assert.match(zg, /DEV-B/); assert.match(zg, /DEV-C/); ok('Umziehen Box → Gruppe (Ziel enthält die Quelle): Zone mit Master des Ziels');
  await call('/api/key', { gid: 'g1', key: 'NEXT_TRACK' }); st = await call('/api/state'); assert.equal(st.speakers[0].title, 'Titel 2'); ok('Player-Taste bei Gruppe geht an die Master-Box');
  r = await call('/api/move', { from: { gid: 'g1' }, to: { idx: 2 } }); st = await call('/api/state');
  assert.deepEqual(st.speakers.map(x => x.standby), [true, true, false]); assert.equal(st.speakers[2].item, 'LOCAL_INTERNET_RADIO|x'); ok('Umziehen Gruppe → Einzelbox: nur die Ziel-Box bleibt an');
  await call('/api/aux', { idx: 0 }); await assert.rejects(call('/api/move', { from: { idx: 0 }, to: { idx: 1 } }), /lässt sich nicht umziehen/); ok('Umziehen: AUX wird abgelehnt (Ton hängt an der Box)');
  r = await call('/api/move', { from: { idx: 0 }, to: { idx: 1 }, mode: 'add' }); assert.match(r.message, /Bravo dazugenommen/);
  const za = await nodeHttp('GET', '127.0.0.2', 8090, '/getZone', null, 2000); assert.match(za, /master="DEV-A"/); assert.match(za, /DEV-B/); ok('Dazunehmen: Ziel kommt per Zone zur Quelle, Quelle bleibt an');
  await assert.rejects(call('/api/move', { from: { gid: 'g1' }, to: { idx: 0 }, mode: 'add' }), /schon dabei/); ok('Dazunehmen: schon dabei abgelehnt');
  const m5 = spawn('python3', [new URL('./mock_st.py', import.meta.url).pathname, '127.0.0.5', 'Flur', 'DEV-E'], { stdio: 'ignore', env: { ...process.env, MOCK_NO_BT_SELECT: '1' } }); mocks.push(m5);
  await new Promise(r => setTimeout(r, 800));
  await call('/api/config', { speakers: [{ id: 'e', name: 'Flur', ip: '127.0.0.5', max: 50 }], groups: [] });
  r = await call('/api/bt', { idx: 0 }); st = await call('/api/state'); assert.equal(st.speakers[0].source, 'BLUETOOTH'); ok('Bluetooth-Ersatzweg über AUX_INPUT, wenn /select nicht greift');
  const m6 = spawn('python3', [new URL('./mock_st.py', import.meta.url).pathname, '127.0.0.6', 'Stur', 'DEV-F'], { stdio: 'ignore', env: { ...process.env, MOCK_NO_RADIO_SELECT: '1' } }); mocks.push(m6);
  await new Promise(r => setTimeout(r, 800));
  await call('/api/config', { speakers: [{ id: 'e', name: 'Flur', ip: '127.0.0.5', max: 50 }, { id: 'f', name: 'Stur', ip: '127.0.0.6', max: 50 }], groups: [] });
  await nodeHttp('POST', '127.0.0.5', 8090, '/select', '<ContentItem source="LOCAL_INTERNET_RADIO" location="x"/>', 2000);
  await assert.rejects(call('/api/move', { from: { idx: 0 }, to: { idx: 1 } }), /übernimmt die Quelle nicht.*Flur bleibt an/);
  st = await call('/api/state'); assert.equal(st.speakers[0].standby, false); ok('Umziehen: übernimmt das Ziel nicht, bleibt die Quelle an');
  await assert.rejects(call('/api/group', { gid: 'nix', action: 'aux' }), /Unbekannte Gruppe/); ok('unbekannte Gruppe abgelehnt');
  await assert.rejects(call('/api/config', { speakers: [], groups: [], ma: 'http://8.8.8.8:8095' }), /Ungültige Music-Assistant/);
  r = await call('/api/config', { speakers: [], groups: [], ma: '192.168.1.10' }); assert.equal(r.config.ma, 'http://192.168.1.10:8095');
  r = await call('/api/config', { speakers: [], groups: [], ma: 'http://192.168.1.10:8095/' }); assert.equal(r.config.ma, 'http://192.168.1.10:8095'); ok('Music-Assistant-Adresse: nur Heimnetz, Port 8095 als Standard');
  const maLog = []; const maQ = { 'ma-a': 'playing', 'ma-b': 'idle' };
  const maSrv = http.createServer((q, res) => {
    let b = ''; q.on('data', c => b += c);
    q.on('end', () => {
      if (q.url === '/info') return res.end('{"server_version":"2.9.1","schema_version":30}');
      if (q.url !== '/api') return res.end('x');
      if (q.headers.authorization !== 'Bearer tok-123456789') { res.statusCode = 401; return res.end('{}'); }
      const m = JSON.parse(b); maLog.push(m.command + ':' + JSON.stringify(m.args));
      if (m.command === 'players/all') return res.end(JSON.stringify([
        { player_id: 'ma-a', name: 'Alpha', available: true, device_info: { address: '127.0.0.2' } },
        { player_id: 'ma-b', name: 'Bravo', available: true, device_info: { address: '127.0.0.3' } }]));
      if (m.command === 'player_queues/all') return res.end(JSON.stringify([
        { queue_id: 'ma-a', active: true, state: maQ['ma-a'], current_item: { name: 'Nina Simone/Band - Sinnerman', media_item: { name: 'Sinnerman', artists: [{ name: 'Nina Simone' }, { name: 'Band' }], album: { name: 'Sinnerman LP' }, metadata: { images: [{ type: 'thumb', path: 'http://127.0.0.9:8096/Items/1/Images/Primary?api_key=GEHEIMSCHLUESSEL1' }] } } } },
        { queue_id: 'ma-b', active: false, state: maQ['ma-b'], current_item: null }]));
      if (m.command === 'player_queues/play_pause' && !(maStuck && maQ[m.args.queue_id] === 'paused')) maQ[m.args.queue_id] = maQ[m.args.queue_id] === 'playing' ? 'paused' : 'playing';
      if (m.command === 'player_queues/resume') maQ[m.args.queue_id] = 'playing';
      if (m.command === 'player_queues/transfer') { maQ[m.args.target_queue_id] = 'playing'; maQ[m.args.source_queue_id] = 'idle'; }
      res.end('null');
    });
  }).listen(8095, '127.0.0.9');
  r = await call('/api/ma/scan', { prefixes: ['127.0.0'] }); assert.deepEqual(r.found.map(f => f.url + '|' + f.version), ['http://127.0.0.9:8095|2.9.1']); ok('Music Assistant per Port 8095 gefunden');
  // Music Assistant steuert Weiter/Pause selbst (Box-Tasten melden dort "Invalid Source")
  await assert.rejects(call('/api/config', { speakers: [], groups: [], ma: 'http://127.0.0.9:8095', maToken: 'zu kurz' }), /Ungültiger Music-Assistant-Token/); ok('MA-Token: Format geprüft');
  await call('/api/config', { speakers: [{ id: 'a', name: 'Alpha', ip: '127.0.0.2', max: 70 }, { id: 'b', name: 'Bravo', ip: '127.0.0.3', max: 70 }],
    groups: [{ id: 'g1', name: 'Beide', members: ['a', 'b'] }], ma: 'http://127.0.0.9:8095', maToken: 'tok-123456789' });
  await call('/api/aux', { idx: 0 }); await nodeHttp('POST', '127.0.0.2', 8090, '/select', '<ContentItem source="UPNP" location="http://127.0.0.9:8097/x"/>', 2000);
  r = await call('/api/ma/test'); assert.match(r.message, /2 Player/); assert.match(r.lines[0], /Alpha: Player ma-a, Warteschlange playing, MA spielt hier/); assert.match(r.lines[1], /Bravo: Player ma-b/); assert.ok(!/MA spielt hier/.test(r.lines[1])); ok('MA-Test: Boxen den MA-Playern zugeordnet (Adresse)');
  st = await call('/api/state'); assert.deepEqual([st.speakers[0].ma.active, st.speakers[0].ma.state, st.speakers[0].ma.title, st.speakers[0].ma.artist], [true, 'playing', 'Sinnerman', 'Nina Simone, Band']);
  assert.equal(st.speakers[0].ma.album, 'Sinnerman LP'); assert.match(st.speakers[0].ma.art, /Images\/Primary/); assert.equal(st.speakers[0].art, 'http://127.0.0.1/cover.jpg'); assert.equal(st.speakers[1].ma.active, false); ok('Stand: MA-Titel und -Status der Box, zweite Box nicht aktiv');
  maLog.length = 0; const tBox = st.speakers[0].title;
  r = await call('/api/key', { idx: 0, key: 'NEXT_TRACK' }); assert.match(r.message, /Weiter \(Music Assistant\)/); assert.ok(maLog.includes('player_queues/next:{"queue_id":"ma-a"}')); ok('Weiter geht an MA (player_queues/next), nicht an die Box');
  await call('/api/key', { idx: 0, key: 'PREV_TRACK' }); assert.ok(maLog.includes('player_queues/previous:{"queue_id":"ma-a"}'));
  await call('/api/key', { gid: 'g1', key: 'PLAY_PAUSE' }); assert.ok(maLog.includes('player_queues/play_pause:{"queue_id":"ma-a"}'));
  st = await call('/api/state'); assert.equal(st.speakers[0].ma.state, 'paused'); assert.equal(st.speakers[0].title, tBox); ok('Zurück, Play/Pause (Gruppe → Master) über MA; Box-Tasten blieben unberührt');
  maStuck = true; maLog.length = 0;
  await call('/api/key', { idx: 0, key: 'PLAY_PAUSE' });
  assert.ok(!maLog.some(x => x.startsWith('player_queues/play_pause'))); assert.ok(maLog.includes('player_queues/resume:{"queue_id":"ma-a"}')); st = await call('/api/state'); assert.equal(st.speakers[0].ma.state, 'playing'); maStuck = false;
  ok('Weiterspielen: setzt play_pause nicht fort, geht gleich per resume');
  await call('/api/key', { idx: 0, key: 'PLAY_PAUSE' }); await call('/api/key', { idx: 0, key: 'PLAY_PAUSE' });   // zurück auf "pausiert" wie vorher: Pause, dann Fortsetzen
  await call('/api/key', { idx: 0, key: 'PLAY_PAUSE' }); st = await call('/api/state'); assert.equal(st.speakers[0].ma.state, 'paused');
  await call('/api/aux', { idx: 1 }); await call('/api/preset', { idx: 1, n: 1 }); maLog.length = 0;
  await call('/api/key', { idx: 1, key: 'NEXT_TRACK' }); assert.ok(!maLog.some(x => x.startsWith('player_queues/next'))); ok('Box ohne laufendes MA: Taste geht an die Box');
  await call('/api/config', { speakers: [{ id: 'a', name: 'Alpha', ip: '127.0.0.2', max: 70 }], groups: [], ma: 'http://127.0.0.9:8095', maToken: 'falscher-token-1' });
  st = await call('/api/state'); assert.equal(st.speakers[0].ma, undefined); await assert.rejects(call('/api/ma/test'), /lehnt den Token ab/); ok('Falscher Token: Anzeige läuft ohne MA weiter, Test meldet es');
  r = await call('/api/config', { speakers: [{ id: 'a', name: 'Alpha', ip: '127.0.0.2', max: 70 }], groups: [], ma: 'http://127.0.0.9:8095', maToken: 'tok-123456789' });
  await nodeHttp('POST', '127.0.0.2', 8090, '/select', '<ContentItem source="UPNP" location="http://127.0.0.9:8096/dlna/x.flac"/>', 2000);   // Jellyfin direkt, nicht über MA
  st = await call('/api/state'); assert.equal(st.speakers[0].ma.active, false); ok('Jellyfin-DLNA direkt auf derselben IP wie MA (Port 8096): MA gilt nicht als aktiv');
  await nodeHttp('POST', '127.0.0.2', 8090, '/select', '<ContentItem source="AIRPLAY"><itemName>Sinnerman</itemName></ContentItem>', 2000);   // MA streamt per AirPlay
  st = await call('/api/state'); assert.equal(st.speakers[0].ma.active, true); ok('AirPlay von MA (Titel der Box = Titel der MA-Warteschlange): MA aktiv');
  await nodeHttp('POST', '127.0.0.2', 8090, '/select', '<ContentItem source="AIRPLAY"><itemName>Anderes Lied</itemName></ContentItem>', 2000);   // AirPlay vom Handy
  st = await call('/api/state'); assert.equal(st.speakers[0].ma.active, false); ok('AirPlay mit anderem Titel (z. B. vom Handy): MA nicht aktiv');
  await nodeHttp('POST', '127.0.0.2', 8090, '/select', '<ContentItem source="AIRPLAY"><itemName></itemName></ContentItem>', 2000);   // pausiert: Box meldet keinen Titel
  st = await call('/api/state'); assert.equal(st.speakers[0].ma.active, true); ok('AirPlay ohne Titel (pausiert): MA-Warteschlange gilt');
  // Umziehen bei laufendem MA: Warteschlange wird per MA übertragen
  await call('/api/config', { speakers: [{ id: 'a', name: 'Alpha', ip: '127.0.0.2', max: 70 }, { id: 'b', name: 'Bravo', ip: '127.0.0.3', max: 70 }], groups: [], ma: 'http://127.0.0.9:8095', maToken: 'tok-123456789' });
  await nodeHttp('POST', '127.0.0.2', 8090, '/select', '<ContentItem source="AIRPLAY"><itemName>Sinnerman</itemName></ContentItem>', 2000);
  maQ['ma-a'] = 'playing'; maQ['ma-b'] = 'idle'; maLog.length = 0;
  r = await call('/api/move', { from: { idx: 0 }, to: { idx: 1 }, mode: 'move' }); assert.match(r.message, /umgezogen auf Bravo/);
  assert.ok(maLog.includes('player_queues/transfer:{"source_queue_id":"ma-a","target_queue_id":"ma-b","auto_play":true}')); ok('Umziehen mit MA: player_queues/transfer an die Ziel-Box');
  r = await call('/api/diag'); assert.match(r.text, /== Letzte Player-Tasten/); assert.match(r.text, /"via":"MA".*player_queues\/play_pause ok/); assert.match(r.text, /"via":"Box"/); assert.match(r.text, /player_queues\/resume ok/);
  assert.match(r.text, /== Alpha \(127\.0\.0\.2\) \/now_playing\n<nowPlaying/); assert.match(r.text, /Alpha Music Assistant Player ma-a Warteschlange:\n\{"queue_id":"ma-a"/); assert.ok(!r.text.includes('tok-123456789')); assert.ok(!r.text.includes('GEHEIMSCHLUESSEL1') && r.text.includes('api_key=***')); ok('Diagnose: Rohantworten von Box und MA, ohne Token');
  maSrv.closeAllConnections(); maSrv.close();
  // Englisch: Meldungen der Kernlogik folgen der Spracheinstellung
  LANG = 'en';
  await assert.rejects(call('/api/group', { gid: 'nix', action: 'aux' }), /Unknown group/);
  await assert.rejects(call('/api/config', { speakers: [{ name: 'X', ip: '8.8.8.8' }] }), /Invalid IP for X/);
  r = await call('/api/volume', { idx: 0, value: 30 }); assert.match(r.message, /Alpha: Volume 30/);
  r = await call('/api/off', { idx: 0 }); assert.match(r.message, /Alpha: (off|was already off)/);
  ok('Englisch: Fehler- und Statusmeldungen'); LANG = 'de';
  console.log('\nalle', n, 'Tests bestanden');
} catch (e) { console.error('FEHLER nach Test', n, '\n', e); process.exitCode = 1; }
stop();
