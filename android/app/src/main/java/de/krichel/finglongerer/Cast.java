package de.krichel.finglongerer;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
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
 * Chromecast-Lautsprecher (z. B. JBL Playlist) direkt steuern: Cast-Protokoll v2 über TLS, Port 8009.
 * Jede Aktion öffnet eine kurze Verbindung. JSON wird nur zum Weitergeben gelesen; die Auswertung macht die Oberfläche.
 */
final class Cast {
    private Cast() { }

    static final int PORT = 8009;
    static final String NS_CONN = "urn:x-cast:com.google.cast.tp.connection";
    static final String NS_HEART = "urn:x-cast:com.google.cast.tp.heartbeat";
    static final String NS_RECV = "urn:x-cast:com.google.cast.receiver";
    static final String NS_MEDIA = "urn:x-cast:com.google.cast.media";

    /** Adressen prefix.1-254 mit offenem Cast-Port. */
    static List<String> scan(String prefix) throws InterruptedException {
        List<String> found = Collections.synchronizedList(new ArrayList<>());
        ExecutorService pool = Executors.newFixedThreadPool(48);
        for (int i = 1; i < 255; i++) {
            final String ip = prefix + "." + i;
            pool.execute(() -> {
                try (Socket s = new Socket()) { s.connect(new InetSocketAddress(ip, PORT), 500); found.add(ip); }
                catch (IOException e) { /* zu */ }
            });
        }
        pool.shutdown();
        pool.awaitTermination(30, TimeUnit.SECONDS);
        pool.shutdownNow();
        List<String> out = new ArrayList<>(found);
        out.sort((a, b) -> Integer.compare(Integer.parseInt(a.substring(a.lastIndexOf('.') + 1)), Integer.parseInt(b.substring(b.lastIndexOf('.') + 1))));
        return out;
    }

    /** Zustand: Empfänger-Status (Lautstärke, laufende App) und, falls vorhanden, Medien-Status; durch Zeilenumbruch getrennt. */
    static String status(String ip) throws IOException {
        try (Conn c = new Conn(ip)) {
            String recv = c.request(NS_RECV, "receiver-0", "{\"type\":\"GET_STATUS\",\"requestId\":1}", "RECEIVER_STATUS");
            String tid = mediaTransport(recv);
            String media = "";
            if (!tid.isEmpty()) {
                c.connect(tid);
                try { media = c.request(NS_MEDIA, tid, "{\"type\":\"GET_STATUS\",\"requestId\":2}", "MEDIA_STATUS"); }
                catch (IOException e) { media = ""; }
            }
            return recv + "\n" + media;
        }
    }

    /** Befehle: volume (0..100), mute (0/1), play, pause, next, prev, stop. */
    static void command(String ip, String cmd, int value) throws IOException {
        try (Conn c = new Conn(ip)) {
            if (cmd.equals("volume")) {
                double v = Math.max(0, Math.min(100, value)) / 100.0;
                c.send(NS_RECV, "receiver-0", "{\"type\":\"SET_VOLUME\",\"volume\":{\"level\":" + v + "},\"requestId\":3}");
                c.await("RECEIVER_STATUS");
                return;
            }
            if (cmd.equals("mute")) {
                c.send(NS_RECV, "receiver-0", "{\"type\":\"SET_VOLUME\",\"volume\":{\"muted\":" + (value != 0) + "},\"requestId\":3}");
                c.await("RECEIVER_STATUS");
                return;
            }
            String recv = c.request(NS_RECV, "receiver-0", "{\"type\":\"GET_STATUS\",\"requestId\":1}", "RECEIVER_STATUS");
            String tid = mediaTransport(recv);
            if (tid.isEmpty()) throw new IOException("NOAPP");
            if (cmd.equals("stop")) {
                String sid = field(recv, "sessionId");
                c.send(NS_RECV, "receiver-0", "{\"type\":\"STOP\",\"sessionId\":\"" + sid + "\",\"requestId\":4}");
                c.await("RECEIVER_STATUS");
                return;
            }
            c.connect(tid);
            String media = c.request(NS_MEDIA, tid, "{\"type\":\"GET_STATUS\",\"requestId\":2}", "MEDIA_STATUS");
            Matcher m = Pattern.compile("\"mediaSessionId\"\\s*:\\s*(\\d+)").matcher(media);
            if (!m.find()) throw new IOException("NOMEDIA");
            String msid = m.group(1);
            String type;
            switch (cmd) {
                case "play": type = "PLAY"; break;
                case "pause": type = "PAUSE"; break;
                case "next": type = "QUEUE_NEXT"; break;
                case "prev": type = "QUEUE_PREV"; break;
                default: throw new IOException("Befehl unbekannt");
            }
            c.send(NS_MEDIA, tid, "{\"type\":\"" + type + "\",\"mediaSessionId\":" + msid + ",\"requestId\":5}");
            c.await("MEDIA_STATUS");
        }
    }

