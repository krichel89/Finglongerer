package de.krichel.finglongerer;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Chromecast-Protokoll (CASTV2) für Lautsprecher mit "Chromecast built-in" (z. B. JBL Playlist): TLS auf Port 8009,
 * jede Nachricht = 4 Byte Länge + Protobuf "CastMessage" mit JSON-Text. Gesteuert wird ohne Sender-SDK:
 * Lautstärke/Stumm/Beenden über den Empfänger "receiver-0", Wiedergabe über die Medien-Verbindung der laufenden App.
 * Reines Java (ohne Android-Klassen), damit es sich am Rechner gegen einen simulierten Lautsprecher testen lässt.
 */
final class CastLink implements AutoCloseable {
    static final int PORT = 8009;
    /** Port der Abläufe; nur der Test am Rechner ändert ihn. */
    static volatile int port = PORT;
    static final String NS_CONN = "urn:x-cast:com.google.cast.tp.connection";
    static final String NS_HB = "urn:x-cast:com.google.cast.tp.heartbeat";
    static final String NS_RECV = "urn:x-cast:com.google.cast.receiver";
    static final String NS_MEDIA = "urn:x-cast:com.google.cast.media";
    private static final String SRC = "sender-fgl";
    private static final int MAX_MSG = 1 << 20;

    /** Eine empfangene Nachricht. */
    static final class Msg {
        String src = "", dst = "", ns = "", payload = "";
    }

    private final Socket sock;
    private final DataInputStream in;
    private final OutputStream out;
    private int reqId = 100;

