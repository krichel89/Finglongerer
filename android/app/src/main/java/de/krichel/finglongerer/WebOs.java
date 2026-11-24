package de.krichel.finglongerer;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * LG-webOS-Geräte (Fernseher, Projektoren) im Heimnetz finden und ihre MAC-Adresse abfragen.
 * Weg: Steuerschnittstelle (WebSocket, Port 3000 bzw. 3001 verschlüsselt), Anmeldung mit Bestätigung am Gerät,
 * dann "connectionmanager/getinfo". Nachrichten wie in aiowebostv (Home Assistant).
 */
final class WebOs {
    private WebOs() { }

    static final int WS_PORT = 3000, WSS_PORT = 3001;

    /** Adressen im Netz prefix.1-254, an denen Port 3000 oder 3001 offen ist. */
    static List<String> scan(String prefix) throws InterruptedException {
        List<String> found = Collections.synchronizedList(new ArrayList<>());
        ExecutorService pool = Executors.newFixedThreadPool(48);
        for (int i = 1; i < 255; i++) {
            final String ip = prefix + "." + i;
            pool.execute(() -> { if (open(ip, WS_PORT) || open(ip, WSS_PORT)) found.add(ip); });
        }
        pool.shutdown();
        pool.awaitTermination(30, TimeUnit.SECONDS);
        pool.shutdownNow();
        List<String> out = new ArrayList<>(found);
        out.sort((a, b) -> Integer.compare(last(a), last(b)));
        return out;
    }

    private static int last(String ip) { return Integer.parseInt(ip.substring(ip.lastIndexOf('.') + 1)); }

    private static boolean open(String ip, int port) {
        try (Socket s = new Socket()) { s.connect(new InetSocketAddress(ip, port), 500); return true; }
        catch (IOException e) { return false; }
    }

    /** Status für die Anzeige, während auf die Bestätigung am Gerät gewartet wird. */
    interface Status { void set(String s); }

    /**
     * Am Gerät anmelden (es zeigt eine Abfrage, die am Gerät bestätigt werden muss, höchstens 60 s) und die MAC-Adresse lesen.
     * Antwort: MAC im WLAN, sonst die des Kabelanschlusses.
     */
    static String mac(String ip, Status status) throws IOException {
        IOException last = null;
        for (int port : new int[]{WS_PORT, WSS_PORT}) {
            try (Ws ws = Ws.open(ip, port, port == WSS_PORT)) {
                String reg = register(ws, true, status);
                if (field(reg, "type").equals("error")) reg = register(ws, false, status);     // neuere Firmware: unsigniert
                if (!field(reg, "type").equals("registered")) throw new IOException("AUTH:Am Gerät nicht bestätigt");
                ws.send("{\"type\":\"request\",\"id\":\"ci\",\"uri\":\"ssap://com.webos.service.connectionmanager/getinfo\"}");
                long end = System.currentTimeMillis() + 10000;
                while (System.currentTimeMillis() < end) {
                    String m = ws.receive();
                    if (!field(m, "id").equals("ci")) continue;
                    String mac = pick(m);
                    if (mac.isEmpty()) throw new IOException("Gerät nennt keine MAC-Adresse");
                    return mac;
                }
                throw new IOException("Keine Antwort vom Gerät");
            } catch (java.net.ConnectException e) {
                if (last == null) last = e;              // Port zu: nächsten versuchen, aussagekräftigeren Fehler behalten
            } catch (IOException e) {
                last = e;
            }
        }
        throw last != null ? last : new IOException("Keine webOS-Schnittstelle unter " + ip);
    }

    private static String register(Ws ws, boolean signed, Status status) throws IOException {
        ws.send(registration(signed));
        String r = ws.receive();
        if (field(r, "pairingType").equals("PROMPT") && !field(r, "type").equals("registered")) {
            status.set("prompt");
            ws.timeout(60000);
            try { r = ws.receive(); } finally { ws.timeout(15000); }
        }
        return r;
    }

