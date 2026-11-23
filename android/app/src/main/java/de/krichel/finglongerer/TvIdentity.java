package de.krichel.finglongerer;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Die "Handy-Identität" für die Kopplung mit dem Google TV: ein selbst signiertes RSA-Zertifikat, das beim ersten Start
 * erzeugt und im privaten App-Ordner abgelegt wird. Der Fernseher merkt sich dieses Zertifikat bei der Kopplung.
 * Reines Java (ohne Android-Klassen), damit es sich am Rechner testen lässt.
 */
final class TvIdentity {
    final RSAPublicKey publicKey;
    final SSLSocketFactory factory;

    private TvIdentity(PrivateKey key, X509Certificate cert) throws Exception {
        this.publicKey = (RSAPublicKey) cert.getPublicKey();
        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(null, null);
        char[] pw = "tv".toCharArray();
        ks.setKeyEntry("client", key, pw, new java.security.cert.Certificate[]{cert});
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(ks, pw);
        // Der Fernseher hat ein selbst signiertes Zertifikat und wird nur im Heimnetz angesprochen (siehe TvBridge): keine Prüfung der Gegenstelle
        TrustManager trustAll = new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] c, String a) { }
            @Override public void checkServerTrusted(X509Certificate[] c, String a) { }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(kmf.getKeyManagers(), new TrustManager[]{trustAll}, new SecureRandom());
        this.factory = ctx.getSocketFactory();
    }

    /** Lädt die Identität aus dem Ordner oder legt sie dort neu an. */
    static TvIdentity load(File dir) throws Exception {
        File kf = new File(dir, "tv-client.key"), cf = new File(dir, "tv-client.crt");
        if (kf.isFile() && cf.isFile()) {
            try {
                PrivateKey key = KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(readAll(kf)));
                X509Certificate cert = (X509Certificate) CertificateFactory.getInstance("X.509")
                        .generateCertificate(new java.io.ByteArrayInputStream(readAll(cf)));
                return new TvIdentity(key, cert);
            } catch (Exception e) {
                // defekte Dateien: neu erzeugen (der Fernseher muss dann neu gekoppelt werden)
            }
        }
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        KeyPair kp = g.generateKeyPair();
        byte[] der = selfSigned(kp);
        X509Certificate cert = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new java.io.ByteArrayInputStream(der));
        writeAll(kf, kp.getPrivate().getEncoded());
        writeAll(cf, der);
        return new TvIdentity(kp.getPrivate(), cert);
    }

    /** Löscht die Identität (danach muss neu gekoppelt werden). */
    static void delete(File dir) {
        new File(dir, "tv-client.key").delete();
        new File(dir, "tv-client.crt").delete();
    }

    // ---- selbst signiertes Zertifikat (X.509 v3, RSA 2048, SHA-256), von Hand als DER aufgebaut

    private static final byte[] OID_SHA256_RSA = {0x06, 0x09, 0x2A, (byte) 0x86, 0x48, (byte) 0x86, (byte) 0xF7, 0x0D, 0x01, 0x01, 0x0B};
    private static final byte[] OID_CN = {0x06, 0x03, 0x55, 0x04, 0x03};
    private static final byte[] OID_BASIC_CONSTRAINTS = {0x06, 0x03, 0x55, 0x1D, 0x13};

    static byte[] selfSigned(KeyPair kp) throws Exception {
        byte[] sigAlg = tlv(0x30, cat(OID_SHA256_RSA, new byte[]{0x05, 0x00}));
        byte[] name = tlv(0x30, tlv(0x31, tlv(0x30, cat(OID_CN, tlv(0x0C, "finglongerer".getBytes("UTF-8"))))));
        long now = System.currentTimeMillis();
        byte[] validity = tlv(0x30, cat(utc(now - 86400000L), utc(now + 10L * 365 * 86400000L)));
        byte[] serial = tlv(0x02, new BigInteger(63, new SecureRandom()).add(BigInteger.ONE).toByteArray());
        byte[] ext = tlv(0xA3, tlv(0x30, tlv(0x30, cat(OID_BASIC_CONSTRAINTS,
                tlv(0x04, tlv(0x30, cat(tlv(0x01, new byte[]{(byte) 0xFF}), tlv(0x02, new byte[]{0x00}))))))));
        byte[] tbs = tlv(0x30, cat(tlv(0xA0, tlv(0x02, new byte[]{0x02})), serial, sigAlg, name, validity, name,
                kp.getPublic().getEncoded(), ext));
        Signature s = Signature.getInstance("SHA256withRSA");
        s.initSign(kp.getPrivate());
        s.update(tbs);
        return tlv(0x30, cat(tbs, sigAlg, tlv(0x03, cat(new byte[]{0x00}, s.sign()))));
    }

    private static byte[] utc(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyMMddHHmmss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        try { return tlv(0x17, f.format(new Date(ms)).getBytes("US-ASCII")); } catch (IOException e) { throw new IllegalStateException(e); }
    }

    private static byte[] tlv(int tag, byte[] v) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(tag);
        int n = v.length;
        if (n < 128) o.write(n);
        else if (n < 256) { o.write(0x81); o.write(n); }
        else { o.write(0x82); o.write(n >> 8); o.write(n & 0xFF); }
        o.write(v, 0, n);
        return o.toByteArray();
    }

    private static byte[] cat(byte[]... parts) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (byte[] p : parts) o.write(p, 0, p.length);
        return o.toByteArray();
    }

    private static byte[] readAll(File f) throws IOException {
        try (DataInputStream in = new DataInputStream(new FileInputStream(f))) {
            byte[] b = new byte[(int) f.length()];
            in.readFully(b);
            return b;
        }
    }

    private static void writeAll(File f, byte[] b) throws IOException {
        try (FileOutputStream o = new FileOutputStream(f)) { o.write(b); }
    }
}
