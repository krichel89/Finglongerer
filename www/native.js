/* Transport der Android-App: native HTTP-Anfragen (keine CORS-/Mixed-Content-Sperre) und WebSocket der WebView. */
(function () {
  'use strict';
  function plugin() {
    const C = window.Capacitor;
    if (!C) return null;
    if (C.Plugins && C.Plugins.CapacitorHttp) return opts => C.Plugins.CapacitorHttp.request(opts);
    if (typeof C.nativePromise === 'function') return opts => C.nativePromise('CapacitorHttp', 'request', opts);
    return null;
  }
  async function http(method, ip, port, path, body, timeout) {
    const call = plugin();
    if (!call) throw new Error('Nur in der Android-App möglich (native HTTP-Schnittstelle fehlt)');
    const opts = {
      url: 'http://' + ip + ':' + port + path, method,
      headers: body ? {'Content-Type': /^\s*[{\[]/.test(body) ? 'application/json' : 'text/xml'} : {},
      responseType: 'text', connectTimeout: timeout, readTimeout: timeout
    };
    if (body) opts.data = body;
    const res = await call(opts);
    if (res.status >= 400) throw new Error('HTTP ' + res.status);
    return typeof res.data === 'string' ? res.data : String(res.data == null ? '' : JSON.stringify(res.data));
  }
  let storage;
  try { window.localStorage.getItem('x'); storage = window.localStorage; }
  catch (e) { const mem = {}; storage = {getItem: k => mem[k] || null, setItem: (k, v) => { mem[k] = v; }}; }
  window.STNative = {http, WebSocket: window.WebSocket, storage};
})();
