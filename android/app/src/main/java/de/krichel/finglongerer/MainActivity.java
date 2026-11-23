package de.krichel.finglongerer;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.JavascriptInterface;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private String shared;

    /** Brücke zur Web-Oberfläche: window.STShare.take() liefert den zuletzt geteilten Text (einmalig). */
    public class ShareBridge {
        @JavascriptInterface
        public String take() {
            String t = shared;
            shared = null;
            return t == null ? "" : t;
        }
    }

    /** Brücke für den Box-Neustart: schickt eine Textzeile an die Diagnose-Shell der Box (Port 17000) und meldet "ok" oder "ERR: ...". Nur Adressen des Heimnetzes. */
    public class TcpBridge {
        @JavascriptInterface
        public String send(String ip, int port, String line, int timeoutMs) {
            if (ip == null || !ip.matches("^(10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|172\\.(1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+)$")) return "ERR: keine Heimnetz-Adresse";
            if (port != 17000 || line == null || !line.matches("^sys reboot$")) return "ERR: Befehl nicht erlaubt";
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress(ip, port), Math.max(500, Math.min(timeoutMs, 8000)));
                OutputStream o = s.getOutputStream();
                o.write((line + "\n").getBytes(StandardCharsets.UTF_8));
                o.flush();
                return "ok";
            } catch (Exception e) {
                return "ERR: " + e.getMessage();
            }
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getBridge().getWebView().addJavascriptInterface(new ShareBridge(), "STShare");
        getBridge().getWebView().addJavascriptInterface(new TcpBridge(), "STTcp");
        remember(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        remember(intent);
    }

    private void remember(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text != null && text.length() > 0 && text.length() < 4000) shared = text;
    }
}
