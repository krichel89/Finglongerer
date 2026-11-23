/* Kernlogik: spricht die SoundTouch-Boxen direkt an (HTTP :8090, WebSocket für Balance).
   Läuft in der Android-WebView (Capacitor) und – mit eingesetztem Transport – in Node (Tests).
   Meldungen kommen aus i18n.js (Deutsch/Englisch, env.lang liefert die Sprache). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./i18n.js'));
  else root.STCore = factory(root.STI18n);
})(typeof self !== 'undefined' ? self : this, function (I18N) {
  'use strict';
  let LANG = () => 'de';                            // wird von createCore(env.lang) gesetzt
  const T = (key, ...a) => I18N.t(LANG(), key, ...a);

  const KEYS = new Set(['POWER', 'AUX_INPUT', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE',
    'PRESET_1', 'PRESET_2', 'PRESET_3', 'PRESET_4', 'PRESET_5', 'PRESET_6',
    'PLAY_PAUSE', 'PREV_TRACK', 'NEXT_TRACK']);
  const PLAYER_KEYS = new Set(['PLAY_PAUSE', 'PREV_TRACK', 'NEXT_TRACK']);
  // Quellen, die sich nicht per /select auf eine andere Box übergeben lassen (Ton hängt an der Box bzw. kommt vom Gerät)
  const NO_MOVE = new Set(['AUX', 'BLUETOOTH', 'STANDBY', 'PRODUCT', 'AIRPLAY', 'NOTIFICATION']);
  const DEFAULT_CONFIG = {speakers: [], groups: []};     // keine Vorgaben: Boxen und Gruppen legt man in den Einstellungen an
  const CFG_KEY = 'finglongerer.config';

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const unesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Minimaler XML-Zugriff (die Antworten der Boxen sind klein und flach)
  function tag(xml, name) {
    const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>').exec(xml);
    return m ? unesc(m[1]).trim() : null;
  }
  function attr(xml, el, a) {
    const m = new RegExp('<' + el + '\\b[^>]*?\\s' + a + '="([^"]*)"').exec(xml);
    return m ? unesc(m[1]) : '';
  }

  function validIp(text) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text).trim());
    if (!m) return null;
    const o = m.slice(1).map(Number);
    if (o.some(n => n > 255)) return null;
    const [a, b] = o;
    const ok = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || a === 127;
    return ok ? o.join('.') : null;
  }

  const cleanId = v => String(v || '').replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const newId = () => Math.random().toString(36).slice(2, 8);
  function uniqueId(v, used) {
    let id = cleanId(v);
    while (!id || used.has(id)) id = newId();
    used.add(id);
    return id;
  }

  // Music-Assistant-Adresse: http://<Heimnetz-IP>[:Port], leer = keine
  function cleanMa(v) {
    const raw = String(v || '').trim(); if (!raw) return '';
    const m = /^(?:https?:\/\/)?(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?\/?$/.exec(raw), ip = m && validIp(m[1]);
    if (!ip || (m[2] && +m[2] > 65535)) throw new Error(T('err.cfgMa'));
    return 'http://' + ip + ':' + (m[2] || '8095');
  }
  function cleanToken(v) {
    const t = String(v || '').trim(); if (!t) return '';
    if (!/^[\w.~+\/=-]{8,4000}$/.test(t)) throw new Error(T('err.cfgToken'));
    return t;
  }
  function sanitize(cfg) {
    cfg = cfg || {};
    const speakers = [], used = new Set();
    for (const sp of (cfg.speakers || []).slice(0, 8)) {
      const name = String(sp.name || '').trim().slice(0, 40) || T('def.box');
      const raw = String(sp.ip || '').trim();
      const ip = raw ? validIp(raw) : '';
      if (raw && !ip) throw new Error(T('err.cfgIp', name, raw.slice(0, 40)));
      let mx = parseInt(sp.max, 10);
      if (!Number.isFinite(mx)) mx = 70;
      speakers.push({id: uniqueId(sp.id, used), name, ip, max: Math.max(10, Math.min(100, mx))});
    }
    const groups = Array.isArray(cfg.groups) ? cfg.groups : [];
    const ids = new Set(speakers.map(sp => sp.id)), gused = new Set(), outG = [];
    for (const g of groups.slice(0, 8)) {
      const members = [];
      for (const id of (g.members || [])) if (ids.has(id) && !members.includes(id)) members.push(id);
      if (!members.length) continue;
      outG.push({id: uniqueId(g.id, gused), name: String(g.name || '').trim().slice(0, 30) || T('def.group'), members});
    }
    return {speakers, groups: outG, ma: cleanMa(cfg.ma), maToken: cleanToken(cfg.maToken)};
  }

  /* env: {http(method, ip, port, path, body, timeoutMs) -> Promise<string>,
           WebSocket, storage, stPort, wsPorts} */
  function createCore(env) {
    LANG = env.lang || (() => 'de');
    const ST_PORT = env.stPort || 8090;
    const WS_PORTS = env.wsPorts || [8080, 8090];
    const TIMEOUT = 3000;
    let ridCounter = 1;
    const keyLog = [];                       // letzte Player-Tasten mit Entscheidung (Box oder MA) und Ergebnis, für die Diagnose

    function loadConfig() {
      try {
        const raw = env.storage.getItem(CFG_KEY);
        if (raw) {
          const parsed = JSON.parse(raw), clean = sanitize(parsed);
          if (JSON.stringify(parsed) !== JSON.stringify(clean)) env.storage.setItem(CFG_KEY, JSON.stringify(clean)); // Übernahme/IDs festhalten
          return clean;
        }
      } catch (e) { /* defekte Config -> Standard */ }
      const def = sanitize(DEFAULT_CONFIG);
      try { env.storage.setItem(CFG_KEY, JSON.stringify(def)); } catch (e) { /* egal */ }
      return def;
    }
    function saveConfig(cfg) {
      const clean = sanitize(cfg);
      env.storage.setItem(CFG_KEY, JSON.stringify(clean));
      return clean;
    }

    const stGet = (ip, path, t) => env.http('GET', ip, ST_PORT, path, null, t || TIMEOUT);
    const stPost = (ip, path, xml) => env.http('POST', ip, ST_PORT, path, xml, TIMEOUT);

    async function pressKey(ip, name) {
      if (!KEYS.has(name)) throw new Error(T('err.unknownKey'));
      for (const state of ['press', 'release'])
        await stPost(ip, '/key', '<key state="' + state + '" sender="Gabbo">' + name + '</key>');
    }
    const cleanUrl = v => { const u = String(v || '').trim(); return /^https?:\/\/[^\s<>"']{1,600}$/i.test(u) ? u : ''; };
    // /now_playing einmal lesen: Quelle, Inhalt (ContentItem) und – soweit die Box sie meldet – Titel, Interpret, Sender, Status
    async function nowFull(ip) {
      const xml = await stGet(ip, '/now_playing'), cut = (v, n) => String(v || '').slice(0, n || 120);
      return {
        source: attr(xml, 'nowPlaying', 'source'), deviceID: attr(xml, 'nowPlaying', 'deviceID'),
        ci: {source: attr(xml, 'ContentItem', 'source'), type: attr(xml, 'ContentItem', 'type'),
          location: attr(xml, 'ContentItem', 'location'), account: attr(xml, 'ContentItem', 'sourceAccount'), name: cut(tag(xml, 'itemName'))},
        track: cut(tag(xml, 'track')), artist: cut(tag(xml, 'artist')), album: cut(tag(xml, 'album')),
        station: cut(tag(xml, 'stationName')), play: cut(tag(xml, 'playStatus'), 30), art: cleanUrl(tag(xml, 'art'))};
    }
    async function nowPlaying(ip) {
      const f = await nowFull(ip);
      return [f.source, f.deviceID, f.ci.location ? f.ci.source + '|' + f.ci.location : ''];
    }
    async function getInfo(ip) {
      const xml = await stGet(ip, '/info');
      return [attr(xml, 'info', 'deviceID'), tag(xml, 'name') || ''];
    }
    async function getVolume(ip) {
      const xml = await stGet(ip, '/volume');
      const v = parseInt(tag(xml, 'actualvolume') || tag(xml, 'targetvolume') || '0', 10) || 0;
      return [v, tag(xml, 'muteenabled') === 'true'];
    }
    const setVolume = (ip, v) => stPost(ip, '/volume', '<volume>' + Math.round(v) + '</volume>');

    async function getGroup(ip) {
      const xml = await stGet(ip, '/getGroup');
      const name = tag(xml, 'name') || '';
      const roles = {};
      for (const m of xml.matchAll(/<groupRole>([\s\S]*?)<\/groupRole>/g))
        roles[tag(m[1], 'deviceId') || ''] = tag(m[1], 'role') || '';
      return {paired: !!(name || Object.keys(roles).length), name, roles, master: tag(xml, 'masterDeviceId') || ''};
    }

    // Balance-Bereich lesen; kurzer Timeout (tiefer Standby kann ~12 s hängen)
    async function getBalanceRange(ip) {
      try {
        const xml = await stGet(ip, '/balance', 2000);
        if (tag(xml, 'balanceAvailable') === 'false') return null;
        const lo = parseInt(tag(xml, 'balanceMin'), 10), hi = parseInt(tag(xml, 'balanceMax'), 10);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-7, 7, null];
        const t = parseInt(tag(xml, 'targetBalance'), 10);
        return [lo, hi, Number.isFinite(t) ? t : null];
      } catch (e) { return [-7, 7, null]; }
    }

    function wsOnce(url, protocols, msg, rid, timeout) {
      return new Promise((resolve, reject) => {
        let ws, done = false, timer;
        const finish = (err) => {
          if (done) return; done = true; clearTimeout(timer);
          try { ws && ws.close(); } catch (e) { /* egal */ }
          err ? reject(err) : resolve(true);
        };
        timer = setTimeout(() => finish(new Error(T('err.timeout'))), timeout);
        try { ws = protocols.length ? new env.WebSocket(url, protocols) : new env.WebSocket(url); }
        catch (e) { return finish(e); }
        ws.onopen = () => { try { ws.send(msg); } catch (e) { finish(e); } };
        ws.onerror = () => finish(new Error(T('err.connFailed')));
        ws.onclose = () => finish(new Error(T('err.connClosed')));
        ws.onmessage = ev => {
          const txt = String(ev.data);
          if (txt.includes('requestID="' + rid + '"') && txt.includes('RESPONSE')) {
            if (/<targetBalance>|<actualBalance>/.test(txt)) finish(null);
            else finish(new Error(T('err.unexpected', txt.slice(0, 120))));
          }
        };
      });
    }
    // HTTP-POST /balance hängt laut Community-Doku; die Original-App schreibt per WebSocket.
    async function wsSetBalance(ip, deviceId, value) {
      let last = '';
      for (const port of WS_PORTS) {
        for (const protocols of [['gabbo'], []]) {
          const rid = String(ridCounter++);
          const msg = '<msg><header deviceID="' + esc(deviceId) + '" url="balance" method="POST">' +
            '<request requestID="' + rid + '"><info mainNode="balanceSet" type="new"/></request></header>' +
            '<body><balance><targetBalance>' + Math.round(value) + '</targetBalance></balance></body></msg>';
          try { await wsOnce('ws://' + ip + ':' + port + '/', protocols, msg, rid, 4000); return; }
          catch (e) { last = T('err.balancePort', port, protocols.length ? '' : T('err.noSubprotocol'), e.message); }
        }
      }
      throw new Error(T('err.balanceFailed', last));
    }

    async function waitAwake(ip, seconds) {
      const deadline = Date.now() + (seconds || 20) * 1000;
      while (Date.now() < deadline) {
        await sleep(1000);
        try { if ((await nowPlaying(ip))[0] !== 'STANDBY') return true; } catch (e) { /* weiter */ }
      }
      return false;
    }

    async function speakerState(sp) {
      const out = {name: sp.name, ip: sp.ip, max: sp.max, online: false};
      if (!sp.ip) { out.error = T('err.noIp'); return out; }
      let f;
      try { f = await nowFull(sp.ip); }
      catch (e) { out.error = T('err.unreachable'); return out; }
      Object.defineProperty(out, '_f', {value: f});          // für die MA-Zuordnung wiederverwenden (nicht in der Antwort): spart pro Box eine Anfrage je Aktualisierung
      Object.assign(out, {online: true, source: f.source, standby: f.source === 'STANDBY', deviceID: f.deviceID,
        item: f.ci.location ? f.ci.source + '|' + f.ci.location : '', title: f.track, artist: f.artist, album: f.album, station: f.station, play: f.play, art: f.art});
      try { const [v, m] = await getVolume(sp.ip); out.volume = v; out.mute = m; } catch (e) { /* egal */ }
      try {
        const g = await getGroup(sp.ip);
        out.group = {paired: g.paired, name: g.name, role: g.roles[f.deviceID] || ''};
      } catch (e) { out.group = null; }
      return out;
    }

    // ---- Aktionen
    // AUX direkt wählen (/select). Die Taste AUX_INPUT schaltet je nach Box zwischen AUX und Bluetooth um.
    async function doAuxOn(sp) {
      if ((await nowPlaying(sp.ip))[0] === 'STANDBY') {
        await pressKey(sp.ip, 'POWER');
        if (!(await waitAwake(sp.ip))) throw new Error(T('err.noWake'));
        await sleep(1000);
      }
      if ((await nowPlaying(sp.ip))[0] === 'AUX') return T('act.auxOn');
      await stPost(sp.ip, '/select', '<ContentItem source="AUX" sourceAccount="AUX"></ContentItem>');
      for (let i = 0; i < 4; i++) {
        await sleep(700);
        if ((await nowPlaying(sp.ip))[0] === 'AUX') return T('act.auxOn');
      }
      throw new Error(T('err.auxFail', (await nowPlaying(sp.ip))[0]));
    }
    // Bluetooth: direkt wählen (/select); Ersatzweg: AUX_INPUT schaltete bei der Box von AUX auf Bluetooth um
    async function doBluetoothOn(sp) {
      if ((await nowPlaying(sp.ip))[0] === 'STANDBY') {
        await pressKey(sp.ip, 'POWER');
        if (!(await waitAwake(sp.ip))) throw new Error(T('err.noWake'));
        await sleep(1000);
      }
      const is = async () => (await nowPlaying(sp.ip))[0] === 'BLUETOOTH';
      if (await is()) return T('act.btOn');
      try { await stPost(sp.ip, '/select', '<ContentItem source="BLUETOOTH" sourceAccount=""></ContentItem>'); } catch (e) { /* Ersatzweg */ }
      for (let i = 0; i < 4; i++) { await sleep(700); if (await is()) return T('act.btOn'); }
      if ((await nowPlaying(sp.ip))[0] !== 'AUX') {
        try { await stPost(sp.ip, '/select', '<ContentItem source="AUX" sourceAccount="AUX"></ContentItem>'); } catch (e) { /* egal */ }
        await sleep(1200);
      }
      await pressKey(sp.ip, 'AUX_INPUT');
      for (let i = 0; i < 4; i++) { await sleep(700); if (await is()) return T('act.btOn'); }
      throw new Error(T('err.btFail', (await nowPlaying(sp.ip))[0]));
    }
    async function getPresets(ip) {
      try {
        const xml = await stGet(ip, '/presets', 2000), out = [];
        for (const m of xml.matchAll(/<preset\s+id="(\d+)"[^>]*>([\s\S]*?)<\/preset>/g))
          out.push({n: +m[1], name: tag(m[2], 'itemName') || '',
            item: attr(m[2], 'ContentItem', 'location') ? attr(m[2], 'ContentItem', 'source') + '|' + attr(m[2], 'ContentItem', 'location') : ''});
        return out;
      } catch (e) { return []; }
    }
    // STR-Agent (Port 8888): zweite Reihe (Slots 7-12 = Taste doppelt gedrückt) gibt es nur dort; meldet "presetRows":"2"
    const AGENT_PORT = 8888, MA_PORT = 8095;
    async function agentRows(ip) {
      try {
        const x = await env.http('GET', ip, AGENT_PORT, '/api/agent/version', null, 2000);
        return /"presetRows"\s*:\s*"?2"?/.test(x) ? 2 : 1;
      } catch (e) { return 1; }
    }
    // /api/presets des Agenten: Form nicht dokumentiert -> tolerant lesen; null = nicht erkannt
    function parseStrSlots(text) {
      let j; try { j = JSON.parse(text); } catch (e) { return null; }
      if (j && !Array.isArray(j) && typeof j === 'object' && (j.presets || j.slots)) j = j.presets || j.slots;
      const ent = Array.isArray(j) ? j.map((v, i) => [null, v, i]) : (j && typeof j === 'object' ? Object.entries(j).map(([k, v]) => [k, v, null]) : []);
      const out = {}; let any = false;
      for (const [k, v, i] of ent) {
        if (!v || typeof v !== 'object') continue;
        let n = [v.slot, v.id, v.n, k].map(x => parseInt(x, 10)).find(x => x >= 1 && x <= 12);
        if (!n && i !== null && ent.length <= 12) n = i + 1;
        if (!n) continue;
        any = true;
        const name = String(v.name || v.title || v.stationName || v.label || '').slice(0, 60);
        if (name || v.url || v.stream || v.streamUrl || v.source || v.type || Object.keys(v).length > 2) out[n] = name;
      }
      return any ? out : null;
    }
    async function agentRow2(ip) {
      if ((await agentRows(ip)) < 2) return {rows: 1, row2: null};
      let slots = null;
      try { slots = parseStrSlots(await env.http('GET', ip, AGENT_PORT, '/api/presets', null, 2500)); } catch (e) { /* unbekannt */ }
      if (!slots) return {rows: 2, row2: null};
      const row2 = {}; for (const k of Object.keys(slots)) if (+k > 6) row2[k] = slots[k];
      return {rows: 2, row2};
    }
    async function doPreset(sp, n) {
      if (!(n >= 1 && n <= 12)) throw new Error(T('err.slot'));
      if ((await nowPlaying(sp.ip))[0] === 'STANDBY') {
        await pressKey(sp.ip, 'POWER');
        if (!(await waitAwake(sp.ip))) throw new Error(T('err.noWake'));
        await sleep(1000);
      }
      if (n > 6) {
        if ((await agentRows(sp.ip)) < 2) throw new Error(T('err.noRow2'));
        await env.http('POST', sp.ip, AGENT_PORT, '/api/play/' + n, null, 5000);
        return T('act.slot', n);
      }
      await pressKey(sp.ip, 'PRESET_' + n);
      return T('act.slot', n);
    }
    // "Was gerade läuft" auf eine Sendertaste speichern (STR-Agent, wie der lange Druck in der STR-Oberfläche; Slots 1-12)
    async function doSave(sp, n) {
      if (!(n >= 1 && n <= 12)) throw new Error(T('err.slot'));
      if ((await nowPlaying(sp.ip))[0] === 'STANDBY') throw new Error(T('err.saveOff'));
      try { await env.http('POST', sp.ip, AGENT_PORT, '/api/box/save-playing', JSON.stringify({slot: n}), 8000); }
      catch (e) {
        if (/409/.test(e.message)) throw new Error(T('err.saveDup'));
        throw new Error(T('err.saveFail', e.message));
      }
      return T('act.slotSaved', n);
    }
    // Beliebige Stream-Adresse abspielen lassen (STR-Agent: POST /api/play) - die Box holt sich den Stream selbst
    function extractUrl(text) {
      const m = /https?:\/\/[^\s<>"']+/i.exec(String(text || ''));
      if (!m) throw new Error(T('err.noUrl'));
      const u = m[0].replace(/[),.;]+$/, '');
      if (u.length > 2000) throw new Error(T('err.urlLong'));
      return u;
    }
    async function doUrl(sp, url, title) {
      if ((await nowPlaying(sp.ip))[0] === 'STANDBY') {
        await pressKey(sp.ip, 'POWER');
        if (!(await waitAwake(sp.ip))) throw new Error(T('err.noWake'));
        await sleep(1000);
      }
      try { await env.http('POST', sp.ip, AGENT_PORT, '/api/play', JSON.stringify({url, title}), 8000); }
      catch (e) { throw new Error(T('err.playFail', e.message)); }
      return T('act.playing', title);
    }
    async function doOff(sp) {
      if ((await nowPlaying(sp.ip))[0] === 'STANDBY') return T('act.wasOff');
      await pressKey(sp.ip, 'POWER');
      return T('act.off');
    }
    async function doVolume(sp, delta, value) {
      const [cur] = await getVolume(sp.ip);
      let nv = value !== undefined && value !== null ? parseInt(value, 10) : cur + parseInt(delta, 10);
      nv = Math.max(0, Math.min(sp.max, nv));
      await setVolume(sp.ip, nv);
      return T('act.volume', nv);
    }
    // Multiroom-Zone: Master-Box spielt, die anderen folgen synchron (/setZone). Stereopaare sind keine Zone.
    async function getZoneIds(ip) {
      const xml = await stGet(ip, '/getZone', 2500);
      const ids = [];
      for (const mm of xml.matchAll(/<member\b[^>]*>([^<]+)<\/member>/g)) ids.push(mm[1].trim());
      const master = attr(xml, 'zone', 'master');
      if (master && !ids.includes(master)) ids.push(master);
      return ids;
    }
    async function makeZone(m) {
      const infos = await Promise.all(m.map(sp => getInfo(sp.ip)));
      const ids = infos.map(i => i[0]);
      if (ids.some(i => !i) || new Set(ids).size !== ids.length) throw new Error(T('err.deviceIds'));
      for (let i = 1; i < m.length; i++) {            // Folge-Boxen aus dem Standby holen
        if ((await nowPlaying(m[i].ip))[0] === 'STANDBY') {
          await pressKey(m[i].ip, 'POWER');
          if (!(await waitAwake(m[i].ip))) throw new Error(T('err.noWakeName', m[i].name));
        }
      }
      let body = '<zone master="' + esc(ids[0]) + '" senderIPAddress="' + esc(m[0].ip) + '">';
      for (let i = 1; i < m.length; i++) body += '<member ipaddress="' + esc(m[i].ip) + '">' + esc(ids[i]) + '</member>';
      body += '</zone>';
      await stPost(m[0].ip, '/setZone', body);
      for (let t = 0; t < 4; t++) {
        await sleep(700);
        let z = [];
        try { z = await getZoneIds(m[0].ip); } catch (e) { /* nochmal */ }
        if (ids.every(i => z.includes(i))) return true;
      }
      throw new Error(T('err.zoneFail'));
    }
    async function isStereoPair(m) { return m.length === 2 && (await getGroup(m[0].ip)).paired; }
    // Quelle auf der Master-Box setzen, dann alle Boxen als Zone koppeln; einzelne Box / Stereopaar wie bisher
    async function zoneRun(m, fn, pairMasterOnly) {
      if (m.length < 2) return runMany(m, fn);
      if (await isStereoPair(m)) return runMany(pairMasterOnly ? [m[0]] : m, fn);
      const master = await runMany([m[0]], fn);
      if (master.errs.length) return master;
      try { await makeZone(m); master.oks.push(T('act.zoneWith', m.length - 1)); }
      catch (e) { master.errs.push(T('err.zone', e.message)); }
      return master;
    }
    // ---- Music Assistant (HTTP-API: POST /api mit Bearer-Token; Befehle laut MA-Doku/Clients, Antwortformen tolerant gelesen)
    const MA_NOT_MA = new Set(['AUX', 'BLUETOOTH', 'PRODUCT', 'STANDBY', 'LOCAL_INTERNET_RADIO', 'INTERNET_RADIO', 'TUNEIN', 'SPOTIFY', 'DEEZER']);
    const MA_CMD = {PLAY_PAUSE: 'player_queues/play_pause', NEXT_TRACK: 'player_queues/next', PREV_TRACK: 'player_queues/previous'};
    let maCache = {key: '', at: 0, players: null}, maDownUntil = 0;
    function maConf() {
      const c = loadConfig(), m = /^http:\/\/([\d.]+):(\d+)$/.exec(c.ma || '');
      return m && c.maToken ? {ip: m[1], port: +m[2], token: c.maToken, url: c.ma} : null;
    }
    async function maCall(conf, command, args, timeout) {
      let t;
      try {
        t = await env.http('POST', conf.ip, conf.port, '/api', JSON.stringify({message_id: String(ridCounter++), command, args: args || {}}), timeout || 2500,
          {Authorization: 'Bearer ' + conf.token});
      } catch (e) {
        if (/401|403/.test(e.message)) throw new Error(T('err.maToken'));
        throw new Error(T('err.ma', e.message));
      }
      let j = null; try { j = t && t.trim() ? JSON.parse(t) : null; } catch (e) { return t; }
      if (j && typeof j === 'object' && !Array.isArray(j) && (j.error_code !== undefined || j.error !== undefined))
        throw new Error(T('err.ma', String(j.details || j.error || j.error_code).slice(0, 120)));
      return j;
    }
    const asList = j => Array.isArray(j) ? j : (j && Array.isArray(j.items) ? j.items : []);
    async function maPlayers(conf) {
      const key = conf.url + conf.token;
      if (!maCache.players || maCache.key !== key || Date.now() - maCache.at > 60000)
        maCache = {key, at: Date.now(), players: asList(await maCall(conf, 'players/all', {}, 2500))};
      return maCache.players;
    }
    // Welcher MA-Player gehört zur Box? Adresse (device_info.address) vor Name
    function maMatch(players, sp) {
      const addr = p => String((p.device_info && p.device_info.address) || p.address || '');
      const nm = p => String(p.display_name || p.name || '').trim().toLowerCase();
      const hit = players.filter(p => p && p.player_id && addr(p).includes(sp.ip));
      const byName = players.filter(p => p && p.player_id && nm(p) === sp.name.trim().toLowerCase());
      return (hit.length ? hit : byName).filter(p => p.available !== false);
    }
    // MA-Stand einer Box; "active" nur, wenn MA wirklich die Quelle der Box ist (Warteschlange läuft/pausiert, Box nicht auf AUX/BT/Radio/Standby)
    function maInfo(conf, players, queues, sp, f) {
      const cands = maMatch(players, sp); if (!cands.length) return null;
      const qs = cands.map(p => queues.find(q => q && (q.queue_id === p.player_id))).filter(Boolean);
      const live = q => (q.state === 'playing' || q.state === 'paused') && q.active !== false && !!q.current_item;
      const q = qs.find(live) || qs[0], p = cands.find(c => q && c.player_id === q.queue_id) || cands[0];
      const out = {playerId: p.player_id, queueId: (q && q.queue_id) || p.player_id, state: (q && q.state) || '', active: false, title: '', artist: '', album: '', art: ''};
      if (!q) return out;
      const ci = q.current_item || {}, mi = ci.media_item || {}, nm = a => String((a && a.name) || '').trim();
      out.title = String(mi.name || ci.name || '').slice(0, 160);
      out.artist = (Array.isArray(mi.artists) ? mi.artists.map(nm).filter(Boolean).join(', ') : String(mi.artist_str || '')).slice(0, 200);
      out.album = nm(mi.album).slice(0, 160);
      const img = o => { const im = o && o.metadata && Array.isArray(o.metadata.images) ? o.metadata.images.find(x => x && /^https?:\/\//i.test(String(x.path || ''))) : null; return im ? String(im.path) : ''; };
      out.art = cleanUrl((ci.image && ci.image.path) || img(mi) || img(mi.album));
      // Stream-Adresse der Box: zeigt sie auf den MA-Server (Port 8095/8097), spielt MA; zeigt sie woandershin (z. B. Jellyfin-DLNA, Radio), nicht
      const loc = (f && f.ci && f.ci.location) || '', u = /^https?:\/\/([\d.]+):(\d+)/.exec(loc);
      const norm = v => String(v || '').trim().toLowerCase(), air = !!f && (f.ci.source === 'AIRPLAY' || f.source === 'AIRPLAY');
      // AirPlay (so streamt MA zu diesen Boxen) kann auch vom Handy kommen: MA gilt nur, wenn der Titel der Box zum Titel der MA-Warteschlange passt
      const sure = u ? (u[1] === conf.ip && (u[2] === '8095' || u[2] === '8097'))
        : air ? (!f.track || norm(f.track) === norm(out.title))   // pausiert meldet die Box über AirPlay oft keinen Titel: dann gilt die MA-Warteschlange
        : (f ? !(MA_NOT_MA.has(f.ci.source) || MA_NOT_MA.has(f.source)) : false);   // ohne IP-Adresse in der URL: nach Quelle entscheiden
      out.active = live(q) && !!f && f.source !== 'STANDBY' && !!sure;
      return out;
    }
    async function maSnapshot() {
      const conf = maConf(); if (!conf || Date.now() < maDownUntil) return null;
      try { return {conf, players: await maPlayers(conf), queues: asList(await maCall(conf, 'player_queues/all', {}, 2500))}; }
      catch (e) { maDownUntil = Date.now() + 15000; return null; }   // nicht erreichbar: 15 s nicht erneut warten
    }

    // Weiterspielen nach Pause: play_pause allein setzt bei manchen Playern (z. B. AirPlay) nicht fort -> prüfen und mit play/resume nachhelfen
    async function maResume(conf, queueId, steps) {
      const note = (cmd, e) => { if (steps) steps.push(cmd + (e ? ' FEHLER ' + e.message : ' ok')); };
      const state = async () => {
        await sleep(900);
        try { const q = asList(await maCall(conf, 'player_queues/all', {}, 2500)).find(x => x && x.queue_id === queueId); return q ? q.state : ''; }
        catch (e) { return ''; }
      };
      let st = await state(); if (steps) steps.push('nach play_pause: ' + (st || '?'));
      if (st === 'playing' || st === '') return;
      // play_pause entspricht bei Pause schon player_queues/play (MA wartet bis 5 s auf die Bestätigung der Box); bleibt es pausiert, startet resume den Titel neu an der Pausenstelle
      for (const cmd of ['player_queues/resume']) {
        try { await maCall(conf, cmd, {queue_id: queueId}, 9000); note(cmd); } catch (e) { note(cmd, e); continue; }
        st = await state(); if (steps) steps.push('danach: ' + (st || '?'));
        if (st === 'playing') return;
      }
    }

    // ---- Umziehen: laufende Wiedergabe von einer Box/Gruppe auf eine andere
    async function wake(sp) {
      if ((await nowPlaying(sp.ip))[0] === 'STANDBY') {
        await pressKey(sp.ip, 'POWER');
        if (!(await waitAwake(sp.ip))) throw new Error(T('err.noWakeName', sp.name));
        await sleep(1000);
      }
    }
    const names = m => m.map(b => b.name).join(' + ');
    // mode "add": Quelle bleibt Master, Ziel-Boxen kommen per Zone dazu (Musik läuft weiter).
    // mode "move": gleichen Inhalt auf der Ziel-Box starten (/select), erst wenn er dort läuft, die Quell-Boxen ausschalten.
    async function doMove(src, dst, mode) {
      if (!src.length || !dst.length) throw new Error(T('err.moveMissing'));
      const dstIds = new Set(dst.map(b => b.id)), srcIds = new Set(src.map(b => b.id));
      if (src.length === dst.length && src.every(b => dstIds.has(b.id))) throw new Error(T('err.moveSame'));
      const now = await nowFull(src[0].ip);
      // Spielt Music Assistant (Box-Quelle meist AirPlay), zieht MA die Warteschlange selbst um; die Box-Quelle lässt sich dort nicht kopieren
      const log = {move: names(src) + ' -> ' + names(dst), mode, box: [now.source, now.ci.source, now.play || '-', now.track || '-'].join(' | '), via: '', schritte: []};
      keyLog.push(log); if (keyLog.length > 8) keyLog.shift();
      if (mode === 'move') {
        const snap = await maSnapshot(), sq = snap && maLiveQueue(snap, src[0]);
        log.ma = snap ? (sq ? {queue: sq.queue_id, state: sq.state} : 'keine laufende Warteschlange') : 'nicht erreichbar/nicht eingerichtet';
        const info = snap && now.source !== 'STANDBY' ? maInfo(snap.conf, snap.players, snap.queues, src[0], now) : null;
        if (sq && ((info && info.active) || now.source === 'STANDBY')) {
          log.via = 'MA';
          try { return await moveViaMa(snap, sq, src, dst, log); } catch (e) { log.schritte.push('FEHLER ' + e.message); throw e; }
        }
      }
      if (now.source === 'STANDBY') throw new Error(T('err.moveOff', src[0].name));
      if (mode === 'add') {
        const extra = dst.filter(b => !srcIds.has(b.id));
        if (!extra.length) throw new Error(T('err.moveHas'));
        if (await isStereoPair(src) || await isStereoPair(dst)) throw new Error(T('err.moveStereo'));
        await makeZone(src.concat(extra));
        return T('act.added', names(extra));
      }
      const ci = now.ci;
      if (!ci.source || !ci.location || NO_MOVE.has(ci.source))
        throw new Error(T('err.moveSource', ci.source || now.source));
      const d0 = dst[0];
      await wake(d0);
      const before = await nowFull(d0.ip);
      await stPost(d0.ip, '/select', '<ContentItem source="' + esc(ci.source) + '" type="' + esc(ci.type) + '" location="' + esc(ci.location) +
        '" sourceAccount="' + esc(ci.account) + '" isPresetable="true"><itemName>' + esc(ci.name) + '</itemName></ContentItem>');
      let ok = false, n = before;
      for (let i = 0; i < 5 && !ok; i++) {
        await sleep(700);
        n = await nowFull(d0.ip);
        const changed = n.ci.source !== before.ci.source || n.ci.location !== before.ci.location;
        ok = n.source !== 'STANDBY' && n.ci.source === ci.source && (n.ci.location === ci.location || changed);
      }
      if (!ok) throw new Error(T('err.moveRefused', d0.name, n.ci.source || n.source, names(src)));
      const warn = [];
      if (dst.length > 1) {
        try { if (!(await isStereoPair(dst))) await makeZone(dst); } catch (e) { warn.push(T('err.zone', e.message)); }
      }
      const leaving = src.filter(b => !dstIds.has(b.id));
      for (let i = 0; i < leaving.length; i++) {      // wie Gruppe aus: Master zuerst, dann Pause (sonst weckt der zweite POWER die Folge-Box)
        try { await doOff(leaving[i]); } catch (e) { warn.push(leaving[i].name + ': ' + e.message); }
        if (i === 0 && leaving.length > 1) await sleep(1500);
      }
      return T('act.moved', names(dst), warn.length ? ' (' + warn.join('; ') + ')' : '');
    }
    // laufende (spielende/pausierte) MA-Warteschlange einer Box, sonst null
    function maLiveQueue(snap, sp) {
      for (const p of maMatch(snap.players, sp)) {
        const q = snap.queues.find(x => x && x.queue_id === p.player_id);
        if (q && (q.state === 'playing' || q.state === 'paused') && q.current_item) return q;
      }
      return null;
    }
    async function moveViaMa(snap, sq, src, dst, log) {
      const dstIds = new Set(dst.map(b => b.id)), d0 = dst[0], steps = log.schritte;
      const leaving = src.filter(b => !dstIds.has(b.id));
      await wake(d0); steps.push('Ziel wach');
      // frisch aufgewachte Box taucht erst nach einigen Sekunden wieder als MA-Player auf
      let tq = null;
      for (let i = 0; i < 8 && !tq; i++) {
        maCache.players = null;
        const players = await maPlayers(snap.conf);
        const p = maMatch(players, d0)[0];
        if (p) tq = p.player_id; else await sleep(1000);
      }
      if (!tq) throw new Error(T('err.moveNoMa', d0.name));
      steps.push('Ziel-Player ' + tq);
      if (tq !== sq.queue_id) {
        await maCall(snap.conf, 'player_queues/transfer', {source_queue_id: sq.queue_id, target_queue_id: tq, auto_play: true}, 8000);
        steps.push('player_queues/transfer ok');
      }
      let st = '';
      for (let i = 0; i < 6 && st !== 'playing'; i++) {
        await sleep(1000);
        try { const q = asList(await maCall(snap.conf, 'player_queues/all', {}, 2500)).find(x => x && x.queue_id === tq); st = q ? q.state : ''; } catch (e) { st = ''; }
      }
      steps.push('Ziel-Zustand: ' + (st || '?'));
      if (st !== 'playing') throw new Error(T('err.moveMaNotPlaying', d0.name));
      const warn = [];
      if (dst.length > 1) {
        try { if (!(await isStereoPair(dst))) await makeZone(dst); } catch (e) { warn.push(T('err.zone', e.message)); }
      }
      for (let i = 0; i < leaving.length; i++) {
        try { await doOff(leaving[i]); } catch (e) { warn.push(leaving[i].name + ': ' + e.message); }
        if (i === 0 && leaving.length > 1) await sleep(1500);
      }
      return T('act.moved', names(dst), warn.length ? ' (' + warn.join('; ') + ')' : '');
    }
    function refBoxes(ref) {
      if (!ref || ref.idx === 'all') throw new Error(T('err.unknownBox'));
      return ref.gid ? groupMembers(ref) : targets(ref);
    }

    async function runMany(targets, fn) {
      const res = await Promise.all(targets.map(async sp => {
        try { return [sp.name + ': ' + await fn(sp), null]; }
        catch (e) { return [null, sp.name + ': ' + e.message]; }
      }));
      return {oks: res.filter(r => r[0]).map(r => r[0]), errs: res.filter(r => r[1]).map(r => r[1])};
    }
    function summarize({oks, errs}) {
      if (errs.length && !oks.length) throw new Error(errs.join('; '));
      return {ok: true, message: oks.concat(errs).join('; ')};
    }

    async function duoRead(left) {
      const g = await getGroup(left.ip);
      if (!g.paired) return {mode: 'virtual', balance: null};
      const rng = await getBalanceRange(left.ip);
      let bal = null;
      if (rng && rng[2] !== null) {
        const [lo, hi, tgt] = rng;
        bal = tgt >= 0 ? Math.round(100 * tgt / hi) : Math.round(100 * tgt / -lo);
      }
      return {mode: 'pair', balance: bal};
    }
    async function doDuo(left, right, master, balance) {
      const cap = Math.min(left.max, right.max);
      master = Math.max(0, Math.min(cap, parseInt(master, 10) || 0));
      balance = Math.max(-100, Math.min(100, parseInt(balance, 10) || 0));
      const g = await getGroup(left.ip);
      if (g.paired) {
        const [ldev] = await getInfo(left.ip);
        const [rdev] = await getInfo(right.ip);
        const useRight = g.master && g.master === rdev;
        const box = useRight ? right : left, dev = useRight ? rdev : ldev;
        await setVolume(box.ip, master);
        const rng = (await getBalanceRange(box.ip)) || [-7, 7, null];
        const target = balance >= 0 ? Math.round(balance / 100 * rng[1]) : Math.round(balance / 100 * -rng[0]);
        await wsSetBalance(box.ip, dev, target);
        return T('act.pairVol', master, (target > 0 ? '+' : '') + target);
      }
      const lv = Math.round(master * (1 - Math.max(0, balance) / 100));
      const rv = Math.round(master * (1 - Math.max(0, -balance) / 100));
      const errs = [];
      await Promise.all([[left, lv], [right, rv]].map(async ([sp, v]) => {
        try { await setVolume(sp.ip, v); } catch (e) { errs.push(sp.name + ': ' + e.message); }
      }));
      if (errs.length) throw new Error(errs.join('; '));
      return T('act.lrVol', lv, rv);
    }

    async function pairSpeakers(left, right) {
      const [lid] = await getInfo(left.ip);
      const [rid] = await getInfo(right.ip);
      if (!lid || !rid || lid === rid) throw new Error(T('err.deviceIdsPair'));
      const body = '<group><name>' + esc(left.name + ' + ' + right.name) + '</name><masterDeviceId>' + esc(lid) +
        '</masterDeviceId><roles>' +
        '<groupRole><deviceId>' + esc(lid) + '</deviceId><role>LEFT</role><ipAddress>' + esc(left.ip) + '</ipAddress></groupRole>' +
        '<groupRole><deviceId>' + esc(rid) + '</deviceId><role>RIGHT</role><ipAddress>' + esc(right.ip) + '</ipAddress></groupRole>' +
        '</roles></group>';
      await stPost(left.ip, '/addGroup', body);
      await sleep(2000);
      if (!(await getGroup(left.ip)).paired)
        throw new Error(T('err.pairFail'));
      return T('act.paired');
    }
    async function unpairSpeakers(a, b) {
      for (const sp of [a, b]) {
        try {
          if ((await getGroup(sp.ip)).paired) {
            await stGet(sp.ip, '/removeGroup');
            await sleep(1500);
            return T('act.unpaired');
          }
        } catch (e) { /* nächste Box */ }
      }
      return T('act.noPair');
    }

    // ---- Automatische Suche: /info auf allen Adressen der angegebenen /24-Netze
    function netPrefix(text) {
      const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})(?:\.\d{1,3}(?:\/\d{1,2})?)?$/.exec(String(text).trim());
      if (!m || !validIp(m[1] + '.1')) throw new Error(T('err.badRange', String(text).slice(0, 30)));
      return m[1];
    }
    function guessPrefixes() {
      const out = [];
      for (const sp of loadConfig().speakers) {
        if (sp.ip) { const p = sp.ip.split('.').slice(0, 3).join('.'); if (!out.includes(p)) out.push(p); }
      }
      for (const p of ['192.168.178', '192.168.0', '192.168.1']) if (!out.includes(p)) out.push(p);
      return out.slice(0, 3);
    }
    async function scanNet(prefixes) {
      const hosts = [], found = [];
      for (const p of prefixes) for (let i = 1; i <= 254; i++) hosts.push(p + '.' + i);
      let next = 0;
      async function worker() {
        while (next < hosts.length) {
          const ip = hosts[next++];
          try {
            const xml = await env.http('GET', ip, ST_PORT, '/info', null, env.scanTimeout || 800);
            const id = attr(xml, 'info', 'deviceID');
            if (id) found.push({ip, deviceID: id, name: tag(xml, 'name') || ip, type: tag(xml, 'type') || ''});
          } catch (e) { /* keine Box */ }
        }
      }
      await Promise.all(Array.from({length: 40}, worker));
      const key = ip => ip.split('.').reduce((a, b) => a * 256 + +b, 0);
      return found.sort((a, b) => key(a.ip) - key(b.ip));
    }

    // Music Assistant im Netz suchen: Port 8095, /info (Server-Info-JSON) bzw. Startseite
    async function scanMa(prefixes) {
      const hosts = [], found = [];
      for (const p of prefixes) for (let i = 1; i <= 254; i++) hosts.push(p + '.' + i);
      let next = 0;
      async function worker() {
        while (next < hosts.length) {
          const ip = hosts[next++];
          try {
            const t = await env.http('GET', ip, MA_PORT, '/info', null, env.scanTimeout || 800);
            if (/"server_version"|"schema_version"|Music Assistant/i.test(t)) { found.push({ip, url: 'http://' + ip + ':' + MA_PORT, version: (/"server_version"\s*:\s*"([^"]{1,20})"/.exec(t) || [])[1] || ''}); continue; }
          } catch (e) { /* weiter */ }
          try {
            const t = await env.http('GET', ip, MA_PORT, '/', null, env.scanTimeout || 800);
            if (/Music Assistant/i.test(t)) found.push({ip, url: 'http://' + ip + ':' + MA_PORT, version: ''});
          } catch (e) { /* kein MA */ }
        }
      }
      await Promise.all(Array.from({length: 40}, worker));
      return found;
    }

    // ---- Routing (gleiche Pfade wie die Server-Version)
    function targets(data) {
      const cfg = loadConfig().speakers;
      if (data.idx === 'all') {
        const t = cfg.filter(s => s.ip);
        if (!t.length) throw new Error(T('err.noBoxIp'));
        return t;
      }
      const sp = Number.isInteger(data.idx) ? cfg[data.idx] : null;
      if (!sp) throw new Error(T('err.unknownBox'));
      if (!sp.ip) throw new Error(T('err.noIpEntered'));
      return [sp];
    }
    function groupMembers(data) {
      const cfg = loadConfig(), g = cfg.groups.find(x => x.id === data.gid);
      if (!g) throw new Error(T('err.unknownGroup'));
      const m = g.members.map(id => cfg.speakers.find(sp => sp.id === id)).filter(Boolean);
      const miss = m.filter(sp => !sp.ip);
      if (miss.length) throw new Error(T('err.noIpNames', miss.map(sp => sp.name).join(', ')));
      return m;
    }

    async function route(path, data) {
      data = data || {};
      if (path === '/api/state') {
        const cfg = loadConfig();
        const [speakers, snap] = await Promise.all([Promise.all(cfg.speakers.map(speakerState)), maSnapshot()]);
        if (snap) cfg.speakers.forEach((sp, i) => {
          const st = speakers[i]; if (!st.online) return;
          const info = maInfo(snap.conf, snap.players, snap.queues, sp, st._f || null); if (info) st.ma = info;
        });
        return {ok: true, config: cfg, speakers};
      }
      if (path === '/api/config') return {ok: true, config: saveConfig(data)};
      if (path === '/api/aux') return summarize(await runMany(targets(data), doAuxOn));
      if (path === '/api/off') return summarize(await runMany(targets(data), doOff));
      if (path === '/api/bt') return summarize(await runMany(targets(data), doBluetoothOn));
      if (path === '/api/preset') {
        const n = parseInt(data.n, 10);
        return summarize(await runMany(targets(data), sp => doPreset(sp, n)));
      }
      if (path === '/api/url') {
        const url = extractUrl(data.url);
        let title = String(data.title || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
        if (!title) { try { title = decodeURIComponent((url.split('?')[0].split('/').filter(Boolean).pop() || '')).slice(0, 80); } catch (e) { /* egal */ } }
        if (!title) title = url.replace(/^https?:\/\//i, '').split('/')[0];
        const m = data.gid ? groupMembers(data) : targets(data);
        return summarize(await zoneRun(m, sp => doUrl(sp, url, title), true));
      }
      if (path === '/api/save') {
        const n = parseInt(data.n, 10), t = data.gid ? groupMembers(data) : targets(data);
        return summarize(await runMany([t[0]], sp => doSave(sp, n)));   // Gruppe: speichert, was auf der Master-Box läuft
      }
      if (path === '/api/key') {       // Player-Tasten; bei Gruppen an die Master-Box (die Zone folgt)
        const key = String(data.key || ''); if (!PLAYER_KEYS.has(key)) throw new Error(T('err.unknownKey'));
        const sp = (data.gid ? groupMembers(data) : targets(data))[0];
        const f = await nowFull(sp.ip);
        if (f.source === 'STANDBY') throw new Error(T('err.speakerOff', sp.name));
        const snap = await maSnapshot(), info = snap && maInfo(snap.conf, snap.players, snap.queues, sp, f);
        const log = {key, box: [f.source, f.ci.source, f.play || '-', f.track || '-'].join(' | '), ma: snap ? (info ? {aktiv: info.active, state: info.state, titel: info.title} : 'kein Player') : 'nicht erreichbar/nicht eingerichtet', via: '', schritte: []};
        keyLog.push(log); if (keyLog.length > 8) keyLog.shift();
        try {
          if (info && info.active) {         // spielt Music Assistant, überspringt/pausiert MA selbst (die Box-Tasten melden dort "Invalid Source")
            log.via = 'MA';
            const resuming = key === 'PLAY_PAUSE' && info.state === 'paused';
            try { await maCall(snap.conf, MA_CMD[key], {queue_id: info.queueId}, resuming ? 8000 : 4000); log.schritte.push(MA_CMD[key] + ' ok'); }
            catch (e) { if (!resuming) throw e; log.schritte.push(MA_CMD[key] + ' FEHLER ' + e.message); }   // MA wartet bis 5 s auf die Box: Fehler heißt "noch pausiert", nicht Abbruch
            if (resuming) await maResume(snap.conf, info.queueId, log.schritte);
            return {ok: true, message: T('act.viaMa', T('key.' + key))};
          }
          log.via = 'Box';
          await pressKey(sp.ip, key); log.schritte.push('Box-Taste ok');
          return {ok: true, message: T('key.' + key)};
        } catch (e) { log.schritte.push('FEHLER ' + e.message); throw e; }
      }
      if (path === '/api/move') {
        const mode = data.mode === 'add' ? 'add' : 'move';
        return {ok: true, message: await doMove(refBoxes(data.from), refBoxes(data.to), mode)};
      }
      if (path === '/api/presets') { const ip = targets(data)[0].ip; return Object.assign({ok: true, presets: await getPresets(ip)}, await agentRow2(ip)); }
      if (path === '/api/volume') {
        const t = targets(data);
        if ('value' in data) return summarize(await runMany(t, sp => doVolume(sp, null, data.value)));
        const d = Math.max(-20, Math.min(20, parseInt(data.delta, 10) || 0));
        return summarize(await runMany(t, sp => doVolume(sp, d, null)));
      }
      if (path === '/api/group') {
        const m = groupMembers(data), n = m.length, action = data.action;
        if (action === 'aux') return summarize(await zoneRun(m, doAuxOn));
        if (action === 'bt') return summarize(await zoneRun(m, doBluetoothOn));
        if (action === 'off') {   // nacheinander: Master zuerst, sonst weckt ein zweiter POWER-Toggle die Folge-Box wieder
          const oks = [], errs = [];
          for (let i = 0; i < m.length; i++) {
            const r = await runMany([m[i]], doOff);
            oks.push(...r.oks); errs.push(...r.errs);
            if (i === 0 && m.length > 1) await sleep(1500);
          }
          return summarize({oks, errs});
        }
        if (action === 'presets') return Object.assign({ok: true, presets: await getPresets(m[0].ip)}, await agentRow2(m[0].ip));
        if (action === 'preset') {
          const n = parseInt(data.n, 10);
          // Stereopaar: Taste nur an der ersten (linken/Master-)Box; sonst Zone mit der ersten Box als Master
          if (!(n >= 1 && n <= 12)) throw new Error(T('err.slot'));
          return summarize(await zoneRun(m, sp => doPreset(sp, n), true));
        }
        if (action === 'read') return Object.assign({ok: true}, n === 2 ? await duoRead(m[0]) : {mode: 'none', balance: null});
        if (action === 'volume') {
          if (n === 2) return {ok: true, message: await doDuo(m[0], m[1], data.master, data.balance)};
          const master = Math.max(0, parseInt(data.master, 10) || 0);
          return summarize(await runMany(m, sp => doVolume(sp, null, Math.min(master, sp.max))));
        }
        if (action === 'pair' || action === 'unpair') {
          if (n !== 2) throw new Error(T('err.pairTwo'));
          return {ok: true, message: action === 'pair' ? await pairSpeakers(m[0], m[1]) : await unpairSpeakers(m[0], m[1])};
        }
        throw new Error(T('err.unknownAction'));
      }
      if (path === '/api/diag') {            // Rohantworten zum Weitergeben (kein Token, keine Zugangsdaten)
        const cfg = loadConfig(), parts = [];
        for (const sp of cfg.speakers.filter(x => x.ip)) {
          let raw; try { raw = await stGet(sp.ip, '/now_playing'); } catch (e) { raw = T('diag.error', e.message); }
          parts.push('== ' + sp.name + ' (' + sp.ip + ') /now_playing\n' + String(raw).slice(0, 4000));
        }
        const conf = maConf();
        if (conf) {
          try {
            const players = await maPlayers(conf), queues = asList(await maCall(conf, 'player_queues/all', {}, 2500));
            for (const sp of cfg.speakers.filter(x => x.ip)) {
              const pl = maMatch(players, sp)[0], q = pl && queues.find(x => x && x.queue_id === pl.player_id);
              parts.push('== ' + T('diag.ma', sp.name, pl ? T('diag.player', pl.player_id) : T('diag.noPlayer')) + (q ? T('diag.queue') + '\n' + JSON.stringify(q).slice(0, 3500) : ''));
            }
          } catch (e) { parts.push('== ' + T('diag.maErr', e.message)); }
        }
        if (keyLog.length) parts.push('== ' + T('diag.keys') + '\n' + keyLog.map(l => JSON.stringify(l)).join('\n'));
        const redact = t => t.replace(/(api_key|apikey|access_token|token)=([^&"\s<]+)/gi, '$1=***');
        return {ok: true, text: redact(parts.join('\n\n')) || T('err.noBoxIp')};
      }
      if (path === '/api/ma/test') {        // Verbindung prüfen und Boxen den MA-Playern zuordnen (zugleich Diagnose)
        const conf = maConf(); if (!conf) throw new Error(T('err.maNeed'));
        maCache = {key: '', at: 0, players: null}; maDownUntil = 0;
        const players = await maPlayers(conf), queues = asList(await maCall(conf, 'player_queues/all', {}, 2500)), lines = [];
        for (const sp of loadConfig().speakers.filter(x => x.ip)) {
          let f = null; try { f = await nowFull(sp.ip); } catch (e) { /* aus/nicht erreichbar */ }
          const i = maInfo(conf, players, queues, sp, f);
          lines.push(i ? T('ma.line', sp.name, i.playerId, i.state || T('ma.empty'), i.active ? T('ma.here') : '',
            f ? T('ma.box', (f.ci.source || f.source) + (f.ci.location ? ' ' + f.ci.location.slice(0, 60) : '')) : '') : T('ma.noPlayer', sp.name));
        }
        return {ok: true, message: T('ma.connected', players.length), lines};
      }
      if (path === '/api/ma/scan') {
        const prefixes = (data.prefixes && data.prefixes.length ? data.prefixes : guessPrefixes()).slice(0, 4).map(netPrefix);
        return {ok: true, prefixes, found: await scanMa(prefixes)};
      }
      if (path === '/api/scan') {
        const prefixes = (data.prefixes && data.prefixes.length ? data.prefixes : guessPrefixes()).slice(0, 4).map(netPrefix);
        return {ok: true, prefixes, found: await scanNet(prefixes)};
      }
      throw new Error(T('err.unknownPath'));
    }

    return {route, sanitize, validIp};
  }

  return {createCore, sanitize, validIp};
});
