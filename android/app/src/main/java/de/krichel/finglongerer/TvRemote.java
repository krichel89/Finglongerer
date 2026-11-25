package de.krichel.finglongerer;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.interfaces.RSAPublicKey;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Fernbedienung für Google TV / Android TV über das Android-TV-Fernbedienungsprotokoll (v2), wie es auch die Google-TV-App
 * auf dem Handy benutzt. Port 6467: einmalige Kopplung per 6-stelligem Code, Port 6466: Tasten und App-Start.
 * Nachrichten sind Protobuf mit vorangestellter Länge; sie werden hier von Hand kodiert (keine Bibliothek nötig).
 * Reines Java (ohne Android-Klassen), damit es sich am Rechner testen lässt.
 */
final class TvRemote {
    // Funktionen, die wir beim Fernseher anmelden: Ping, Tasten, Ein/Aus, Lautstärke, App-Links
    static final int FEATURES = 1 | 2 | 4 | 8 | 32 | 64 | 512;   // 4 = IME (Texteingabe), 8 = Sprache
    static final int DIRECTION_SHORT = 3;

    private final SSLSocketFactory factory;
    private final RSAPublicKey clientKey;
    private final int pairPort, remotePort;

    private SSLSocket pairSocket;
    private RSAPublicKey pairServerKey;
    private String pairName = "", pairMac = "";
    private Conn conn;
    private String connIp;

    TvRemote(SSLSocketFactory factory, RSAPublicKey clientKey, int pairPort, int remotePort) {
        this.factory = factory;
        this.clientKey = clientKey;
        this.pairPort = pairPort;
        this.remotePort = remotePort;
    }

    // ---- Protobuf von Hand

    static final class W {
        private final ByteArrayOutputStream o = new ByteArrayOutputStream();
        W v(int field, long x) { varint(((long) field << 3)); varint(x); return this; }
        W s(int field, String x) { return b(field, x.getBytes(StandardCharsets.UTF_8)); }
        W b(int field, byte[] x) { varint(((long) field << 3) | 2); varint(x.length); o.write(x, 0, x.length); return this; }
        W m(int field, W sub) { return b(field, sub.bytes()); }
        byte[] bytes() { return o.toByteArray(); }
        void varint(long x) {
            while ((x & ~0x7FL) != 0) { o.write((int) ((x & 0x7F) | 0x80)); x >>>= 7; }
            o.write((int) x);
        }
    }

    /** Oberste Ebene einer Nachricht: Zahlenfelder und verschachtelte/Byte-Felder nach Feldnummer. */
    static final class P {
        final Map<Integer, Long> ints = new HashMap<>();
        final Map<Integer, byte[]> bytes = new HashMap<>();
        static P parse(byte[] d) throws IOException {
            P p = new P();
            int[] pos = {0};
            while (pos[0] < d.length) {
                long tag = readVarint(d, pos);
                int field = (int) (tag >>> 3), wire = (int) (tag & 7);
                if (wire == 0) p.ints.put(field, readVarint(d, pos));
                else if (wire == 2) {
                    long n = readVarint(d, pos);
                    if (n < 0 || pos[0] + n > d.length) throw new IOException("Nachricht abgeschnitten");
                    byte[] b = new byte[(int) n];
                    System.arraycopy(d, pos[0], b, 0, (int) n);
                    pos[0] += (int) n;
                    p.bytes.put(field, b);
                } else if (wire == 1) pos[0] += 8;
                else if (wire == 5) pos[0] += 4;
                else throw new IOException("Unbekannter Feldtyp " + wire);
            }
            return p;
        }
        private static long readVarint(byte[] d, int[] pos) throws IOException {
            long r = 0;
            for (int shift = 0; shift < 64; shift += 7) {
                if (pos[0] >= d.length) throw new IOException("Nachricht abgeschnitten");
                int b = d[pos[0]++] & 0xFF;
                r |= (long) (b & 0x7F) << shift;
                if ((b & 0x80) == 0) return r;
            }
            throw new IOException("Zahl zu lang");
        }
    }

