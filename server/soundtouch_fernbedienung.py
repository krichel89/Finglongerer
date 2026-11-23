#!/usr/bin/env python3
"""
SoundTouch-Fernbedienung (PWA + kleiner Relay-Server), nur Python-Standardbibliothek.

Start:      python3 soundtouch_fernbedienung.py            (Port 8780)
            python3 soundtouch_fernbedienung.py --port 9000
Aufrufen:   http://<server-ip>:8780   -> auf dem Handy "Zum Startbildschirm hinzufuegen"
Einrichten: in der Seite oben rechts auf das Zahnrad -> Namen und IP der Boxen eintragen.
            Die Einstellungen liegen in soundtouch_config.json neben dieser Datei.

Die Seite spricht nie direkt mit den Boxen: Der Server leitet nur Befehle an die
in den Einstellungen eingetragenen Boxen (Port 8090, lokale API) weiter.
Nur im Heimnetz betreiben, NICHT aus dem Internet erreichbar machen (keine Anmeldung).
"""
import argparse
import base64
import ipaddress
import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "soundtouch_config.json")
ST_PORT = int(os.environ.get("SOUNDTOUCH_PORT", "8090"))  # nur fuer Tests aenderbar
TIMEOUT = 3.0
VOLUME_STEP = 3
CSRF_HEADER = "fremote"
CFG_LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=8)

DEFAULT_CONFIG = {
    "speakers": [
        {"name": "Musikzimmer", "ip": "", "max": 70},
        {"name": "Bibliothek", "ip": "", "max": 70},
    ]
}


# ----------------------------------------------------------------- Konfiguration
def valid_ip(text):
    try:
        ip = ipaddress.ip_address(str(text).strip())
    except ValueError:
        return None
    if ip.version != 4 or not (ip.is_private or ip.is_link_local):
        return None
    return str(ip)


def sanitize(cfg):
    out = []
    for sp in list(cfg.get("speakers", []))[:8]:
        name = str(sp.get("name", "")).strip()[:40] or "Box"
        raw = str(sp.get("ip", "")).strip()
        ip = valid_ip(raw) if raw else ""
        if raw and not ip:
            raise ValueError("Ungültige IP bei %s: %s (nur Heimnetz-Adressen)" % (name, raw[:40]))
        try:
            mx = int(sp.get("max", 70))
        except (TypeError, ValueError):
            mx = 70
        out.append({"name": name, "ip": ip, "max": max(10, min(100, mx))})
    return {"speakers": out}


def load_config():
    with CFG_LOCK:
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return sanitize(json.load(f))
        except (OSError, ValueError):
            return sanitize(DEFAULT_CONFIG)


