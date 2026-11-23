/* Kernlogik: spricht die SoundTouch-Boxen direkt an (HTTP :8090, WebSocket für Balance).
   Läuft in der Android-WebView (Capacitor) und – mit eingesetztem Transport – in Node (Tests).
   Port der Server-Version (server/soundtouch_fernbedienung.py). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.STCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEYS = new Set(['POWER', 'AUX_INPUT', 'VOLUME_UP', 'VOLUME_DOWN', 'MUTE']);
  const DEFAULT_CONFIG = {groupName: 'Gruppe', speakers: [
    {name: 'Musikzimmer', ip: '', max: 70, group: true}, {name: 'Bibliothek', ip: '', max: 70, group: true}]};
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

  function sanitize(cfg) {
    const out = [];
    for (const sp of ((cfg && cfg.speakers) || []).slice(0, 8)) {
      const name = String(sp.name || '').trim().slice(0, 40) || 'Box';
      const raw = String(sp.ip || '').trim();
      const ip = raw ? validIp(raw) : '';
      if (raw && !ip) throw new Error('Ungültige IP bei ' + name + ': ' + raw.slice(0, 40) + ' (nur Heimnetz-Adressen)');
      let mx = parseInt(sp.max, 10);
      if (!Number.isFinite(mx)) mx = 70;
      out.push({name, ip, max: Math.max(10, Math.min(100, mx)), group: !!sp.group});
    }
    const gn = String((cfg && cfg.groupName) || '').trim().slice(0, 30) || 'Gruppe';
    return {speakers: out, groupName: gn};
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
        if (raw) return sanitize(JSON.parse(raw));
      } catch (e) { /* defekte Config -> Standard */ }
      return sanitize(DEFAULT_CONFIG);
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
      return [attr(xml, 'nowPlaying', 'source'), attr(xml, 'nowPlaying', 'deviceID')];
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
      let src, dev;
      try { [src, dev] = await nowPlaying(sp.ip); }
      catch (e) { out.error = 'nicht erreichbar'; return out; }
      Object.assign(out, {online: true, source: src, standby: src === 'STANDBY', deviceID: dev});
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
    function pair(data) {
      const cfg = loadConfig().speakers;
      const li = data.left, ri = data.right;
      if (!(Number.isInteger(li) && Number.isInteger(ri) && li >= 0 && ri >= 0 && li < cfg.length && ri < cfg.length) || li === ri)
        throw new Error('Links/Rechts ungültig');
      if (!cfg[li].ip || !cfg[ri].ip) throw new Error('Beide Boxen brauchen eine IP');
      return [cfg[li], cfg[ri]];
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
      if (path === '/api/volume') {
        const t = targets(data);
        if ('value' in data) return summarize(await runMany(t, sp => doVolume(sp, null, data.value)));
        const d = Math.max(-20, Math.min(20, parseInt(data.delta, 10) || 0));
        return summarize(await runMany(t, sp => doVolume(sp, d, null)));
      }
      if (path === '/api/duo') {
        const [left, right] = pair(data);
        if (data.action === 'read') return Object.assign({ok: true}, await duoRead(left));
        return {ok: true, message: await doDuo(left, right, data.master, data.balance)};
      }
      if (path === '/api/group') {
        const t = loadConfig().speakers.filter(sp => sp.group && sp.ip);
        if (!t.length) throw new Error('Keine Box mit IP in der Gruppe (Einstellungen ⚙)');
        return summarize(await runMany(t, doAuxOn));
      }
      if (path === '/api/scan') {
        const prefixes = (data.prefixes && data.prefixes.length ? data.prefixes : guessPrefixes()).slice(0, 4).map(netPrefix);
        return {ok: true, prefixes, found: await scanNet(prefixes)};
      }
      if (path === '/api/stereo') {
        const [left, right] = pair(data);
        if (data.action === 'pair') return {ok: true, message: await pairSpeakers(left, right)};
        if (data.action === 'unpair') return {ok: true, message: await unpairSpeakers(left, right)};
        throw new Error('Unbekannte Aktion');
      }
      throw new Error('Unbekannter Pfad');
    }

    return {route, sanitize, validIp};
  }

  return {createCore, sanitize, validIp};
});