    /** Öffnet die Verbindung (TLS, das Zertifikat des Lautsprechers wird nicht geprüft: nur Heimnetz-Adressen, siehe Brücke). */
    CastLink(String ip, int port, int timeoutMs) throws IOException {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(ip, port), Math.min(timeoutMs, 3000));
            SSLSocket t = (SSLSocket) factory().createSocket(s, ip, port, true);
            t.setSoTimeout(timeoutMs);
            t.startHandshake();
            sock = t;
        } catch (IOException | RuntimeException e) {
            try { s.close(); } catch (IOException x) { /* egal */ }
            throw e;
        }
        in = new DataInputStream(sock.getInputStream());
        out = sock.getOutputStream();
    }

    @Override
    public void close() {
        try { sock.close(); } catch (IOException e) { /* egal */ }
    }

    private static SSLSocketFactory fac;

    private static synchronized SSLSocketFactory factory() throws IOException {
        if (fac == null) {
            try {
                TrustManager trustAll = new X509TrustManager() {
                    @Override public void checkClientTrusted(X509Certificate[] c, String a) { }
                    @Override public void checkServerTrusted(X509Certificate[] c, String a) { }
                    @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                };
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(null, new TrustManager[]{trustAll}, new SecureRandom());
                fac = ctx.getSocketFactory();
            } catch (Exception e) {
                throw new IOException(e);
            }
        }
        return fac;
    }

    // ---- Protobuf "CastMessage": 1 version(0) 2 source 3 destination 4 namespace 5 payload_type(0=Text) 6 payload_utf8

    static byte[] encode(String src, String dst, String ns, String payload) {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write(0x08); b.write(0);
        str(b, 0x12, src); str(b, 0x1A, dst); str(b, 0x22, ns);
        b.write(0x28); b.write(0);
        str(b, 0x32, payload);
        return b.toByteArray();
    }

    private static void str(ByteArrayOutputStream b, int tag, String s) {
        byte[] v = s.getBytes(StandardCharsets.UTF_8);
        b.write(tag);
        int n = v.length;
        while (n >= 0x80) { b.write((n & 0x7F) | 0x80); n >>>= 7; }
        b.write(n);
        b.write(v, 0, v.length);
    }

    static Msg decode(byte[] d) throws IOException {
        Msg m = new Msg();
        int p = 0;
        while (p < d.length) {
            int tag = d[p++] & 0xFF, wt = tag & 7, f = tag >> 3;
            if (wt == 0) {                                   // Zahl: überspringen
                while (p < d.length && (d[p++] & 0x80) != 0) { /* weiter */ }
            } else if (wt == 2) {                            // Text/Bytes
                int n = 0, sh = 0, c;
                do {
                    if (p >= d.length || sh > 28) throw new IOException("Nachricht kaputt");
                    c = d[p++] & 0xFF; n |= (c & 0x7F) << sh; sh += 7;
                } while ((c & 0x80) != 0);
                if (n < 0 || p + n > d.length) throw new IOException("Nachricht kaputt");
                String s = new String(d, p, n, StandardCharsets.UTF_8);
                if (f == 2) m.src = s; else if (f == 3) m.dst = s; else if (f == 4) m.ns = s; else if (f == 6) m.payload = s;
                p += n;
            } else {
                throw new IOException("Nachricht kaputt");
            }
        }
        return m;
    }

    void send(String dst, String ns, String json) throws IOException {
        byte[] body = encode(SRC, dst, ns, json);
        byte[] frame = new byte[4 + body.length];
        frame[0] = (byte) (body.length >>> 24); frame[1] = (byte) (body.length >>> 16); frame[2] = (byte) (body.length >>> 8); frame[3] = (byte) body.length;
        System.arraycopy(body, 0, frame, 4, body.length);
        out.write(frame);
        out.flush();
    }

    /** Liest die nächste Nachricht; Heartbeat-PING wird sofort mit PONG beantwortet. */
    Msg read() throws IOException {
        while (true) {
            int n = in.readInt();
            if (n < 0 || n > MAX_MSG) throw new IOException("Nachricht zu groß");
            byte[] d = new byte[n];
            in.readFully(d);
            Msg m = decode(d);
            if (NS_HB.equals(m.ns)) {
                if (m.payload.contains("PING")) send(m.src, NS_HB, "{\"type\":\"PONG\"}");
                continue;
            }
            return m;
        }
    }

    /**
     * Schickt eine Anfrage (requestId wird ergänzt) und wartet auf die Antwort mit derselben requestId. Ungefragte Meldungen
     * (requestId 0, z. B. eine Statusänderung) gelten nur als Ersatz, falls der Lautsprecher die requestId nicht zurückschickt.
     */
    Map<String, Object> request(String dst, String ns, String type, String extra, String... answerTypes) throws IOException {
        int id = ++reqId;
        send(dst, ns, "{\"type\":\"" + type + "\"" + (extra == null || extra.isEmpty() ? "" : "," + extra) + ",\"requestId\":" + id + "}");
        long end = System.currentTimeMillis() + 4000;
        Map<String, Object> fallback = null;
        while (System.currentTimeMillis() < end) {
            Msg m;
            try {
                m = read();
            } catch (java.net.SocketTimeoutException e) {
                if (fallback != null) return fallback;
                throw e;
            }
            Object o;
            try { o = MiniJson.parse(m.payload); } catch (RuntimeException e) { continue; }
            Map<String, Object> j = MiniJson.obj(o);
            String t = MiniJson.str(j, "type");
            boolean mine = (int) MiniJson.num(j, "requestId", -1) == id;
            if (mine && (t.equals("INVALID_REQUEST") || t.equals("INVALID_PLAYER_STATE") || t.equals("LOAD_FAILED") || t.equals("LOAD_CANCELLED")))
                throw new IOException("CAST:" + (MiniJson.str(j, "reason").isEmpty() ? t : MiniJson.str(j, "reason")));
            if (mine) return j;
            if (fallback == null) for (String a : answerTypes) if (a.equals(t)) { fallback = j; end = Math.min(end, System.currentTimeMillis() + 1200); }
        }
        if (fallback != null) return fallback;
        throw new java.net.SocketTimeoutException("keine Antwort");
    }

    void connect(String dst) throws IOException {
        send(dst, NS_CONN, "{\"type\":\"CONNECT\"}");
    }

    // ---- Abläufe

    /** Zustand: Lautstärke, Stumm, laufende App und (wenn vorhanden) Medienstatus. Antwort als JSON-Text. */
    static String status(String ip) throws IOException {
        try (CastLink c = new CastLink(ip, port, 3500)) {
            return c.statusJson();
        }
    }

    private Map<String, Object> receiver() throws IOException {
        connect("receiver-0");
        Map<String, Object> st = MiniJson.obj(request("receiver-0", NS_RECV, "GET_STATUS", null, "RECEIVER_STATUS").get("status"));
        return st;
    }

    private String statusJson() throws IOException {
        Map<String, Object> st = receiver();
        return describe(st, null);
    }

    /** Baut die Antwort aus dem Empfängerstatus; media = bereits gelesener Medienstatus oder null (dann wird er bei Bedarf geholt). */
    private String describe(Map<String, Object> st, Map<String, Object> media) throws IOException {
        Map<String, Object> vol = MiniJson.obj(st.get("volume"));
        StringBuilder o = new StringBuilder("{");
        o.append("\"volume\":").append(MiniJson.num(vol, "level", -1)).append(",\"muted\":").append(MiniJson.bool(vol, "muted"));
        Map<String, Object> app = null;
        for (Object a : MiniJson.list(st.get("applications"))) { app = MiniJson.obj(a); break; }
        if (app != null) {
            o.append(",\"app\":").append(MiniJson.quote(MiniJson.str(app, "displayName")));
            o.append(",\"status\":").append(MiniJson.quote(MiniJson.str(app, "statusText")));
            o.append(",\"session\":").append(MiniJson.quote(MiniJson.str(app, "sessionId")));
            String tr = MiniJson.str(app, "transportId");
            boolean hasMedia = false;
            for (Object n : MiniJson.list(app.get("namespaces"))) if (NS_MEDIA.equals(MiniJson.str(MiniJson.obj(n), "name"))) hasMedia = true;
            if (hasMedia && !tr.isEmpty()) {
                if (media == null) {
                    try {
                        connect(tr);
                        media = request(tr, NS_MEDIA, "GET_STATUS", null, "MEDIA_STATUS");
                    } catch (IOException e) {
                        if (!(e instanceof java.net.SocketTimeoutException) && !String.valueOf(e.getMessage()).startsWith("CAST:")) throw e;
                    }
                }
                if (media != null) {
                    for (Object s : MiniJson.list(media.get("status"))) {
                        Map<String, Object> ms = MiniJson.obj(s);
                        Map<String, Object> m = MiniJson.obj(ms.get("media")), md = MiniJson.obj(m.get("metadata"));
                        o.append(",\"state\":").append(MiniJson.quote(MiniJson.str(ms, "playerState")));
                        o.append(",\"mediaSession\":").append((long) MiniJson.num(ms, "mediaSessionId", 0));
                        o.append(",\"title\":").append(MiniJson.quote(MiniJson.str(md, "title")));
                        o.append(",\"artist\":").append(MiniJson.quote(MiniJson.str(md, "artist")));
                        o.append(",\"album\":").append(MiniJson.quote(MiniJson.str(md, "albumName")));
                        String img = "";
                        for (Object im : MiniJson.list(md.get("images"))) { img = MiniJson.str(MiniJson.obj(im), "url"); break; }
                        o.append(",\"image\":").append(MiniJson.quote(img));
                        o.append(",\"commands\":").append((long) MiniJson.num(ms, "supportedMediaCommands", 0));
                        break;
                    }
                }
            }
        }
        return o.append("}").toString();
    }

    /** Lautstärke (0..1) oder Stumm setzen. */
    static String volume(String ip, double level, int mute) throws IOException {
        try (CastLink c = new CastLink(ip, port, 3500)) {
            c.connect("receiver-0");
            String vol = mute >= 0 ? "{\"muted\":" + (mute == 1) + "}" : "{\"level\":" + String.format(java.util.Locale.US, "%.3f", Math.max(0, Math.min(1, level))) + "}";
            Map<String, Object> st = MiniJson.obj(c.request("receiver-0", NS_RECV, "SET_VOLUME", "\"volume\":" + vol, "RECEIVER_STATUS").get("status"));
            return c.describe(st, Collections.<String, Object>emptyMap());
        }
    }

    /** Wiedergabe steuern: PLAY, PAUSE, NEXT, PREV (an die Medien-Sitzung der laufenden App). */
    static String media(String ip, String cmd) throws IOException {
        String type = cmd.equals("NEXT") ? "QUEUE_NEXT" : cmd.equals("PREV") ? "QUEUE_PREV" : cmd;
        if (!type.matches("PLAY|PAUSE|QUEUE_NEXT|QUEUE_PREV")) throw new IOException("CAST:Befehl");
        try (CastLink c = new CastLink(ip, port, 3500)) {
            Map<String, Object> st = c.receiver();
            Map<String, Object> app = null;
            for (Object a : MiniJson.list(st.get("applications"))) { app = MiniJson.obj(a); break; }
            String tr = app == null ? "" : MiniJson.str(app, "transportId");
            if (tr.isEmpty()) throw new IOException("CAST:Nichts aktiv");
            c.connect(tr);
            Map<String, Object> ms = c.request(tr, NS_MEDIA, "GET_STATUS", null, "MEDIA_STATUS");
            long sid = -1;
            for (Object s : MiniJson.list(ms.get("status"))) { sid = (long) MiniJson.num(MiniJson.obj(s), "mediaSessionId", -1); break; }
            if (sid < 0) throw new IOException("CAST:Keine Wiedergabe");
            Map<String, Object> r = c.request(tr, NS_MEDIA, type, "\"mediaSessionId\":" + sid, "MEDIA_STATUS");
            return c.describe(st, r);
        }
    }

    /** Die laufende App auf dem Lautsprecher beenden. */
    static String stop(String ip) throws IOException {
        try (CastLink c = new CastLink(ip, port, 3500)) {
            Map<String, Object> st = c.receiver();
            String sid = "";
            for (Object a : MiniJson.list(st.get("applications"))) { sid = MiniJson.str(MiniJson.obj(a), "sessionId"); break; }
            if (sid.isEmpty()) return "{\"volume\":" + MiniJson.num(MiniJson.obj(st.get("volume")), "level", -1) + "}";
            Map<String, Object> r = MiniJson.obj(c.request("receiver-0", NS_RECV, "STOP", "\"sessionId\":" + MiniJson.quote(sid), "RECEIVER_STATUS").get("status"));
            return c.describe(r, Collections.<String, Object>emptyMap());
        }
    }

    // ---- Suche im Heimnetz

    /** Die ersten drei Zahlenblöcke der WLAN-Adresse des Handys, z. B. "192.168.1" ("" wenn nicht gefunden). */
    static String localPrefix() {
        return TvScan.localPrefix();
    }

    static boolean lanIp(String ip) {
        return ip != null && ip.matches("^(10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|172\\.(1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+)$");
    }

    /** Liest den Namen über die Geräte-Info des Lautsprechers (HTTP, Port 8008); leer, wenn nicht lesbar. */
    static String httpName(String ip, int port) {
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL("http://" + ip + ":" + port + "/setup/eureka_info?params=name").openConnection();
            h.setConnectTimeout(1200); h.setReadTimeout(1500);
            if (h.getResponseCode() != 200) return "";
            try (InputStream is = h.getInputStream()) {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[2048]; int n;
                while ((n = is.read(buf)) > 0 && b.size() < 65536) b.write(buf, 0, n);
                return MiniJson.str(MiniJson.obj(MiniJson.parse(b.toString("UTF-8"))), "name");
            }
        } catch (Exception e) {
            return "";
        } finally {
            if (h != null) h.disconnect();
        }
    }

    /** Sucht Geräte mit offenem Chromecast-Port; Zeilen "ip TAB name". */
    static List<String> scan(String prefix, int port, int httpPort) throws InterruptedException {
        final List<String> found = Collections.synchronizedList(new ArrayList<String>());
        ExecutorService pool = Executors.newFixedThreadPool(48);
        for (int i = 1; i < 255; i++) {
            final String ip = prefix + "." + i;
            pool.execute(new Runnable() {
                @Override public void run() {
                    try (Socket probe = new Socket()) {
                        probe.connect(new InetSocketAddress(ip, port), 600);
                    } catch (Exception e) {
                        return;
                    }
                    String name = httpName(ip, httpPort);
                    found.add(ip + "\t" + (name.isEmpty() ? "Chromecast" : name));
                }
            });
        }
        pool.shutdown();
        pool.awaitTermination(15, TimeUnit.SECONDS);
        pool.shutdownNow();
        List<String> res = new ArrayList<String>(found);
        Collections.sort(res);
        return res;
    }
}
