/* Transport der Android-App: native HTTP-Anfragen (keine CORS-/Mixed-Content-Sperre), WebSocket der WebView, Spracheinstellung. */
(function () {
  'use strict';
  function plugin() {
    const C = window.Capacitor;
    if (!C) return null;
    if (C.Plugins && C.Plugins.CapacitorHttp) return opts => C.Plugins.CapacitorHttp.request(opts);
    if (typeof C.nativePromise === 'function') return opts => C.nativePromise('CapacitorHttp', 'request', opts);
    return null;
  }
  async function http(method, ip, port, path, body, timeout, extra) {
    const call = plugin();
    if (!call) throw new Error(window.STI18n.t(lang(), 'err.nativeOnly'));
    const opts = {
      url: 'http://' + ip + ':' + port + path, method,
      headers: Object.assign(body ? {'Content-Type': /^\s*[{\[]/.test(body) ? 'application/json' : 'text/xml'} : {}, extra || {}),
      responseType: 'text', connectTimeout: timeout, readTimeout: timeout
    };
    if (body) opts.data = body;
    const res = await call(opts);
    if (res.status >= 400) throw new Error('HTTP ' + res.status);
    return typeof res.data === 'string' ? res.data : String(res.data == null ? '' : JSON.stringify(res.data));
  }
  // Home-Assistant-REST (nativ, keine CORS-Sperre): base = http(s)://host:port, Token = Langzeit-Zugangstoken
  async function haApi(method, base, path, token, body) {
    const call = plugin();
    if (!call) throw new Error(window.STI18n.t(lang(), 'err.nativeOnly'));
    const opts = {url: base.replace(/\/+$/, '') + path, method, responseType: 'text', connectTimeout: 5000, readTimeout: 8000,
      headers: Object.assign({Authorization: 'Bearer ' + token}, body ? {'Content-Type': 'application/json'} : {})};
    if (body) opts.data = body;
    const res = await call(opts);
        if (res.status >= 400) throw new Error('Home Assistant: HTTP ' + res.status);
    const d = res.data;
    return typeof d === 'string' ? (d ? JSON.parse(d) : null) : d;
  }
  // Rohe TCP-Zeile (nur Box-Neustart, Port 17000): läuft in einem Android-Thread, der Aufruf blockiert kurz
  async function tcp(ip, port, line, timeout) {
    if (!window.STTcp) throw new Error(window.STI18n.t(lang(), 'err.nativeOnly'));
    const r = String(window.STTcp.send(ip, port, line, timeout || 3000));
    if (r !== 'ok') throw new Error(r.replace(/^ERR:\s*/, ''));
    return r;
  }
  // Google TV: Aufrufe an die Android-Brücke (window.STTv); Antwort "ok" oder "ERR:art[:text]"
  function tvCall(fn, ...args) {
    if (!window.STTv) throw new Error(window.STI18n.t(lang(), 'err.nativeOnly'));
    const r = String(window.STTv[fn](...args));
    if (r === 'ok' || r === 'nofield' || (fn === 'scan' && !r.startsWith('ERR:'))) return r;
    const m = /^ERR:(\w+)(?::([\s\S]*))?$/.exec(r) || [], T = (k, a) => window.STI18n.t(lang(), k, a);
    if (m[1] === 'net') throw new Error(T('err.tvNet'));
    if (m[1] === 'auth') throw new Error(T('err.tvAuth'));
    if (m[1] === 'ip') throw new Error(T('err.tvIp'));
    if (m[1] === 'code') throw new Error(T('err.tvCode', m[2] || ''));
    throw new Error(T('err.tvOther', m[2] || r));
  }
  const tv = {
    pairStart: async ip => tvCall('pairStart', ip), pairFinish: async code => tvCall('pairFinish', code),
    connect: async ip => tvCall('connect', ip), power: async (ip, on) => tvCall('power', ip, !!on), wake: async mac => tvCall('wake', mac),
    // Zeilen "ip TAB name TAB mac" -> [{ip, name, mac}]
    scan: async prefix => tvCall('scan', prefix || '').split('\n').filter(Boolean).map(l => { const f = l.split('\t'); return {ip: f[0], name: f[1] || 'Google TV', mac: f[2] || ''}; }),
    info: () => { try { const f = String(window.STTv.lastInfo()).split('\t'); return {name: f[0] || '', mac: f[1] || ''}; } catch (e) { return {name: '', mac: ''}; } }, key: async (ip, code) => tvCall('key', ip, code), text: async (ip, txt) => tvCall('text', ip, txt), keyd: async (ip, code, dir) => tvCall('keyd', ip, code, dir), voice: async (ip, on) => tvCall('voice', ip, !!on), launch: async (ip, link) => tvCall('launch', ip, link)
  };
  // Home Assistant: natives WebView über dem Platzhalter des Reiters (window.STHa); Ort in CSS-Pixeln
  const ha = {
    show: (url, x, y, w, h, clean) => { if (!window.STHa) throw new Error(window.STI18n.t(lang(), 'err.nativeOnly')); const r = String(window.STHa.show(url, x, y, w, h, !!clean)); if (r !== 'ok') throw new Error(r); },
    hide: () => { try { if (window.STHa) window.STHa.hide(); } catch (e) { /* egal */ } },
    back: () => { try { return !!(window.STHa && window.STHa.back()); } catch (e) { return false; } }
  };
  // Chromecast-Lautsprecher (z. B. JBL): Aufträge laufen im Handy im Hintergrund, hier wird auf das Ergebnis gewartet
  async function castCall(op, ip, arg) {
    if (!window.STCast) throw new Error(window.STI18n.t(lang(), 'err.nativeOnly'));
    const T = (k, a) => window.STI18n.t(lang(), k, a);
    let r = String(window.STCast.start(op, ip || '', arg == null ? '' : String(arg)));
    if (/^\d+$/.test(r)) {
      const id = r, end = Date.now() + 40000;
      for (r = ''; r === '' && Date.now() < end; ) { await new Promise(res => setTimeout(res, 60)); r = String(window.STCast.poll(id)); }
      if (r === '') throw new Error(T('err.castNet'));
    }
    const m = /^ERR:(\w+)(?::([\s\S]*))?$/.exec(r);
    if (m) throw new Error(m[1] === 'net' ? T('err.castNet') : m[1] === 'ip' ? T('err.tvIp') : T('err.castOther', m[2] || r));
    return r === '-' ? '' : r;
  }
  const cast = {
    // Zeilen "ip TAB name" -> [{ip, name}]
    scan: async prefix => (await castCall('scan', '', prefix || '')).split('\n').filter(Boolean).map(l => { const f = l.split('\t'); return {ip: f[0], name: f[1] || 'Chromecast'}; }),
    status: async ip => JSON.parse(await castCall('status', ip)), volume: async (ip, pct) => castCall('volume', ip, Math.round(pct)),
    mute: async (ip, on) => castCall('mute', ip, on ? 1 : 0), media: async (ip, cmd) => castCall('media', ip, cmd), stop: async ip => castCall('stop', ip)
  };
  let storage;
  try { window.localStorage.getItem('x'); storage = window.localStorage; }
  catch (e) { const mem = {}; storage = {getItem: k => mem[k] || null, setItem: (k, v) => { mem[k] = v; }}; }
  // Sprache: gespeicherte Wahl (auto/de/en); "auto" folgt der Systemsprache des Geräts
  const LANG_KEY = 'finglongerer.lang';
  const langPref = () => { try { const v = storage.getItem(LANG_KEY); return v === 'de' || v === 'en' ? v : 'auto'; } catch (e) { return 'auto'; } };
  const lang = () => window.STI18n.resolve(langPref(), (navigator.languages && navigator.languages[0]) || navigator.language);
  const setLangPref = v => { try { storage.setItem(LANG_KEY, v === 'de' || v === 'en' ? v : 'auto'); } catch (e) { /* egal */ } };
  // Fernseher (Google TV): Klasse "tv" für größere Oberfläche und sichtbaren Fokus; ?tv=1 zum Ansehen im Browser
  try { if ((window.STDevice && window.STDevice.isTv()) || /[?&]tv=1\b/.test(location.search)) document.documentElement.classList.add('tv'); } catch (e) { /* kein Fernseher */ }
  window.STNative = {http, haApi, cast, tcp, tv, ha, WebSocket: window.WebSocket, storage, lang, langPref, setLangPref};
})();