    /** Erster Wert eines Textfelds "key":"wert" (Leerzeichen erlaubt), sonst "". */
    static String field(String json, String key) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"([^\"]*)\"").matcher(json);
        return m.find() ? m.group(1) : "";
    }

    private static final Pattern MAC = Pattern.compile("\"(wifiInfo|wiredInfo)\"\\s*:\\s*\\{[^}]*?\"macAddress\"\\s*:\\s*\"([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5})\"");

    /** MAC aus der getinfo-Antwort; WLAN vor Kabel. */
    static String pick(String json) {
        String wifi = "", wired = "";
        Matcher m = MAC.matcher(json);
        while (m.find()) {
            String v = m.group(2).toUpperCase().replace('-', ':');
            if (v.equals("00:00:00:00:00:00")) continue;
            if (m.group(1).equals("wifiInfo")) wifi = v; else wired = v;
        }
        return !wifi.isEmpty() ? wifi : wired;
    }

    private static final String PERMS = "\"LAUNCH\",\"LAUNCH_WEBAPP\",\"APP_TO_APP\",\"CLOSE\",\"TEST_OPEN\",\"TEST_PROTECTED\",\"CONTROL_AUDIO\","
            + "\"CONTROL_DISPLAY\",\"CONTROL_INPUT_JOYSTICK\",\"CONTROL_INPUT_MEDIA_RECORDING\",\"CONTROL_INPUT_MEDIA_PLAYBACK\",\"CONTROL_INPUT_TV\","
            + "\"CONTROL_POWER\",\"CONTROL_TV_SCREEN\",\"READ_APP_STATUS\",\"READ_CURRENT_CHANNEL\",\"READ_INPUT_DEVICE_LIST\",\"READ_NETWORK_STATE\","
            + "\"READ_RUNNING_APPS\",\"READ_TV_CHANNEL_LIST\",\"WRITE_NOTIFICATION_TOAST\",\"READ_POWER_STATE\",\"READ_COUNTRY_INFO\","
            + "\"CONTROL_INPUT_TEXT\",\"CONTROL_MOUSE_AND_KEYBOARD\",\"READ_INSTALLED_APPS\",\"READ_SETTINGS\"";
    private static final String SIGNED_PERMS = "\"TEST_SECURE\",\"CONTROL_INPUT_TEXT\",\"CONTROL_MOUSE_AND_KEYBOARD\",\"READ_INSTALLED_APPS\","
            + "\"READ_LGE_SDX\",\"READ_NOTIFICATIONS\",\"SEARCH\",\"WRITE_SETTINGS\",\"WRITE_NOTIFICATION_ALERT\",\"CONTROL_POWER\","
            + "\"READ_CURRENT_CHANNEL\",\"READ_RUNNING_APPS\",\"READ_UPDATE_INFO\",\"UPDATE_FROM_REMOTE_APP\",\"READ_LGE_TV_INPUT_EVENTS\",\"READ_TV_CURRENT_TIME\"";
    // Öffentliche Test-Signatur der LG-Fernbedienungs-App (aus aiowebostv)
    private static final String SIGNATURE = "eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9."
            + "hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/"
            + "g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/"
            + "ECMeIZYDh6RMqaFM2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==";

    static String registration(boolean signed) {
        String manifest = signed
                ? "{\"appVersion\":\"1.1\",\"manifestVersion\":1,\"permissions\":[" + PERMS + "],"
                    + "\"signatures\":[{\"signature\":\"" + SIGNATURE + "\",\"signatureVersion\":1}],"
                    + "\"signed\":{\"appId\":\"com.lge.test\",\"created\":\"20140509\",\"localizedAppNames\":{\"\":\"LG Remote App\"},"
                    + "\"localizedVendorNames\":{\"\":\"LG Electronics\"},\"permissions\":[" + SIGNED_PERMS + "],"
                    + "\"serial\":\"2f930e2d2cfe083771f68e4fe7bb07\",\"vendorId\":\"com.lge\"}}"
                : "{\"appVersion\":\"1.1\",\"manifestVersion\":1,\"permissions\":[" + PERMS + "," + SIGNED_PERMS + "]}";
        return "{\"type\":\"register\",\"id\":\"register_0\",\"payload\":{\"forcePairing\":false,\"pairingType\":\"PROMPT\",\"manifest\":" + manifest + "}}";
    }

    /** Kleinster nötiger WebSocket-Client (RFC 6455): Textnachrichten, Ping/Pong, Fragmente. */
    static final class Ws implements AutoCloseable {
        private final Socket s;
        private final InputStream in;
        private final OutputStream out;
        private static final SecureRandom RND = new SecureRandom();

        private Ws(Socket s) throws IOException { this.s = s; in = s.getInputStream(); out = s.getOutputStream(); }

        static Ws open(String ip, int port, boolean tls) throws IOException {
            Socket raw = new Socket();
            raw.connect(new InetSocketAddress(ip, port), 3000);
            raw.setSoTimeout(15000);
            Socket s = raw;
            if (tls) {
                try {
                    SSLContext ctx = SSLContext.getInstance("TLS");
                    ctx.init(null, new TrustManager[]{new X509TrustManager() {     // Gerät im Heimnetz mit eigenem Zertifikat
                        public void checkClientTrusted(X509Certificate[] c, String a) { }
                        public void checkServerTrusted(X509Certificate[] c, String a) { }
                        public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                    }}, null);
                    SSLSocket ss = (SSLSocket) ctx.getSocketFactory().createSocket(raw, ip, port, true);
                    ss.startHandshake();
                    s = ss;
                } catch (IOException e) { raw.close(); throw e; }
                catch (Exception e) { raw.close(); throw new IOException(e); }
            }
            Ws ws = new Ws(s);
            try { ws.handshake(ip, port); } catch (IOException e) { ws.close(); throw e; }
            return ws;
        }

        private void handshake(String host, int port) throws IOException {
            byte[] k = new byte[16]; RND.nextBytes(k);
            String req = "GET / HTTP/1.1\r\nHost: " + host + ":" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: " + b64(k) + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
            out.write(req.getBytes(StandardCharsets.US_ASCII)); out.flush();
            ByteArrayOutputStream head = new ByteArrayOutputStream();
            int state = 0;
            while (state < 4) {
                int b = in.read();
                if (b < 0) throw new EOFException("Verbindung geschlossen");
                head.write(b);
                if (head.size() > 8192) throw new IOException("Antwort zu lang");
                state = (b == '\r' && (state == 0 || state == 2)) ? state + 1 : (b == '\n' && (state == 1 || state == 3)) ? state + 1 : 0;
            }
            String h = head.toString("US-ASCII");
            if (!h.startsWith("HTTP/1.1 101")) throw new IOException("Kein WebSocket: " + h.split("\r\n")[0]);
        }

        private static String b64(byte[] d) {     // java.util.Base64 erst ab Android 8
            String a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < d.length; i += 3) {
                int n = (d[i] & 0xFF) << 16 | (i + 1 < d.length ? (d[i + 1] & 0xFF) << 8 : 0) | (i + 2 < d.length ? d[i + 2] & 0xFF : 0);
                sb.append(a.charAt(n >> 18 & 63)).append(a.charAt(n >> 12 & 63))
                  .append(i + 1 < d.length ? a.charAt(n >> 6 & 63) : '=').append(i + 2 < d.length ? a.charAt(n & 63) : '=');
            }
            return sb.toString();
        }

        void timeout(int ms) throws IOException { s.setSoTimeout(ms); }

        void send(String text) throws IOException { frame(0x1, text.getBytes(StandardCharsets.UTF_8)); }

        private synchronized void frame(int op, byte[] p) throws IOException {
            ByteArrayOutputStream f = new ByteArrayOutputStream(p.length + 14);
            f.write(0x80 | op);
            if (p.length < 126) f.write(0x80 | p.length);
            else if (p.length < 65536) { f.write(0x80 | 126); f.write(p.length >>> 8); f.write(p.length & 0xFF); }
            else { f.write(0x80 | 127); for (int i = 7; i >= 0; i--) f.write(i > 3 ? 0 : (p.length >>> (8 * i)) & 0xFF); }
            byte[] m = new byte[4]; RND.nextBytes(m);
            f.write(m, 0, 4);
            for (int i = 0; i < p.length; i++) f.write(p[i] ^ m[i & 3]);
            out.write(f.toByteArray()); out.flush();
        }

        /** Nächste Textnachricht (Pings werden beantwortet). */
        String receive() throws IOException {
            ByteArrayOutputStream msg = new ByteArrayOutputStream();
            while (true) {
                int b0 = read(), b1 = read();
                int op = b0 & 0x0F;
                long len = b1 & 0x7F;
                if (len == 126) len = (read() << 8) | read();
                else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | read(); }
                if (len > (1 << 20) || msg.size() + len > (1 << 20)) throw new IOException("Nachricht zu groß");
                byte[] mask = null;
                if ((b1 & 0x80) != 0) { mask = new byte[4]; for (int i = 0; i < 4; i++) mask[i] = (byte) read(); }
                byte[] p = new byte[(int) len];
                for (int i = 0; i < len; ) { int n = in.read(p, i, (int) len - i); if (n < 0) throw new EOFException("Verbindung geschlossen"); i += n; }
                if (mask != null) for (int i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
                if (op == 0x8) throw new EOFException("Gerät hat die Verbindung beendet");
                if (op == 0x9) { frame(0xA, p); continue; }
                if (op == 0xA) continue;
                msg.write(p, 0, p.length);
                if ((b0 & 0x80) != 0) return msg.toString("UTF-8");
            }
        }

        private int read() throws IOException { int b = in.read(); if (b < 0) throw new EOFException("Verbindung geschlossen"); return b; }

        @Override public void close() { try { s.close(); } catch (IOException e) { /* egal */ } }
    }
}