def save_config(cfg):
    cfg = sanitize(cfg)
    with CFG_LOCK:
        fd, tmp = tempfile.mkstemp(dir=HERE, prefix=".cfg-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2, ensure_ascii=False)
            os.replace(tmp, CONFIG_PATH)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return cfg


# ----------------------------------------------------------------- SoundTouch-API
def st_url(ip, path):
    return "http://%s:%d%s" % (ip, ST_PORT, path)


def st_get(ip, path):
    with urllib.request.urlopen(st_url(ip, path), timeout=TIMEOUT) as r:
        return r.read()


def st_post(ip, path, xml_text):
    req = urllib.request.Request(
        st_url(ip, path), data=xml_text.encode("utf-8"), method="POST",
        headers={"Content-Type": "text/xml"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


KEYS = {"POWER", "AUX_INPUT", "VOLUME_UP", "VOLUME_DOWN", "MUTE"}


def press_key(ip, name):
    if name not in KEYS:
        raise ValueError("Unbekannte Taste")
    for state in ("press", "release"):
        st_post(ip, "/key", '<key state="%s" sender="Gabbo">%s</key>' % (state, name))


def now_playing(ip):
    root = ET.fromstring(st_get(ip, "/now_playing"))
    return root.get("source", ""), root.get("deviceID", "")


def get_info(ip):
    root = ET.fromstring(st_get(ip, "/info"))
    return root.get("deviceID", ""), (root.findtext("name") or "")


def get_volume(ip):
    root = ET.fromstring(st_get(ip, "/volume"))
    vol = int(root.findtext("actualvolume") or root.findtext("targetvolume") or 0)
    return vol, (root.findtext("muteenabled") == "true")


def set_volume(ip, value):
    st_post(ip, "/volume", "<volume>%d</volume>" % int(value))


def get_group(ip):
    root = ET.fromstring(st_get(ip, "/getGroup"))
    name = (root.findtext("name") or "").strip()
    roles = {}
    for gr in root.iter("groupRole"):
        roles[(gr.findtext("deviceId") or "").strip()] = (gr.findtext("role") or "").strip()
    master = (root.findtext("masterDeviceId") or "").strip()
    return {"paired": bool(name or roles), "name": name, "roles": roles, "master": master}


def get_balance_range(ip):
    """Liest den Balance-Bereich eines Stereopaars (SoundTouch 10: -7..7). Kurzer Timeout,
    weil die Box in tiefem Standby minutenlang haengen kann."""
    try:
        with urllib.request.urlopen(st_url(ip, "/balance"), timeout=2.0) as r:
            root = ET.fromstring(r.read())
        if root.findtext("balanceAvailable") == "false":
            return None
        lo, hi = int(root.findtext("balanceMin")), int(root.findtext("balanceMax"))
        return lo, hi, int(root.findtext("targetBalance") or 0)
    except Exception:  # noqa: BLE001
        return -7, 7, None


class MiniWebSocket:
    """Winziger WebSocket-Client (nur Text senden/empfangen), Standardbibliothek."""

    def __init__(self, ip, port, timeout=4.0):
        self.s = socket.create_connection((ip, port), timeout=timeout)
        self.s.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((
            "GET / HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: gabbo\r\n\r\n"
            % (ip, port, key)).encode("ascii"))
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.s.recv(4096)
            if not chunk:
                raise RuntimeError("WebSocket: Verbindung geschlossen")
            buf += chunk
            if len(buf) > 16384:
                raise RuntimeError("WebSocket: Antwort zu lang")
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        if b" 101" not in head.split(b"\r\n", 1)[0]:
            raise RuntimeError("WebSocket abgelehnt: %s" % head.split(b"\r\n", 1)[0][:60].decode("latin-1"))

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass

    def _need(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(4096)
            if not chunk:
                raise RuntimeError("WebSocket: Verbindung geschlossen")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send_text(self, text):
        data = text.encode("utf-8")
        hdr = bytearray([0x81])
        n = len(data)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += n.to_bytes(2, "big")
        else:
            hdr.append(0x80 | 127)
            hdr += n.to_bytes(8, "big")
        mask = os.urandom(4)
        hdr += mask
        self.s.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv_text(self):
        """Naechste Textnachricht (Ping wird beantwortet, Fragmente werden zusammengesetzt)."""
        parts = []
        while True:
            b0, b1 = self._need(2)
            op, ln = b0 & 0x0F, b1 & 0x7F
            if ln == 126:
                ln = int.from_bytes(self._need(2), "big")
            elif ln == 127:
                ln = int.from_bytes(self._need(8), "big")
            if ln > 1 << 20:
                raise RuntimeError("WebSocket: Nachricht zu gross")
            payload = self._need(ln)  # Server-Frames sind nicht maskiert
            if op == 0x8:
                raise RuntimeError("WebSocket: von der Box geschlossen")
            if op == 0x9:  # Ping -> Pong
                mask = os.urandom(4)
                self.s.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask +
                               bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
                continue
            if op in (0x1, 0x2, 0x0):
                parts.append(payload)
                if b0 & 0x80:
                    return b"".join(parts).decode("utf-8", "replace")


WS_PORTS = [int(p) for p in os.environ.get("SOUNDTOUCH_WS_PORTS", "8080,8090").split(",")]


def ws_set_balance(ip, device_id, value):
    """Balance eines Stereopaars setzen. HTTP-POST /balance haengt laut Doku, die
    Original-App schreibt ueber WebSocket (mainNode=balanceSet). Port/Format aus
    Community-Doku - ungetestet an echter Hardware."""
    last = None
    for port in WS_PORTS:
        ws = None
        try:
            ws = MiniWebSocket(ip, port)
            rid = str(int(time.time()) % 100000)
            ws.send_text(
                '<msg><header deviceID="%s" url="balance" method="POST">'
                '<request requestID="%s"><info mainNode="balanceSet" type="new"/></request></header>'
                '<body><balance><targetBalance>%d</targetBalance></balance></body></msg>'
                % (escape(device_id), rid, int(value)))
            deadline = time.time() + 4.0
            while time.time() < deadline:
                txt = ws.recv_text()
                if ('requestID="%s"' % rid) in txt and "RESPONSE" in txt:
                    if "<targetBalance>" in txt or "<actualBalance>" in txt:
                        return
                    raise RuntimeError("Unerwartete Antwort: %s" % txt[:120])
            raise RuntimeError("keine Antwort der Box")
        except Exception as e:  # noqa: BLE001
            last = "Port %d: %s" % (port, e)
        finally:
            if ws:
                ws.close()
    raise RuntimeError("Balance setzen fehlgeschlagen (%s)" % last)


def wait_awake(ip, seconds=20):
    deadline = time.time() + seconds
    while time.time() < deadline:
        time.sleep(1.0)
        try:
            if now_playing(ip)[0] != "STANDBY":
                return True
        except Exception:
            pass
    return False


def speaker_state(sp):
    out = {"name": sp["name"], "ip": sp["ip"], "max": sp["max"], "online": False}
    if not sp["ip"]:
        out["error"] = "keine IP eingetragen"
        return out
    ip = sp["ip"]
    try:
        src, dev = now_playing(ip)
    except Exception as e:  # noqa: BLE001
        out["error"] = "nicht erreichbar (%s)" % type(e).__name__
        return out
    out.update(online=True, source=src, standby=(src == "STANDBY"), deviceID=dev)
    try:
        vol, mute = get_volume(ip)
        out["volume"], out["mute"] = vol, mute
    except Exception:  # noqa: BLE001
        pass
    try:
        g = get_group(ip)
        out["group"] = {"paired": g["paired"], "name": g["name"], "role": g["roles"].get(dev, "")}
    except Exception:  # noqa: BLE001
        out["group"] = None
    return out


# ----------------------------------------------------------------- Aktionen
def do_aux_on(sp):
    ip = sp["ip"]
    if now_playing(ip)[0] == "STANDBY":
        press_key(ip, "POWER")
        if not wait_awake(ip):
            raise RuntimeError("Box ist nicht aufgewacht")
        time.sleep(1.0)
    press_key(ip, "AUX_INPUT")
    return "AUX an"


def do_off(sp):
    ip = sp["ip"]
    if now_playing(ip)[0] == "STANDBY":
        return "war schon aus"
    press_key(ip, "POWER")
    return "aus"


def do_volume(sp, delta=None, value=None):
    ip = sp["ip"]
    cur, _ = get_volume(ip)
    new = int(value) if value is not None else cur + int(delta)
    new = max(0, min(sp["max"], new))
    set_volume(ip, new)
    return "Lautstärke %d" % new


def duo_read(left, right):
    """Modus und (bei Stereopaar) aktuelle Balance fuer die Oberflaeche."""
    g = get_group(left["ip"])
    if not g["paired"]:
        return {"mode": "virtual", "balance": None}
    rng = get_balance_range(left["ip"])
    bal = None
    if rng and rng[2] is not None:
        lo, hi, tgt = rng
        bal = round(100 * tgt / hi) if tgt >= 0 else round(100 * tgt / -lo)
    return {"mode": "pair", "balance": bal}


def do_duo(left, right, master, balance):
    """Gesamtlautstaerke + Balance fuer zwei Boxen.
    Stereopaar: echte Balance (WebSocket), Lautstaerke ueber die Master-Box.
    Sonst: virtuelle Balance - die Lautstaerke der abgewandten Box wird abgesenkt."""
    cap = min(left["max"], right["max"])
    master = max(0, min(cap, int(master)))
    balance = max(-100, min(100, int(balance)))
    g = get_group(left["ip"])
    if g["paired"]:
        ldev, _ = get_info(left["ip"])
        rdev, _ = get_info(right["ip"])
        m = g["master"]
        box, dev = (right, rdev) if (m and m == rdev) else (left, ldev)
        set_volume(box["ip"], master)
        rng = get_balance_range(box["ip"]) or (-7, 7, None)
        lo, hi = rng[0], rng[1]
        target = round(balance / 100 * hi) if balance >= 0 else round(balance / 100 * -lo)
        ws_set_balance(box["ip"], dev, target)
        return "Stereopaar: Lautstärke %d, Balance %+d" % (master, target)
    lv = round(master * (1 - max(0, balance) / 100))
    rv = round(master * (1 - max(0, -balance) / 100))
    errs = []

    def one(args):
        sp, v = args
        try:
            set_volume(sp["ip"], v)
        except Exception as e:  # noqa: BLE001
            errs.append("%s: %s" % (sp["name"], e))
    list(POOL.map(one, [(left, lv), (right, rv)]))
    if errs:
        raise RuntimeError("; ".join(errs))
    return "Lautstärke links %d, rechts %d" % (lv, rv)


def run_many(targets, fn):
    """targets: Liste (index, speaker). Gibt (ok_texts, fehler_texte) zurueck."""
    def one(t):
        i, sp = t
        try:
            return sp["name"], fn(sp), None
        except Exception as e:  # noqa: BLE001
            return sp["name"], None, "%s: %s" % (type(e).__name__, e)
    oks, errs = [], []
    for name, res, err in POOL.map(one, targets):
        if err:
            errs.append("%s: %s" % (name, err))
        else:
            oks.append("%s: %s" % (name, res))
    return oks, errs


def pair_speakers(left, right):
    lid, _ = get_info(left["ip"])
    rid, _ = get_info(right["ip"])
    if not lid or not rid or lid == rid:
        raise RuntimeError("Geräte-IDs nicht lesbar oder identisch")
    name = escape("%s + %s" % (left["name"], right["name"]))
    body = (
        "<group><name>%s</name><masterDeviceId>%s</masterDeviceId><roles>"
        "<groupRole><deviceId>%s</deviceId><role>LEFT</role><ipAddress>%s</ipAddress></groupRole>"
        "<groupRole><deviceId>%s</deviceId><role>RIGHT</role><ipAddress>%s</ipAddress></groupRole>"
        "</roles></group>"
    ) % (name, escape(lid), escape(lid), escape(left["ip"]), escape(rid), escape(right["ip"]))
    st_post(left["ip"], "/addGroup", body)
    time.sleep(2.0)
    g = get_group(left["ip"])
    if not g["paired"]:
        raise RuntimeError("Box meldet nach addGroup kein Stereopaar - Format/Firmware prüfen")
    return "Stereopaar gebildet"


def unpair_speakers(a, b):
    done = False
    for sp in (a, b):
        try:
            if get_group(sp["ip"])["paired"]:
                st_get(sp["ip"], "/removeGroup")
                time.sleep(1.5)
                done = True
                break
        except Exception:  # noqa: BLE001
            continue
    if not done:
        return "Kein Stereopaar aktiv"
    return "Stereopaar aufgelöst"


# ----------------------------------------------------------------- Web-Oberflaeche
HTML = r"""<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#14161a">
<meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<title>Boxen</title>
<link rel="stylesheet" href="/style.css">
</head><body>
<header><h1>Boxen</h1><button id="btn-settings" class="icon" aria-label="Einstellungen">&#9881;</button></header>
<main>
  <section class="row2">
    <button id="all-aux" class="primary">Alle: AUX an</button>
    <button id="all-off">Alle: Aus</button>
  </section>
  <section id="cards"></section>
  <section class="card" id="stereo">
    <div class="head"><h2>Beide Boxen</h2><span id="duo-mode" class="badge"></span></div>
    <div class="pairsel">
      <label>Links <select id="sel-left"></select></label>
      <button id="btn-swap" class="icon" aria-label="Tauschen">&#8646;</button>
      <label>Rechts <select id="sel-right"></select></label>
    </div>
    <div class="vol">
      <button id="duo-down">&minus;</button>
      <input type="range" id="duo-vol" min="0" max="70" value="0">
      <button id="duo-up">+</button>
      <span class="v" id="duo-vol-txt">Gesamtlautst&auml;rke</span>
    </div>
    <div class="vol bal">
      <span class="side">L</span>
      <input type="range" id="duo-bal" min="-100" max="100" step="5" value="0">
      <span class="side">R</span>
      <span class="v" id="duo-bal-txt">Balance: Mitte</span>
      <button id="duo-center" class="small">Mitte</button>
    </div>
    <div class="row2">
      <button id="btn-pair" class="primary">Stereopaar bilden</button>
      <button id="btn-unpair">Aufl&ouml;sen</button>
    </div>
    <p class="hint" id="duo-hint"></p>
  </section>
</main>
<div id="toast" role="status"></div>
<dialog id="dlg">
  <form method="dialog" id="dlg-form">
    <h2>Einstellungen</h2>
    <div id="dlg-rows"></div>
    <button type="button" id="dlg-add">+ Box hinzuf&uuml;gen</button>
    <p class="hint">IP der Box steht in der SoundTouch-App unter Einstellungen &rarr; Lautsprecher &rarr; Info. &bdquo;Max&ldquo; ist die h&ouml;chste Lautst&auml;rke, die diese Fernbedienung einstellt.</p>
    <div class="row2">
      <button value="cancel">Abbrechen</button>
      <button id="dlg-save" class="primary" value="ok">Speichern</button>
    </div>
  </form>
</dialog>
<script src="/app.js"></script>
</body></html>
"""

CSS = r"""
:root{--bg:#14161a;--card:#1d2026;--line:#2c313a;--fg:#e8eaee;--dim:#98a0ad;--acc:#4f9dff;--ok:#49c07a;--bad:#ff6b6b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
header{display:flex;justify-content:space-between;align-items:center;padding:14px 16px 6px}
h1{font-size:1.4rem;margin:0}h2{font-size:1.1rem;margin:0}
main{max-width:560px;margin:0 auto;padding:6px 14px 40px;display:grid;gap:12px}
button,select,input{font:inherit;color:var(--fg)}
button{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 12px;min-height:50px;cursor:pointer}
button:active{filter:brightness(1.3)}button:disabled{opacity:.5}
button.primary{background:var(--acc);border-color:var(--acc);color:#071428;font-weight:600}
button.icon{min-height:44px;min-width:44px;padding:6px 10px;font-size:1.3rem}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;display:grid;gap:12px}
.head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.badge{font-size:.8rem;padding:3px 10px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.badge.on{color:var(--ok);border-color:var(--ok)}.badge.err{color:var(--bad);border-color:var(--bad)}
.sub{color:var(--dim);font-size:.85rem}
.vol{display:grid;grid-template-columns:56px 1fr 56px;gap:10px;align-items:center}
.vol .v{grid-column:1/-1;text-align:center;color:var(--dim);font-size:.9rem}
input[type=range]{width:100%;height:40px;accent-color:var(--acc)}
.pairsel{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:end}
.pairsel label{display:grid;gap:4px;font-size:.85rem;color:var(--dim)}
select,dialog input{background:#12151a;border:1px solid var(--line);border-radius:10px;padding:12px;min-height:46px;width:100%}
.hint{color:var(--dim);font-size:.82rem;margin:0}
.vol.bal{grid-template-columns:28px 1fr 28px}.vol.bal .side{text-align:center;color:var(--dim);font-weight:600}
.vol.bal .v{grid-column:1/3}button.small{min-height:40px;padding:6px 10px;grid-column:3/4;justify-self:end}
#toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);max-width:92vw;
  background:#0b0d10;border:1px solid var(--line);border-radius:12px;padding:12px 16px;opacity:0;pointer-events:none;transition:opacity .2s}
#toast.show{opacity:1}#toast.err{border-color:var(--bad);color:var(--bad)}
dialog{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:16px;padding:16px;width:min(92vw,520px)}
dialog::backdrop{background:#000a}
#dlg-form{display:grid;gap:12px}
.srow{display:grid;grid-template-columns:1.7fr 1.3fr 62px 44px;gap:6px;align-items:center}
.srow button{min-height:46px;padding:4px}
"""

JS = r"""
'use strict';
const $ = (s, el = document) => el.querySelector(s);
let cfg = {speakers: []}, state = [], dragging = false, inflight = 0, cfgSig = '', duoMode = null, duoBalRead = false;

async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Requested-With': 'fremote'},
    body: JSON.stringify(body)
  };
  const r = await fetch(path, opt);
  let j; try { j = await r.json(); } catch (e) { j = {ok: false, error: 'Ungültige Antwort'}; }
  if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
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
"""

MANIFEST = json.dumps({
    "name": "Boxen-Fernbedienung", "short_name": "Boxen", "start_url": "/", "scope": "/",
    "display": "standalone", "background_color": "#14161a", "theme_color": "#14161a",
    "icons": [{"src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any"}],
})

ICON = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#14161a"/>'
    '<rect x="150" y="96" width="212" height="320" rx="28" fill="#1d2026" stroke="#4f9dff" stroke-width="14"/>'
    '<circle cx="256" cy="168" r="30" fill="#4f9dff"/><circle cx="256" cy="312" r="62" fill="none" stroke="#4f9dff" stroke-width="14"/>'
    '<circle cx="256" cy="312" r="22" fill="#4f9dff"/></svg>'
)

STATIC = {
    "/": (HTML.encode("utf-8"), "text/html; charset=utf-8"),
    "/style.css": (CSS.encode("utf-8"), "text/css; charset=utf-8"),
    "/app.js": (JS.encode("utf-8"), "text/javascript; charset=utf-8"),
    "/manifest.webmanifest": (MANIFEST.encode("utf-8"), "application/manifest+json"),
    "/icon.svg": (ICON.encode("utf-8"), "image/svg+xml"),
}
CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'"


class Handler(BaseHTTPRequestHandler):
    server_version = "STRemote/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in STATIC:
            body, ctype = STATIC[path]
            return self._send(200, body, ctype)
        if path == "/api/state":
            cfg = load_config()
            speakers = list(POOL.map(speaker_state, cfg["speakers"]))
            return self._json(200, {"ok": True, "config": cfg, "speakers": speakers})
        self._json(404, {"ok": False, "error": "nicht gefunden"})

    def do_POST(self):
        if self.headers.get("X-Requested-With") != CSRF_HEADER:
            return self._json(403, {"ok": False, "error": "verboten"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 65536:
                raise ValueError("zu groß")
            data = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(data, dict):
                raise ValueError("JSON-Objekt erwartet")
        except (ValueError, TypeError) as e:
            return self._json(400, {"ok": False, "error": "Ungültige Anfrage: %s" % e})
        path = self.path.split("?", 1)[0]
        try:
            result = self.route(path, data)
        except ValueError as e:
            return self._json(400, {"ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            return self._json(502, {"ok": False, "error": "%s: %s" % (type(e).__name__, e)})
        if result is None:
            return self._json(404, {"ok": False, "error": "nicht gefunden"})
        self._json(200 if result["ok"] else 502, result)

    # -- Routen
    def targets(self, data):
        cfg = load_config()["speakers"]
        idx = data.get("idx")
        if idx == "all":
            t = [(i, sp) for i, sp in enumerate(cfg) if sp["ip"]]
        elif isinstance(idx, int) and 0 <= idx < len(cfg):
            t = [(idx, cfg[idx])]
        else:
            raise ValueError("Unbekannte Box")
        t = [x for x in t if x[1]["ip"]]
        if not t:
            raise ValueError("Keine Box mit IP eingetragen")
        return t

    @staticmethod
    def summarize(oks, errs):
        if errs and not oks:
            return {"ok": False, "error": "; ".join(errs)}
        return {"ok": True, "message": "; ".join(oks + errs)}

    def route(self, path, data):
        if path == "/api/config":
            return {"ok": True, "config": save_config(data)}
        if path == "/api/aux":
            return self.summarize(*run_many(self.targets(data), do_aux_on))
        if path == "/api/off":
            return self.summarize(*run_many(self.targets(data), do_off))
        if path == "/api/volume":
            t = self.targets(data)
            if "value" in data:
                v = int(data["value"])
                return self.summarize(*run_many(t, lambda sp: do_volume(sp, value=v)))
            d = max(-20, min(20, int(data.get("delta", 0))))
            return self.summarize(*run_many(t, lambda sp: do_volume(sp, delta=d)))
        if path == "/api/duo":
            cfg = load_config()["speakers"]
            li, ri = data.get("left"), data.get("right")
            if not (isinstance(li, int) and isinstance(ri, int) and 0 <= li < len(cfg) and 0 <= ri < len(cfg)) or li == ri:
                raise ValueError("Links/Rechts ungültig")
            left, right = cfg[li], cfg[ri]
            if not left["ip"] or not right["ip"]:
                raise ValueError("Beide Boxen brauchen eine IP")
            if data.get("action") == "read":
                r = duo_read(left, right)
                r["ok"] = True
                return r
            return {"ok": True, "message": do_duo(left, right, data.get("master", 0), data.get("balance", 0))}
        if path == "/api/stereo":
            cfg = load_config()["speakers"]
            li, ri = data.get("left"), data.get("right")
            if not (isinstance(li, int) and isinstance(ri, int) and 0 <= li < len(cfg) and 0 <= ri < len(cfg)) or li == ri:
                raise ValueError("Links/Rechts ungueltig")
            left, right = cfg[li], cfg[ri]
            if not left["ip"] or not right["ip"]:
                raise ValueError("Beide Boxen brauchen eine IP")
            if data.get("action") == "pair":
                return {"ok": True, "message": pair_speakers(left, right)}
            if data.get("action") == "unpair":
                return {"ok": True, "message": unpair_speakers(left, right)}
            raise ValueError("Unbekannte Aktion")
        return None


def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description="SoundTouch-Fernbedienung")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8780)
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print("Fernbedienung läuft: http://%s:%d  (Strg+C beendet)" % (local_ip(), args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