    static void writeFrame(OutputStream out, byte[] msg) throws IOException {
        W w = new W();
        w.varint(msg.length);
        synchronized (out) {
            out.write(w.bytes());
            out.write(msg);
            out.flush();
        }
    }

    static byte[] readFrame(InputStream in) throws IOException {
        long len = 0;
        for (int shift = 0; ; shift += 7) {
            int b = in.read();
            if (b < 0) throw new EOFException("Verbindung geschlossen");
            len |= (long) (b & 0x7F) << shift;
            if ((b & 0x80) == 0) break;
            if (shift > 28) throw new IOException("Länge ungültig");
        }
        if (len > (1 << 20)) throw new IOException("Nachricht zu groß");
        byte[] buf = new byte[(int) len];
        new DataInputStream(in).readFully(buf);
        return buf;
    }

    // ---- Kopplung (Port 6467)

    static byte[] outer(int field, W body) {
        return new W().v(1, 2).v(2, 200).m(field, body).bytes();
    }

    static byte[] pairingRequest(String clientName) {
        return outer(10, new W().s(1, "atvremote").s(2, clientName));
    }

    static byte[] pairingOptions() {
        // input_encodings: HEXADECIMAL (3), 6 Zeichen; bevorzugte Rolle INPUT (1)
        return outer(20, new W().m(1, new W().v(1, 3).v(2, 6)).v(3, 1));
    }

    static byte[] pairingConfiguration() {
        return outer(30, new W().m(1, new W().v(1, 3).v(2, 6)).v(2, 1));
    }

    static byte[] pairingSecret(byte[] secret) {
        return outer(40, new W().b(1, secret));
    }

    /** Liest eine Kopplungsnachricht und prüft den Status (200 = ok). */
    private static P readPolo(InputStream in) throws IOException {
        P p = P.parse(readFrame(in));
        Long st = p.ints.get(2);
        if (st == null || st != 200) throw new IOException("AUTH:Kopplung abgelehnt (Status " + st + ")");
        return p;
    }

    private SSLSocket open(String ip, int port, int timeoutMs) throws IOException {
        SSLSocket s = (SSLSocket) factory.createSocket();
        try {
            s.connect(new InetSocketAddress(ip, port), timeoutMs);
            s.setSoTimeout(timeoutMs);
            s.startHandshake();
            return s;
        } catch (IOException e) {
            try { s.close(); } catch (IOException x) { /* egal */ }
            throw e;
        }
    }

    /** Schritt 1: Verbindung zum Fernseher aufbauen; er zeigt danach den Code an. */
    synchronized void pairStart(String ip, String clientName) throws IOException {
        pairClose();
        SSLSocket s = open(ip, pairPort, 8000);
        try {
            java.security.cert.X509Certificate sc = (java.security.cert.X509Certificate) s.getSession().getPeerCertificates()[0];
            pairServerKey = (RSAPublicKey) sc.getPublicKey();
            String[] nm = nameAndMac(sc);
            pairName = nm[0];
            pairMac = nm[1];
            InputStream in = s.getInputStream();
            OutputStream out = s.getOutputStream();
            writeFrame(out, pairingRequest(clientName));
            for (int step = 0; step < 6; step++) {
                P p = readPolo(in);
                if (p.bytes.containsKey(11)) writeFrame(out, pairingOptions());
                else if (p.bytes.containsKey(20)) writeFrame(out, pairingConfiguration());
                else if (p.bytes.containsKey(31)) { pairSocket = s; return; }
                else throw new IOException("Unerwartete Antwort bei der Kopplung");
            }
            throw new IOException("Kopplung kam nicht zustande");
        } catch (Exception e) {
            try { s.close(); } catch (IOException x) { /* egal */ }
            pairServerKey = null;
            if (e instanceof IOException) throw (IOException) e;
            throw new IOException(e.getMessage(), e);
        }
    }

