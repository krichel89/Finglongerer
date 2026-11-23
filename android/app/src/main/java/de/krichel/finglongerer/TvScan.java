package de.krichel.finglongerer;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/** Sucht Google-TV-Geräte im Heimnetz: Port 6467 (Kopplung) offen und TLS-Zertifikat auslesen. */
final class TvScan {
    private TvScan() { }

    /** Die ersten drei Zahlenblöcke der WLAN-Adresse des Handys, z. B. "192.168.1" ("" wenn nicht gefunden). */
    static String localPrefix() {
        try {
            String best = "";
            for (Enumeration<NetworkInterface> e = NetworkInterface.getNetworkInterfaces(); e != null && e.hasMoreElements(); ) {
                NetworkInterface ni = e.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (Enumeration<InetAddress> a = ni.getInetAddresses(); a.hasMoreElements(); ) {
                    InetAddress ia = a.nextElement();
                    if (!(ia instanceof Inet4Address) || !ia.isSiteLocalAddress()) continue;
                    String[] o = ia.getHostAddress().split("\\.");
                    String p = o[0] + "." + o[1] + "." + o[2];
                    if (ni.getName().startsWith("wlan")) return p;
                    if (best.isEmpty()) best = p;
                }
            }
            return best;
        } catch (Exception e) {
            return "";
        }
    }

    /** Liefert Zeilen "ip TAB name TAB mac". */
    static List<String> scan(SSLSocketFactory factory, String prefix, int port) throws InterruptedException {
        final List<String> found = Collections.synchronizedList(new ArrayList<>());
        ExecutorService pool = Executors.newFixedThreadPool(48);
        for (int i = 1; i < 255; i++) {
            final String ip = prefix + "." + i;
            pool.execute(() -> {
                try (Socket probe = new Socket()) {
                    probe.connect(new InetSocketAddress(ip, port), 600);
                } catch (Exception e) {
                    return;
                }
                String name = "Google TV", mac = "";
                try (SSLSocket s = (SSLSocket) factory.createSocket()) {
                    s.connect(new InetSocketAddress(ip, port), 1500);
                    s.setSoTimeout(2500);
                    s.startHandshake();
                    String[] nm = TvRemote.nameAndMac((X509Certificate) s.getSession().getPeerCertificates()[0]);
                    name = nm[0];
                    mac = nm[1];
                } catch (Exception e) {
                    // erreichbar, aber Name unbekannt
                }
                found.add(ip + "\t" + name + "\t" + mac);
            });
        }
        pool.shutdown();
        pool.awaitTermination(15, TimeUnit.SECONDS);
        pool.shutdownNow();
        List<String> out = new ArrayList<>(found);
        Collections.sort(out);
        return out;
    }
}
