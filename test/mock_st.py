import sys, os, threading, time, base64, hashlib, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, NAME, DEVID = sys.argv[1], sys.argv[2], sys.argv[3]
S = {"preset": 0, "bal": 0, "source": "STANDBY", "vol": 20, "group": None, "wake_at": 0, "zone": None}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        sys.stderr.write("[%s] %s\n" % (NAME, a[0] % a[1:]))

    def send(self, body, code=200):
        b = body.encode()
        self.send_response(code); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def ws(self):
        key = self.headers["Sec-WebSocket-Key"]
        acc = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.wfile.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n%s\r\n" % (acc, "Sec-WebSocket-Protocol: gabbo\r\n" if self.headers.get("Sec-WebSocket-Protocol") else "")).encode()); self.wfile.flush()
        r = self.rfile
        b0, b1 = r.read(2); ln = b1 & 0x7F
        if ln == 126: ln = int.from_bytes(r.read(2), "big")
        mask = r.read(4); data = bytes(b ^ mask[i % 4] for i, b in enumerate(r.read(ln))).decode()
        sys.stderr.write("[%s] WS %s\n" % (NAME, data))
        rid = re.search(r'requestID="(\d+)"', data).group(1)
        S["bal"] = int(re.search(r"<targetBalance>(-?\d+)<", data).group(1))
        out = ('<msg><header deviceID="%s" url="balance" method="POST"><response requestID="%s" msgType="RESPONSE"/></header><body><balance><targetBalance>%d</targetBalance><actualBalance>%d</actualBalance></balance></body></msg>' % (DEVID, rid, S["bal"], S["bal"])).encode()
        self.wfile.write(bytes([0x81, len(out)]) if len(out) < 126 else bytes([0x81, 126]) + len(out).to_bytes(2, "big")); self.wfile.write(out); self.wfile.flush()
        time.sleep(0.2)

    def do_GET(self):
        p = self.path
        if self.headers.get("Upgrade", "").lower() == "websocket":
            return self.ws()
        if p == "/api/agent/version":
            return self.send('{"version":"mock","presetRows":"2"}')
        if p == "/api/presets":
            return self.send('{"presets":[{"slot":1,"name":"Radio Eins","url":"x"},{"slot":9,"name":"Jazz","url":"y"},{"slot":10}]}')
        if p == "/_played":
            return self.send(S.get("played", ""))
        if p == "/_saved":
            return self.send(S.get("saved", ""))
        if p == "/_dbg":
            return self.send(str(S["preset"]))
        if p == "/presets":
            return self.send('<presets><preset id="1"><ContentItem source="LOCAL_INTERNET_RADIO" location="x"><itemName>Radio Eins</itemName></ContentItem></preset><preset id="3"><ContentItem source="LOCAL_INTERNET_RADIO" location="y"><itemName>Klassik</itemName></ContentItem></preset></presets>')
        if p == "/balance":
            if not S["group"]:
                return self.send("<balance><balanceAvailable>false</balanceAvailable></balance>")
            return self.send("<balance deviceID=\"%s\"><balanceAvailable>true</balanceAvailable><balanceMin>-7</balanceMin><balanceMax>7</balanceMax><balanceDefault>0</balanceDefault><targetBalance>%d</targetBalance><actualBalance>%d</actualBalance></balance>" % (DEVID, S["bal"], S["bal"]))
        if p == "/now_playing":
            src = S["source"]
            if S["wake_at"] and time.time() < S["wake_at"]:
                src = "STANDBY"
            ci = '<ContentItem source="LOCAL_INTERNET_RADIO" location="x"/>' if S["preset"] == 1 and src not in ("STANDBY",) else '<ContentItem source="%s"/>' % src
            self.send('<nowPlaying deviceID="%s" source="%s">%s</nowPlaying>' % (DEVID, src, ci))
        elif p == "/volume":
            self.send('<volume deviceID="%s"><targetvolume>%d</targetvolume><actualvolume>%d</actualvolume><muteenabled>false</muteenabled></volume>' % (DEVID, S["vol"], S["vol"]))
        elif p == "/info":
            self.send('<info deviceID="%s"><name>%s</name><type>SoundTouch 10</type></info>' % (DEVID, NAME))
        elif p == "/getGroup":
            self.send(S["group"] or "<group/>")
        elif p == "/getZone":
            self.send(S["zone"] or "<zone/>")
        elif p == "/removeGroup":
            S["group"] = None; self.send("<status>/removeGroup</status>")
        else:
            self.send("nope", 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0)); body = self.rfile.read(n).decode()
        sys.stderr.write("[%s] POST %s %s\n" % (NAME, self.path, body))
        if self.path == "/api/play":
            S["played"] = body; return self.send("{}")
        if self.path == "/api/box/save-playing":
            S["saved"] = body; return self.send("{}")
        if self.path.startswith("/api/play/"):
            S["preset"] = int(self.path.rsplit("/", 1)[1]); return self.send("{}")
        if self.path == "/key":
            if 'state="release"' in body:
                if ">POWER<" in body:
                    if S["source"] == "STANDBY":
                        S["source"] = "AUX"; S["wake_at"] = time.time() + 2
                    else:
                        S["source"] = "STANDBY"
                elif ">PRESET_" in body:
                    S["preset"] = int(body.split("PRESET_")[1][0])
                elif ">AUX_INPUT<" in body:
                    S["source"] = "BLUETOOTH" if S["source"] == "AUX" else "AUX"
            self.send("<status>/key</status>")
        elif self.path == "/volume":
            S["vol"] = int(body.split(">")[1].split("<")[0]); self.send("<status>/volume</status>")
        elif self.path == "/select":
            if 'source="AUX"' in body: S["source"] = "AUX"
            if 'source="BLUETOOTH"' in body and not os.environ.get("MOCK_NO_BT_SELECT"): S["source"] = "BLUETOOTH"
            self.send("<status>/select</status>")
        elif self.path == "/setZone":
            S["zone"] = body; self.send("<status>/setZone</status>")
        elif self.path == "/addGroup":
            S["group"] = body; self.send("<group/>")
        else:
            self.send("nope", 404)


if os.environ.get("MOCK_NO_AGENT") != "1":
    threading.Thread(target=ThreadingHTTPServer((HOST, 8888), H).serve_forever, daemon=True).start()
ThreadingHTTPServer((HOST, 8090), H).serve_forever()
