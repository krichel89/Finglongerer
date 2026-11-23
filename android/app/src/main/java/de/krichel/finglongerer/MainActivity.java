package de.krichel.finglongerer;

import android.app.UiModeManager;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.Bundle;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

import androidx.activity.OnBackPressedCallback;

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

    /** Meldet der Oberfläche, ob die App auf einem Fernseher (Google TV / Android TV) läuft: window.STDevice.isTv(). */
    public class DeviceBridge {
        @JavascriptInterface
        public boolean isTv() {
            UiModeManager m = (UiModeManager) getSystemService(UI_MODE_SERVICE);
            return m != null && m.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
        }

        /** Öffnet die Bildschirmtastatur (auf dem Fernseher auch für die Handy-Tastatur der Google-TV-App nötig). */
        @JavascriptInterface
        public void showKeyboard() {
            runOnUiThread(() -> {
                InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                if (imm != null) imm.showSoftInput(getBridge().getWebView(), InputMethodManager.SHOW_IMPLICIT);
            });
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getBridge().getWebView().addJavascriptInterface(new ShareBridge(), "STShare");
        getBridge().getWebView().addJavascriptInterface(new TcpBridge(), "STTcp");
        getBridge().getWebView().addJavascriptInterface(new DeviceBridge(), "STDevice");
        remember(getIntent());
        // Zurück schließt zuerst Unterfenster (Einstellungen, aufgeklappte Bereiche); erst ohne offenes Fenster verlässt es die App
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                getBridge().getWebView().evaluateJavascript("window.STBack ? window.STBack() : false", v -> {
                    if (!"true".equals(v)) {
                        setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                    }
                });
            }
        });
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
