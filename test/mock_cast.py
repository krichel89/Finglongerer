# Simulierter Chromecast-Lautsprecher für test/cast.test.mjs: TLS auf Port argv[1] (CASTV2, Heartbeat, Empfänger, Medien), Name über HTTP auf Port argv[1]+1.
# Aufruf: python3 mock_cast.py PORT ZERTIFIKATSORDNER (c.pem + k.pem)
import json, socket, ssl, struct, sys, threading

def varint(n):
    o = b''
    while n >= 0x80:
        o += bytes([(n & 0x7F) | 0x80]); n >>= 7
    return o + bytes([n])
def s(tag, v):
    v = v.encode(); return bytes([tag]) + varint(len(v)) + v
def enc(src, dst, ns, payload):
    return b'\x08\x00' + s(0x12, src) + s(0x1A, dst) + s(0x22, ns) + b'\x28\x00' + s(0x32, payload)
def dec(d):
    p = 0; m = {}
    while p < len(d):
        tag = d[p]; p += 1; f = tag >> 3; wt = tag & 7
        if wt == 0:
            while d[p] & 0x80: p += 1
            p += 1
        else:
            n = 0; sh = 0
            while True:
                c = d[p]; p += 1; n |= (c & 0x7F) << sh; sh += 7
                if not c & 0x80: break
            m[f] = d[p:p+n].decode(); p += n
    return m

NS_CONN='urn:x-cast:com.google.cast.tp.connection'; NS_HB='urn:x-cast:com.google.cast.tp.heartbeat'
NS_RECV='urn:x-cast:com.google.cast.receiver'; NS_MEDIA='urn:x-cast:com.google.cast.media'
state = {'level': 0.4, 'muted': False, 'app': True, 'ps': 'PLAYING', 'track': 1}
log = []
def recv_status():
    st = {'volume': {'level': state['level'], 'muted': state['muted'], 'controlType': 'attenuation'}}
    if state['app']:
        st['applications'] = [{'appId': 'CC32E753', 'displayName': 'Spotify ä "Test"', 'sessionId': 'sess-1', 'transportId': 'tp-1', 'statusText': 'Spotify',
                               'namespaces': [{'name': NS_MEDIA}, {'name': NS_RECV}]}]
    return {'type': 'RECEIVER_STATUS', 'status': st}
def media_status():
    return {'type': 'MEDIA_STATUS', 'status': [{'mediaSessionId': 7, 'playerState': state['ps'], 'supportedMediaCommands': 274447,
        'media': {'duration': 200, 'metadata': {'title': 'Titel %d ü' % state['track'], 'artist': 'Künstler', 'albumName': 'Album', 'images': [{'url': 'http://x/y.jpg'}]}}}]}

def handle(conn):
    try:
        buf = b''
        def rd(n):
            nonlocal buf
            while len(buf) < n:
                c = conn.recv(65536)
                if not c: raise EOFError
                buf += c
            r, buf = buf[:n], buf[n:]; return r
        def send(src, dst, ns, obj):
            b = enc(src, dst, ns, json.dumps(obj)); conn.sendall(struct.pack('>I', len(b)) + b)
        first = True
        while True:
            n = struct.unpack('>I', rd(4))[0]; m = dec(rd(n))
            ns = m.get(4); dst = m.get(3); src = m.get(2); p = json.loads(m.get(6) or '{}'); t = p.get('type'); rid = p.get('requestId', 0)
            log.append((dst, ns, t))
            if ns == NS_CONN: continue
            if first:
                first = False
                send('receiver-0', src, NS_HB, {'type': 'PING'})          # Heartbeat mitten im Ablauf
                send('receiver-0', src, NS_RECV, dict(recv_status(), requestId=0))   # ungefragte Meldung
            if ns == NS_RECV and t == 'GET_STATUS': send('receiver-0', src, NS_RECV, dict(recv_status(), requestId=rid))
            elif ns == NS_RECV and t == 'SET_VOLUME':
                v = p['volume']
                if 'level' in v: state['level'] = v['level']
                if 'muted' in v: state['muted'] = v['muted']
                send('receiver-0', src, NS_RECV, dict(recv_status(), requestId=rid))
            elif ns == NS_RECV and t == 'STOP':
                state['app'] = False; send('receiver-0', src, NS_RECV, dict(recv_status(), requestId=rid))
            elif ns == NS_MEDIA and dst == 'tp-1':
                if t == 'GET_STATUS': send('tp-1', src, NS_MEDIA, dict(media_status(), requestId=rid))
                elif t in ('PLAY', 'PAUSE') and p.get('mediaSessionId') == 7:
                    state['ps'] = 'PLAYING' if t == 'PLAY' else 'PAUSED'; send('tp-1', src, NS_MEDIA, dict(media_status(), requestId=rid))
                elif t == 'QUEUE_NEXT' and p.get('mediaSessionId') == 7:
                    state['track'] += 1; send('tp-1', src, NS_MEDIA, dict(media_status(), requestId=rid))
                else: send('tp-1', src, NS_MEDIA, {'type': 'INVALID_REQUEST', 'requestId': rid, 'reason': 'INVALID_COMMAND'})
    except Exception:
        pass
    finally:
        conn.close()

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(sys.argv[2] + '/c.pem', sys.argv[2] + '/k.pem')
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(('127.0.0.1', int(sys.argv[1]))); srv.listen(8)
# kleiner HTTP-Dienst für den Namen auf Port+1
def http():
    import http.server
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            b = json.dumps({'name': 'Küche'}).encode(); self.send_response(200); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
        def log_message(self, *a): pass
    http.server.HTTPServer(('127.0.0.1', int(sys.argv[1]) + 1), H).serve_forever()
threading.Thread(target=http, daemon=True).start()
print('ready', flush=True)
while True:
    c, _ = srv.accept()
    try: c = ctx.wrap_socket(c, server_side=True)
    except Exception: continue
    threading.Thread(target=handle, args=(c,), daemon=True).start()