    /** transportId der ersten laufenden App, die Medien steuern lässt. */
    static String mediaTransport(String recv) {
        int i = recv.indexOf("\"applications\"");
        if (i < 0 || !recv.substring(i).contains(NS_MEDIA)) return "";
        return field(recv.substring(i), "transportId");
    }

    static String field(String json, String key) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"([^\"]*)\"").matcher(json);
        return m.find() ? m.group(1) : "";
    }

    /** Eine Cast-Verbindung (TLS, Rahmen = 4 Byte Länge + Protobuf CastMessage). */
    static final class Conn implements AutoCloseable {
        private final SSLSocket s;
        private final DataInputStream in;
        private final OutputStream out;

        Conn(String ip) throws IOException {
            Socket raw = new Socket();
            raw.connect(new InetSocketAddress(ip, PORT), 3000);
            raw.setSoTimeout(4000);
            try {
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(null, new TrustManager[]{new X509TrustManager() {      // Gerät im Heimnetz mit eigenem Zertifikat
                    public void checkClientTrusted(X509Certificate[] c, String a) { }
                    public void checkServerTrusted(X509Certificate[] c, String a) { }
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                }}, null);
                s = (SSLSocket) ctx.getSocketFactory().createSocket(raw, ip, PORT, true);
                s.startHandshake();
            } catch (IOException e) { raw.close(); throw e; }
            catch (Exception e) { raw.close(); throw new IOException(e); }
            in = new DataInputStream(s.getInputStream());
            out = s.getOutputStream();
            connect("receiver-0");
        }

        void connect(String dest) throws IOException { send(NS_CONN, dest, "{\"type\":\"CONNECT\"}"); }

        void send(String ns, String dest, String json) throws IOException {
            byte[] msg = message("sender-0", dest, ns, json);
            byte[] len = {(byte) (msg.length >>> 24), (byte) (msg.length >>> 16), (byte) (msg.length >>> 8), (byte) msg.length};
            synchronized (out) { out.write(len); out.write(msg); out.flush(); }
        }

        String request(String ns, String dest, String json, String expect) throws IOException {
            send(ns, dest, json);
            return await(expect);
        }

        /** Nachrichten lesen, bis eine mit "type": expect kommt (Pings werden beantwortet). */
        String await(String expect) throws IOException {
            long end = System.currentTimeMillis() + 4000;
            while (System.currentTimeMillis() < end) {
                String[] m = read();
                if (m[0].equals(NS_HEART) && m[1].contains("PING")) { send(NS_HEART, "receiver-0", "{\"type\":\"PONG\"}"); continue; }
                if (field(m[1], "type").equals(expect)) return m[1];
                if (field(m[1], "type").equals("INVALID_REQUEST") || field(m[1], "type").equals("LOAD_FAILED")) throw new IOException(m[1]);
            }
            throw new IOException("Keine Antwort");
        }

        /** {namespace, payload_utf8} */
        private String[] read() throws IOException {
            int n = in.readInt();
            if (n < 0 || n > (1 << 20)) throw new IOException("Nachricht ungültig");
            byte[] b = new byte[n];
            in.readFully(b);
            String ns = "", payload = "";
            int[] pos = {0};
            while (pos[0] < b.length) {
                long tag = varint(b, pos);
                int field = (int) (tag >>> 3), wire = (int) (tag & 7);
                if (wire == 0) varint(b, pos);
                else if (wire == 2) {
                    int len = (int) varint(b, pos);
                    if (len < 0 || pos[0] + len > b.length) throw new EOFException("abgeschnitten");
                    String v = new String(b, pos[0], len, StandardCharsets.UTF_8);
                    pos[0] += len;
                    if (field == 4) ns = v; else if (field == 6) payload = v;
                } else throw new IOException("Feldtyp " + wire);
            }
            return new String[]{ns, payload};
        }

        private static long varint(byte[] d, int[] pos) throws IOException {
            long r = 0;
            for (int shift = 0; shift < 64; shift += 7) {
                if (pos[0] >= d.length) throw new EOFException("abgeschnitten");
                int c = d[pos[0]++] & 0xFF;
                r |= (long) (c & 0x7F) << shift;
                if ((c & 0x80) == 0) return r;
            }
            throw new IOException("Zahl zu lang");
        }

        @Override public void close() { try { s.close(); } catch (IOException e) { /* egal */ } }
    }

    /** CastMessage: 1 protocol_version=0, 2 source_id, 3 destination_id, 4 namespace, 5 payload_type=0 (Text), 6 payload_utf8. */
    static byte[] message(String src, String dst, String ns, String json) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(0x08); o.write(0x00);
        str(o, 2, src); str(o, 3, dst); str(o, 4, ns);
        o.write(0x28); o.write(0x00);
        str(o, 6, json);
        return o.toByteArray();
    }

    private static void str(ByteArrayOutputStream o, int field, String v) {
        byte[] b = v.getBytes(StandardCharsets.UTF_8);
        o.write(field << 3 | 2);
        int n = b.length;
        while (n >= 0x80) { o.write((n & 0x7F) | 0x80); n >>>= 7; }
        o.write(n);
        o.write(b, 0, b.length);
    }
}