    /** Name und MAC-Adresse stehen im Zertifikat des Fernsehers, z. B. CN=atvremote/Name/AA:BB:CC:DD:EE:FF. */
    static String[] nameAndMac(java.security.cert.X509Certificate c) {
        String dn = c.getSubjectX500Principal().getName(javax.security.auth.x500.X500Principal.RFC2253);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?i)([0-9a-f]{2}(?::[0-9a-f]{2}){5})").matcher(dn);
        String mac = m.find() ? m.group(1).toUpperCase(java.util.Locale.ROOT) : "";
        String cn = "";
        java.util.regex.Matcher n = java.util.regex.Pattern.compile("(?:^|,)CN=([^,]*)").matcher(dn);
        if (n.find()) cn = n.group(1);
        String[] parts = cn.split("/");
        String name = parts.length > 1 ? parts[parts.length - 2] : cn;
        if (name.equals("atvremote") || name.isEmpty()) name = parts.length > 2 ? parts[1] : "Google TV";
        return new String[]{name.replaceAll("[\\t\\r\\n]", " "), mac};
    }

    synchronized String lastName() { return pairName; }
    synchronized String lastMac() { return pairMac; }

    /** Weckpaket (Wake-on-LAN) an alle im Heimnetz; weckt nur Geräte, die das im Standby unterstützen. */
    static void wakeOnLan(String mac) throws IOException {
        if (mac == null || !mac.matches("^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")) throw new IOException("MAC ungültig");
        byte[] m = hex(mac.replaceAll("[:-]", ""));
        byte[] pkt = new byte[6 + 16 * 6];
        for (int i = 0; i < 6; i++) pkt[i] = (byte) 0xFF;
        for (int i = 0; i < 16; i++) System.arraycopy(m, 0, pkt, 6 + i * 6, 6);
        try (java.net.DatagramSocket ds = new java.net.DatagramSocket()) {
            ds.setBroadcast(true);
            java.util.List<String> targets = new java.util.ArrayList<>();
            targets.add("255.255.255.255");
            String pre = TvScan.localPrefix();
            if (!pre.isEmpty()) targets.add(pre + ".255");
            for (String t : targets)
                for (int port : new int[]{9, 7})
                    ds.send(new java.net.DatagramPacket(pkt, pkt.length, java.net.InetAddress.getByName(t), port));
        }
    }

    private static byte[] unsigned(BigInteger n) {
        byte[] b = n.toByteArray();
        if (b.length > 1 && b[0] == 0) { byte[] c = new byte[b.length - 1]; System.arraycopy(b, 1, c, 0, c.length); return c; }
        return b;
    }

    /** Das Geheimnis aus beiden Schlüsseln und dem Code (ohne die ersten zwei Zeichen); dessen erstes Byte ist die Prüfziffer des Codes. */
    static byte[] secret(RSAPublicKey client, RSAPublicKey server, byte[] codeTail) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(unsigned(client.getModulus()));
            md.update(unsigned(client.getPublicExponent()));
            md.update(unsigned(server.getModulus()));
            md.update(unsigned(server.getPublicExponent()));
            md.update(codeTail);
            return md.digest();
        } catch (java.security.NoSuchAlgorithmException e) { throw new IOException(e); }
    }

    static byte[] hex(String s) {
        byte[] r = new byte[s.length() / 2];
        for (int i = 0; i < r.length; i++) r[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return r;
    }

    /** Schritt 2: den auf dem Fernseher angezeigten Code (6 Zeichen, 0-9 a-f) bestätigen. */
    synchronized void pairFinish(String code) throws IOException {
        if (code == null || !code.matches("^[0-9a-fA-F]{6}$")) throw new IOException("CODE:Code muss aus 6 Zeichen (0-9, a-f) bestehen");
        if (pairSocket == null || pairServerKey == null) throw new IOException("CODE:Erst „Koppeln“ drücken");
        try {
            byte[] h = secret(clientKey, pairServerKey, hex(code.substring(2)));
            if ((h[0] & 0xFF) != Integer.parseInt(code.substring(0, 2), 16)) throw new IOException("CODE:Code falsch");
            writeFrame(pairSocket.getOutputStream(), pairingSecret(h));
            P p;
            try { p = readPolo(pairSocket.getInputStream()); }
            catch (IOException e) { throw new IOException("CODE:Code vom Fernseher abgelehnt"); }
            if (!p.bytes.containsKey(41)) throw new IOException("CODE:Unerwartete Antwort");
        } finally {
            pairClose();
        }
    }

    private void pairClose() {
        if (pairSocket != null) { try { pairSocket.close(); } catch (IOException e) { /* egal */ } }
        pairSocket = null;
        pairServerKey = null;
    }

    // ---- Fernbedienung (Port 6466)

    static byte[] keyInject(int code, int direction) {
        return new W().m(10, new W().v(1, code).v(2, direction)).bytes();
    }

    /** Text in das Eingabefeld des Fernsehers einfügen (remote_ime_batch_edit); Zähler stammen vom Fernseher. */
    static byte[] textEdit(int imeCounter, int fieldCounter, String text) {
        int n = text.length();
        W obj = new W().v(1, n).v(2, n).s(3, text);
        W info = new W().v(1, 1).m(2, obj);
        return new W().m(21, new W().v(1, imeCounter).v(2, fieldCounter).m(3, info)).bytes();
    }

    static byte[] appLink(String link) {
        return new W().m(90, new W().s(1, link)).bytes();
    }

    static byte[] configureReply(int features) {
        // device_info: unknown1=1, unknown2="1", package_name, app_version
        return new W().m(1, new W().v(1, features).m(2, new W().v(3, 1).s(4, "1").s(5, "atvremote").s(6, "1.0.0"))).bytes();
    }

    static byte[] setActive(int features) {
        return new W().m(2, new W().v(1, features)).bytes();
    }

    static byte[] pong(long val) {
        W w = new W();
        if (val != 0) w.v(1, val);
        return new W().m(9, w).bytes();
    }

    private static final class Conn {
        final SSLSocket socket;
        final OutputStream out;
        final CountDownLatch ready = new CountDownLatch(1);
        volatile boolean closed;
        final java.util.Set<Integer> seen = java.util.Collections.synchronizedSet(new java.util.TreeSet<Integer>());   // Nummern der Meldungen des Fernsehers (Diagnose)
        volatile int started = -1;      // remote_start: 1 = Fernseher an, 0 = Standby, -1 = noch unbekannt
        volatile String error = "";
        volatile int voiceBegin = -1;                  // Sitzungsnummer, wenn der Fernseher die Sprachsuche öffnet
        volatile int imeCounter, imeFieldCounter;      // vom Fernseher gemeldet, für Texteingabe

        Conn(SSLSocket s) throws IOException {
            socket = s;
            out = s.getOutputStream();
            InputStream in = s.getInputStream();
            Thread t = new Thread(() -> {
                try {
                    s.setSoTimeout(0);
                    while (!closed) {
                        P p = P.parse(readFrame(in));
                        seen.addAll(p.bytes.keySet()); seen.addAll(p.ints.keySet());
                        if (p.bytes.containsKey(1)) {                       // remote_configure: unsere Funktionen melden
                            P cfg = P.parse(p.bytes.get(1));
                            Long code1 = cfg.ints.get(1);
                            int features = code1 == null ? FEATURES : (int) (code1 & FEATURES);
                            writeFrame(out, configureReply(features));
                        } else if (p.bytes.containsKey(2)) {                // remote_set_active
                            writeFrame(out, setActive(FEATURES));
                            ready.countDown();
                        } else if (p.bytes.containsKey(8)) {                // Ping -> Pong
                            P ping = P.parse(p.bytes.get(8));
                            Long v = ping.ints.get(1);
                            writeFrame(out, pong(v == null ? 0 : v));
                        } else if (p.bytes.containsKey(40)) {               // remote_start: bereit, meldet auch ob der Fernseher an ist
                            Long st = P.parse(p.bytes.get(40)).ints.get(1);
                            started = st != null && st != 0 ? 1 : 0;
                            ready.countDown();
                        } else if (p.bytes.containsKey(20)) {               // remote_ime_key_inject: Eingabefeld hat Fokus
                            P inj = P.parse(p.bytes.get(20));
                            if (inj.bytes.containsKey(1)) { Long v = P.parse(inj.bytes.get(1)).ints.get(1); imeCounter = v == null ? 0 : (int) (long) v; }
                            if (inj.bytes.containsKey(2)) { Long v = P.parse(inj.bytes.get(2)).ints.get(1); imeFieldCounter = v == null ? 0 : (int) (long) v; }
                        } else if (p.bytes.containsKey(22)) {               // remote_ime_show_request
                            P req = P.parse(p.bytes.get(22));
                            if (req.bytes.containsKey(2)) { Long v = P.parse(req.bytes.get(2)).ints.get(1); if (v != null) imeFieldCounter = (int) (long) v; }
                        } else if (p.bytes.containsKey(21)) {               // remote_ime_batch_edit: Zähler übernehmen, falls noch unbekannt
                            P be = P.parse(p.bytes.get(21));
                            if (be.ints.get(1) != null) imeCounter = (int) (long) be.ints.get(1);
                            if (be.ints.get(2) != null) imeFieldCounter = (int) (long) be.ints.get(2);
                        } else if (p.bytes.containsKey(30)) {               // remote_voice_begin
                            Long id = P.parse(p.bytes.get(30)).ints.get(1);
                            voiceBegin = id == null ? 0 : (int) (long) id;
                        } else if (p.bytes.containsKey(3)) {
                            error = "Fernseher meldet Fehler";
                        }
                    }
                } catch (Exception e) {
                    error = String.valueOf(e.getMessage());
                } finally {
                    closed = true;
                    ready.countDown();
                    try { s.close(); } catch (IOException x) { /* egal */ }
                }
            }, "tv-remote");
            t.setDaemon(true);
            t.start();
        }

        void send(byte[] msg) throws IOException {
            if (closed) throw new IOException("Verbindung geschlossen");
            writeFrame(out, msg);
        }

        void close() {
            closed = true;
            try { socket.close(); } catch (IOException e) { /* egal */ }
        }
    }

    private Conn ensure(String ip) throws IOException {
        if (conn != null && !conn.closed && ip.equals(connIp)) return conn;
        disconnect();
        Conn c = new Conn(open(ip, remotePort, 4000));
        try {
            if (!c.ready.await(6, TimeUnit.SECONDS) || c.closed) {
                c.close();
                throw new IOException("AUTH:Fernseher antwortet nicht - neu koppeln? " + c.error);
            }
        } catch (InterruptedException e) {
            c.close();
            Thread.currentThread().interrupt();
            throw new IOException("Unterbrochen");
        }
        conn = c;
        connIp = ip;
        return c;
    }

    /** Verbindung herstellen (und prüfen, dass die Kopplung gilt). */
    synchronized void connect(String ip) throws IOException {
        ensure(ip);
    }

    private synchronized void sendTo(String ip, byte[] msg) throws IOException {
        Conn c = ensure(ip);
        try {
            c.send(msg);
        } catch (IOException e) {            // Verbindung war veraltet: einmal neu aufbauen
            disconnect();
            ensure(ip).send(msg);
        }
    }

    /** Ein oder Aus ohne Umschalten: nur wenn der Zustand nicht schon stimmt, wird die Power-Taste gedrückt. */
    synchronized void power(String ip, boolean on) throws IOException {
        Conn c = ensure(ip);
        long end = System.currentTimeMillis() + 1500;
        while (c.started < 0 && !c.closed && System.currentTimeMillis() < end) {
            try { Thread.sleep(50); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
        }
        int st = c.started;
        if (on) {
            sendTo(ip, keyInject(224, DIRECTION_SHORT));                       // WAKEUP: weckt Stick und (per HDMI-CEC) den Fernseher
            if (st == 0) { try { Thread.sleep(2000); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } sendTo(ip, keyInject(26, DIRECTION_SHORT)); }
        } else if (st != 0) sendTo(ip, keyInject(26, DIRECTION_SHORT));
    }

    void key(String ip, int code) throws IOException {
        sendTo(ip, keyInject(code, DIRECTION_SHORT));
    }

    /** Wurde schon ein Eingabefeld gemeldet? Sonst neu verbinden und bis zu 1,5 s auf die Meldung warten. Antwort "ok" oder "nofield:<Meldungsnummern>". */
    synchronized String probeField(String ip) throws IOException {
        Conn c = ensure(ip);
        if (c.imeCounter != 0 || c.imeFieldCounter != 0) return "ok";
        disconnect();
        c = ensure(ip);
        long end = System.currentTimeMillis() + 1500;
        while (c.imeCounter == 0 && c.imeFieldCounter == 0 && !c.closed && System.currentTimeMillis() < end) {
            try { Thread.sleep(50); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
        }
        return c.imeCounter != 0 || c.imeFieldCounter != 0 ? "ok" : "nofield:" + c.seen;
    }

    /** Inhalt des Eingabefelds auf dem Fernseher setzen. false = der Fernseher hat (noch) kein Eingabefeld gemeldet, nichts gesendet. */
    synchronized boolean text(String ip, String text) throws IOException {
        Conn c = ensure(ip);
        if (c.imeCounter == 0 && c.imeFieldCounter == 0 && !c.seen.contains(20)) return false;   // der Fernseher kennt keine Texteingabe
        sendTo(ip, textEdit(c.imeCounter, c.imeFieldCounter, text == null ? "" : text));
        return true;
    }

    void keyDir(String ip, int code, int direction) throws IOException {
        sendTo(ip, keyInject(code, direction));
    }

    /** Sprachsuche öffnen (Such-Taste) und auf die Sitzungsnummer des Fernsehers warten; Antwort mit derselben Nummer. */
    int voiceStart(String ip) throws IOException {
        Conn c;
        synchronized (this) {
            c = ensure(ip);
            c.voiceBegin = -1;
            sendTo(ip, keyInject(84, DIRECTION_SHORT));
        }
        long end = System.currentTimeMillis() + 3000;
        while (c.voiceBegin < 0 && !c.closed && System.currentTimeMillis() < end) {
            try { Thread.sleep(50); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
        }
        if (c.voiceBegin < 0) throw new IOException("Der Fernseher öffnet keine Sprachsuche");
        int id = c.voiceBegin;
        sendTo(ip, new W().m(30, new W().v(1, id)).bytes());
        return id;
    }

    /** Ton (16 Bit, mono, 8000 Hz) senden: Stücke zu höchstens 20 KB, kürzere werden auf 8 KB aufgefüllt. */
    void voiceChunk(String ip, int id, byte[] pcm, int len) throws IOException {
        for (int i = 0; i < len; i += 20 * 1024) {
            int n = Math.min(20 * 1024, len - i);
            byte[] part = new byte[Math.max(n, 8 * 1024)];
            System.arraycopy(pcm, i, part, 0, n);
            sendTo(ip, new W().m(31, new W().v(1, id).b(2, part)).bytes());
        }
    }

    void voiceEnd(String ip, int id) throws IOException {
        sendTo(ip, new W().m(32, new W().v(1, id)).bytes());
    }

    void launch(String ip, String link) throws IOException {
        sendTo(ip, appLink(link));
    }

    synchronized void disconnect() {
        if (conn != null) conn.close();
        conn = null;
        connIp = null;
    }
}
