/* Kernlogik: spricht die SoundTouch-Boxen direkt an (HTTP :8090, WebSocket für Balance).
   Läuft in der Android-WebView (Capacitor) und – mit eingesetztem Transport – in Node (Tests).
   Port der Server-Version (server/soundtouch_fernbedienung.py). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.STCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEYS = new Set(['POWER', 'AUX_INPUT', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE',
    'PRESET_1', 'PRESET_2', 'PRESET_3', 'PRESET_4', 'PRESET_5', 'PRESET_6']);
  const DEFAULT_CONFIG = {
    speakers: [{id: 'b1', name: 'Musikzimmer', ip: '', max: 70}, {id: 'b2', name: 'Bibliothek', ip: '', max: 70}],
    groups: [{id: 'g1', name: 'Beide Boxen', members: ['b1', 'b2']}]};
  const CFG_KEY = 'steasyremote.config';

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

  function sanitize(cfg) {
    cfg = cfg || {};
    const speakers = [], used = new Set();
    for (const sp of (cfg.speakers || []).slice(0, 8)) {
      const name = String(sp.name || '').trim().slice(0, 40) || 'Box';
      const raw = String(sp.ip || '').trim();
      const ip = raw ? validIp(raw) : '';
      if (raw && !ip) throw new Error('Ungültige IP bei ' + name + ': ' + raw.slice(0, 40) + ' (nur Heimnetz-Adressen)');
      let mx = parseInt(sp.max, 10);
      if (!Number.isFinite(mx)) mx = 70;
      speakers.push({id: uniqueId(sp.id, used), name, ip, max: Math.max(10, Math.min(100, mx)), _flag: !!sp.group});
    }
    let groups = cfg.groups;
    if (!Array.isArray(groups)) { // Übernahme der Version 0.2 (eine Gruppe über Markierungen an den Boxen)
      const flagged = speakers.filter(sp => sp._flag), m = (flagged.length ? flagged : speakers).map(sp => sp.id);
      const gn = String(cfg.groupName || '').trim();
      groups = m.length ? [{name: (!gn || gn === 'Gruppe') && m.length === 2 ? 'Beide Boxen' : (gn || 'Gruppe'), members: m}] : [];
    }
    const ids = new Set(speakers.map(sp => sp.id)), gused = new Set(), outG = [];
    for (const g of groups.slice(0, 8)) {
      const members = [];
      for (const id of (g.members || [])) if (ids.has(id) && !members.includes(id)) members.push(id);
      if (!members.length) continue;
      outG.push({id: uniqueId(g.id, gused), name: String(g.name || '').trim().slice(0, 30) || 'Gruppe', members});
    }
    speakers.forEach(sp => { delete sp._flag; });
    return {speakers, groups: outG};
  }

  /* env: {http(method, ip, port, path, body, timeoutMs) -> Promise<string>,
           WebSocket, storage, stPort, wsPorts} */
  function createCore(env) {
    const ST_PORT = env.stPort || 8090;
    const WS_PORTS = env.wsPorts || [8080, 8090];
    const TIMEOUT = 3000;
    let ridCounter = 1;

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
      if (!KEYS.has(name)) throw new Error('Unbekannte Taste');
      for (const state of ['press', 'release'])
        await stPost(ip, '/key', '<key state="' + state + '" sender="Gabbo">' + name + '</key>');
    }
    async function nowPlaying(ip) {
      const xml = await stGet(ip, '/now_playing');
      const loc = attr(xml, 'ContentItem', 'location');
      return [attr(xml, 'nowPlaying', 'source'), attr(xml, 'nowPlaying', 'deviceID'),
        loc ? attr(xml, 'ContentItem', 'source') + '|' + loc : ''];
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
        timer = setTimeout(() => finish(new Error('Zeitüberschreitung')), timeout);
        try { ws = protocols.length ? new env.WebSocket(url, protocols) : new env.WebSocket(url); }
        catch (e) { return finish(e); }
        ws.onopen = () => { try { ws.send(msg); } catch (e) { finish(e); } };
        ws.onerror = () => finish(new Error('Verbindung fehlgeschlagen'));
        ws.onclose = () => finish(new Error('Verbindung geschlossen'));
        ws.onmessage = ev => {
          const txt = String(ev.data);
          if (txt.includes('requestID="' + rid + '"') && txt.includes('RESPONSE')) {
            if (/<targetBalance>|<actualBalance>/.test(txt)) finish(null);
            else finish(new Error('Unerwartete Antwort: ' + txt.slice(0, 120)));
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
          catch (e) { last = 'Port ' + port + (protocols.length ? '' : ' (ohne Subprotokoll)') + ': ' + e.message; }
        }
      }
      throw new Error('Balance setzen fehlgeschlagen (' + last + ')');
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
      if (!sp.ip) { out.error = 'keine IP eingetragen'; return out; }
      let src, dev, item;
      try { [src, dev, item] = await nowPlaying(sp.ip); }
      catch (e) { out.error = 'nicht erreichbar'; return out; }
      Object.assign(out, {online: true, source: src, standby: src === 'STANDBY', deviceID: dev, item: item || ''});
      try { const [v, m] = await getVolume(sp.ip); out.volume = v; out.mute = m; } catch (e) { /* egal */ }
      try {
        const g = await getGroup(sp.ip);
        out.group = {paired: g.paired, name: g.name, role: g.roles[dev] || ''};
      } catch (e) { out.group = null; }
      return out;
    }

    // ---- Aktionen
    // AUX direkt wählen (/select). Die Taste AUX_INPUT schaltet je nach Box zwischen AUX und Bluetooth um.
    async function doAuxOn(sp) {
      if ((await nowPlaying(sp.ip))[0] === 'STANDBY') {
        await pressKey(sp.ip, 'POWER');
        if (!(await waitAwake(sp.ip))) throw new Error('Box ist nicht aufgewacht');
        await sleep(1000);
      }
      if ((await nowPlaying(sp.ip))[0] === 'AUX') return 'AUX an';
      await stPost(sp.ip, '/select', '<ContentItem source="AUX" sourceAccount="AUX"></ContentItem>');
      for (let i = 0; i < 4; i++) {
        await sleep(700);
        if ((await nowPlaying(sp.ip))[0] === 'AUX') return 'AUX an';
      }
      throw new Error('AUX nicht aktiv (Quelle: ' + (await nowPlaying(sp.ip))[0] + ')');
    }
    // Bluetooth: direkt wählen (/select); Ersatzweg: AUX_INPUT schaltete bei der Box von AUX auf Bluetooth um
    async function doBluetoothOn(sp) {
      if ((await nowPlaying(sp.ip))[0] === 'STANDBY') {
        await pressKey(sp.ip, 'POWER');
        if (!(await waitAwake(sp.ip))) throw new Error('Box ist nicht aufgewacht');
        await sleep(1000);
      }
      const is = async () => (await nowPlaying(sp.ip))[0] === 'BLUETOOTH';
      if (await is()) return 'Bluetooth an';
      try { await stPost(sp.ip, '/select', '<ContentItem source="BLUETOOTH" sourceAccount=""></ContentItem>'); } catch (e) { /* Ersatzweg */ }
      for (let i = 0; i < 4; i++) { await sleep(700); if (await is()) return 'Bluetooth an'; }
      if ((await nowPlaying(sp.ip))[0] !== 'AUX') {
        try { await stPost(sp.ip, '/select', '<ContentItem source="AUX" sourceAccount="AUX"></ContentItem>'); } catch (e) { /* egal */ }
        await sleep(1200);
      }
      await pressKey(sp.ip, 'AUX_INPUT');
      for (let i = 0; i < 4; i++) { await sleep(700); if (await is()) return 'Bluetooth an'; }
      throw new Error('Bluetooth nicht aktiv (Quelle: ' + (await nowPlaying(sp.ip))[0] + ')');
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
    async function doPreset(sp, n) {
      if (!(n >= 1 && n <= 6)) throw new Error('Taste 1 bis 6');
      if ((await nowPlaying(sp.ip))[0] === 'STANDBY') {
        await pressKey(sp.ip, 'POWER');
        if (!(await waitAwake(sp.ip))) throw new Error('Box ist nicht aufgewacht');
        await sleep(1000);
      }
      await pressKey(sp.ip, 'PRESET_' + n);
      return 'Taste ' + n;
    }
    async function doOff(sp) {
      if ((await nowPlaying(sp.ip))[0] === 'STANDBY') return 'war schon aus';
      await pressKey(sp.ip, 'POWER');
      return 'aus';
    }
    async function doVolume(sp, delta, value) {
      const [cur] = await getVolume(sp.ip);
      let nv = value !== undefined && value !== null ? parseInt(value, 10) : cur + parseInt(delta, 10);
      nv = Math.max(0, Math.min(sp.max, nv));
      await setVolume(sp.ip, nv);
      return 'Lautstärke ' + nv;
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
      if (ids.some(i => !i) || new Set(ids).size !== ids.length) throw new Error('Geräte-IDs nicht lesbar oder doppelt');
      for (let i = 1; i < m.length; i++) {            // Folge-Boxen aus dem Standby holen
        if ((await nowPlaying(m[i].ip))[0] === 'STANDBY') {
          await pressKey(m[i].ip, 'POWER');
          if (!(await waitAwake(m[i].ip))) throw new Error(m[i].name + ' ist nicht aufgewacht');
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
      throw new Error('Zone nicht zustande gekommen (/getZone zeigt nicht alle Boxen)');
    }
    async function isStereoPair(m) { return m.length === 2 && (await getGroup(m[0].ip)).paired; }
    // Quelle auf der Master-Box setzen, dann alle Boxen als Zone koppeln; einzelne Box / Stereopaar wie bisher
    async function zoneRun(m, fn, pairMasterOnly) {
      if (m.length < 2) return runMany(m, fn);
      if (await isStereoPair(m)) return runMany(pairMasterOnly ? [m[0]] : m, fn);
      const master = await runMany([m[0]], fn);
      if (master.errs.length) return master;
      try { await makeZone(m); master.oks.push('Zone mit ' + (m.length - 1) + ' weiteren Boxen'); }
      catch (e) { master.errs.push('Zone: ' + e.message); }
      return master;
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
        return 'Stereopaar: Lautstärke ' + master + ', Balance ' + (target > 0 ? '+' : '') + target;
      }
      const lv = Math.round(master * (1 - Math.max(0, balance) / 100));
      const rv = Math.round(master * (1 - Math.max(0, -balance) / 100));
      const errs = [];
      await Promise.all([[left, lv], [right, rv]].map(async ([sp, v]) => {
        try { await setVolume(sp.ip, v); } catch (e) { errs.push(sp.name + ': ' + e.message); }
      }));
      if (errs.length) throw new Error(errs.join('; '));
      return 'Lautstärke links ' + lv + ', rechts ' + rv;
    }

    async function pairSpeakers(left, right) {
      const [lid] = await getInfo(left.ip);
      const [rid] = await getInfo(right.ip);
      if (!lid || !rid || lid === rid) throw new Error('Geräte-IDs nicht lesbar oder identisch');
      const body = '<group><name>' + esc(left.name + ' + ' + right.name) + '</name><masterDeviceId>' + esc(lid) +
        '</masterDeviceId><roles>' +
        '<groupRole><deviceId>' + esc(lid) + '</deviceId><role>LEFT</role><ipAddress>' + esc(left.ip) + '</ipAddress></groupRole>' +
        '<groupRole><deviceId>' + esc(rid) + '</deviceId><role>RIGHT</role><ipAddress>' + esc(right.ip) + '</ipAddress></groupRole>' +
        '</roles></group>';
      await stPost(left.ip, '/addGroup', body);
      await sleep(2000);
      if (!(await getGroup(left.ip)).paired)
        throw new Error('Box meldet nach addGroup kein Stereopaar - Format/Firmware prüfen');
      return 'Stereopaar gebildet';
    }
    async function unpairSpeakers(a, b) {
      for (const sp of [a, b]) {
        try {
          if ((await getGroup(sp.ip)).paired) {
            await stGet(sp.ip, '/removeGroup');
            await sleep(1500);
            return 'Stereopaar aufgelöst';
          }
        } catch (e) { /* nächste Box */ }
      }
      return 'Kein Stereopaar aktiv';
    }

    // ---- Automatische Suche: /info auf allen Adressen der angegebenen /24-Netze
    function netPrefix(text) {
      const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})(?:\.\d{1,3}(?:\/\d{1,2})?)?$/.exec(String(text).trim());
      if (!m || !validIp(m[1] + '.1')) throw new Error('Ungültiger Suchbereich: ' + String(text).slice(0, 30));
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

    // ---- Routing (gleiche Pfade wie die Server-Version)
    function targets(data) {
      const cfg = loadConfig().speakers;
      if (data.idx === 'all') {
        const t = cfg.filter(s => s.ip);
        if (!t.length) throw new Error('Keine Box mit IP eingetragen');
        return t;
      }
      const sp = Number.isInteger(data.idx) ? cfg[data.idx] : null;
      if (!sp) throw new Error('Unbekannte Box');
      if (!sp.ip) throw new Error('Keine IP eingetragen');
      return [sp];
    }
    function groupMembers(data) {
      const cfg = loadConfig(), g = cfg.groups.find(x => x.id === data.gid);
      if (!g) throw new Error('Unbekannte Gruppe');
      const m = g.members.map(id => cfg.speakers.find(sp => sp.id === id)).filter(Boolean);
      const miss = m.filter(sp => !sp.ip);
      if (miss.length) throw new Error('Keine IP eingetragen: ' + miss.map(sp => sp.name).join(', '));
      return m;
    }

    async function route(path, data) {
      data = data || {};
      if (path === '/api/state') {
        const cfg = loadConfig();
        return {ok: true, config: cfg, speakers: await Promise.all(cfg.speakers.map(speakerState))};
      }
      if (path === '/api/config') return {ok: true, config: saveConfig(data)};
      if (path === '/api/aux') return summarize(await runMany(targets(data), doAuxOn));
      if (path === '/api/off') return summarize(await runMany(targets(data), doOff));
      if (path === '/api/bt') return summarize(await runMany(targets(data), doBluetoothOn));
      if (path === '/api/preset') {
        const n = parseInt(data.n, 10);
        return summarize(await runMany(targets(data), sp => doPreset(sp, n)));
      }
      if (path === '/api/presets') return {ok: true, presets: await getPresets(targets(data)[0].ip)};
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
        if (action === 'presets') return {ok: true, presets: await getPresets(m[0].ip)};
        if (action === 'preset') {
          const n = parseInt(data.n, 10);
          // Stereopaar: Taste nur an der ersten (linken/Master-)Box; sonst Zone mit der ersten Box als Master
          if (!(n >= 1 && n <= 6)) throw new Error('Taste 1 bis 6');
          return summarize(await zoneRun(m, sp => doPreset(sp, n), true));
        }
        if (action === 'read') return Object.assign({ok: true}, n === 2 ? await duoRead(m[0]) : {mode: 'none', balance: null});
        if (action === 'volume') {
          if (n === 2) return {ok: true, message: await doDuo(m[0], m[1], data.master, data.balance)};
          const master = Math.max(0, parseInt(data.master, 10) || 0);
          return summarize(await runMany(m, sp => doVolume(sp, null, Math.min(master, sp.max))));
        }
        if (action === 'pair' || action === 'unpair') {
          if (n !== 2) throw new Error('Stereopaar geht nur mit genau zwei Boxen');
          return {ok: true, message: action === 'pair' ? await pairSpeakers(m[0], m[1]) : await unpairSpeakers(m[0], m[1])};
        }
        throw new Error('Unbekannte Aktion');
      }
      if (path === '/api/scan') {
        const prefixes = (data.prefixes && data.prefixes.length ? data.prefixes : guessPrefixes()).slice(0, 4).map(netPrefix);
        return {ok: true, prefixes, found: await scanNet(prefixes)};
      }
      throw new Error('Unbekannter Pfad');
    }

    return {route, sanitize, validIp};
  }

  return {createCore, sanitize, validIp};
});
