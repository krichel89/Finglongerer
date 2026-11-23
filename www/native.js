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
  // Rohe TCP-Zeile (nur Box-Neustart, Port 17000): läuft in einem Android-Thread, der Aufruf blockiert kurz
  async function tcp(ip, port, line, timeout) {
    if (!window.STTcp) throw new Error(window.STI18n.t(lang(), 'err.nativeOnly'));
    const r = String(window.STTcp.send(ip, port, line, timeout || 3000));
    if (r !== 'ok') throw new Error(r.replace(/^ERR:\s*/, ''));
    return r;
  }
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
  window.STNative = {http, tcp, WebSocket: window.WebSocket, storage, lang, langPref, setLangPref};
})();
