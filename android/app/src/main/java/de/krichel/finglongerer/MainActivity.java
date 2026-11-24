package de.krichel.finglongerer;

import android.app.UiModeManager;
import android.content.Intent;
import android.content.res.Configuration;
import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

import androidx.activity.OnBackPressedCallback;
import androidx.coordinatorlayout.widget.CoordinatorLayout;

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

    /** Brücke zum Google TV (Android-TV-Fernbedienungsprotokoll): koppeln, Tasten senden, Apps starten. Antwort "ok" oder "ERR:art[:text]". Nur Adressen des Heimnetzes. */
    public class TvBridge {
        private TvRemote remote;

        private synchronized TvRemote remote() throws Exception {
            if (remote == null) {
                TvIdentity id = TvIdentity.load(getFilesDir());
                remote = new TvRemote(id.factory, id.publicKey, 6467, 6466);
            }
            return remote;
        }

        private String fail(Exception e) {
            String m = String.valueOf(e.getMessage());
            if (m.startsWith("AUTH:")) return "ERR:auth";
            if (m.startsWith("CODE:")) return "ERR:code:" + m.substring(5);
            if (e instanceof javax.net.ssl.SSLException || e instanceof java.io.EOFException) return "ERR:auth";
            if (e instanceof java.net.SocketException || e instanceof java.net.SocketTimeoutException || e instanceof java.net.UnknownHostException) return "ERR:net";
            return "ERR:other:" + m;
        }

        private boolean lan(String ip) {
            return ip != null && ip.matches("^(10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|172\\.(1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+)$");
        }

        @JavascriptInterface
        public String pairStart(String ip) {
            if (!lan(ip)) return "ERR:ip";
            try { remote().pairStart(ip, "Finglongerer"); return "ok"; } catch (Exception e) { return fail(e); }
        }

        @JavascriptInterface
        public String pairFinish(String code) {
            try { remote().pairFinish(code); return "ok"; } catch (Exception e) { return fail(e); }
        }

        @JavascriptInterface
        public String connect(String ip) {
            if (!lan(ip)) return "ERR:ip";
            try { remote().connect(ip); return "ok"; } catch (Exception e) { return fail(e); }
        }

        @JavascriptInterface
        public String key(String ip, int code) {
            if (!lan(ip)) return "ERR:ip";
            if (code < 1 || code > 400) return "ERR:other:Taste";
            try { remote().key(ip, code); return "ok"; } catch (Exception e) { return fail(e); }
        }

        @JavascriptInterface
        public String keyd(String ip, int code, int dir) {
            if (!lan(ip)) return "ERR:ip";
            if (code < 1 || code > 400 || dir < 1 || dir > 3) return "ERR:other:Taste";
            try { remote().keyDir(ip, code, dir); return "ok"; } catch (Exception e) { return fail(e); }
        }

        private volatile Thread voiceThread;
        private volatile boolean voiceRun;

        /** Sprachsuche: on = Mikrofon aufnehmen und an den Fernseher senden (höchstens 20 s), off = beenden. */
        @JavascriptInterface
        public synchronized String voice(String ip, boolean on) {
            if (!lan(ip)) return "ERR:ip";
            if (!on) {
                voiceRun = false;
                Thread t = voiceThread;
                if (t != null) { try { t.join(1500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }
                return "ok";
            }
            if (voiceThread != null) return "ok";
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 77);
                return "ERR:other:Mikrofon erlauben und dann nochmal drücken";
            }
            try {
                final TvRemote r = remote();         // einmal holen: remote() ist synchronisiert, der Aufnahme-Thread darf die Sperre nicht brauchen
                final int id = r.voiceStart(ip);
                voiceRun = true;
                Thread t = new Thread(() -> {
                    AudioRecord rec = null;
                    try {
                        int min = AudioRecord.getMinBufferSize(8000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                        rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 8000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, 16384));
                        rec.startRecording();
                        byte[] buf = new byte[8192];
                        long end = System.currentTimeMillis() + 20000;
                        while (voiceRun && System.currentTimeMillis() < end) {
                            int got = 0;
                            while (got < buf.length && voiceRun) {
                                int n = rec.read(buf, got, buf.length - got);
                                if (n <= 0) break;
                                got += n;
                            }
                            if (got > 0) r.voiceChunk(ip, id, buf, got);
                            if (got < buf.length) break;
                        }
                    } catch (Exception e) {
                        /* Verbindung weg: Sitzung endet */
                    } finally {
                        if (rec != null) { try { rec.stop(); } catch (Exception e) { /* egal */ } rec.release(); }
                        try { r.voiceEnd(ip, id); } catch (Exception e) { /* egal */ }
                        voiceRun = false;
                        voiceThread = null;
                    }
                }, "tv-voice");
                voiceThread = t;
                t.start();
                return "ok";
            } catch (Exception e) {
                return fail(e);
            }
        }

        @JavascriptInterface
        public String text(String ip, String text) {
            if (!lan(ip)) return "ERR:ip";
            if (text == null || text.length() > 200) return "ERR:other:Text";
            try { return remote().text(ip, text) ? "ok" : "nofield"; } catch (Exception e) { return fail(e); }
        }

        @JavascriptInterface
        public String power(String ip, boolean on) {
            if (!lan(ip)) return "ERR:ip";
            try { remote().power(ip, on); return "ok"; } catch (Exception e) { return fail(e); }
        }

        /** Name und MAC-Adresse des zuletzt gekoppelten Fernsehers ("name TAB mac"). */
        @JavascriptInterface
        public String lastInfo() {
            try { return remote().lastName() + "\t" + remote().lastMac(); } catch (Exception e) { return "\t"; }
        }

        @JavascriptInterface
        public String wake(String mac) {
            try { TvRemote.wakeOnLan(mac); return "ok"; } catch (Exception e) { return fail(e); }
        }

        /** Sucht Fernseher im Heimnetz. prefix = "192.168.1" oder leer (dann das Netz des Handys). Antwort: Zeilen "ip TAB name TAB mac" oder ERR. */
        @JavascriptInterface
        public String scan(String prefix) {
            try {
                String p = prefix == null ? "" : prefix.trim();
                if (p.isEmpty()) p = TvScan.localPrefix();
                if (!p.matches("^(10|192\\.168|172\\.(1[6-9]|2\\d|3[01]))\\.\\d{1,3}(\\.\\d{1,3})?$") || p.split("\\.").length != 3) return "ERR:ip";
                TvIdentity id = TvIdentity.load(getFilesDir());
                return String.join("\n", TvScan.scan(id.factory, p, 6467));
            } catch (Exception e) { return fail(e); }
        }

        @JavascriptInterface
        public String launch(String ip, String link) {
            if (!lan(ip)) return "ERR:ip";
            if (link == null || !link.matches("^[A-Za-z][A-Za-z0-9+.-]*://[^\\s<>\"']{0,300}$")) return "ERR:other:Link";
            try { remote().launch(ip, link); return "ok"; } catch (Exception e) { return fail(e); }
        }
    }

    /**
     * Home Assistant: zweites WebView über dem Platzhalter des dritten Reiters (Ort in CSS-Pixeln).
     * Eigener Cookie-/Speicherbereich, bleibt angemeldet, keine Frame-Sperre. Hat selbst keine JS-Brücken;
     * Links auf andere Rechner öffnen im Browser des Handys.
     */
    public class HaBridge {
        private WebView web;
        private String base;
        private String host;
        private volatile boolean canBack;
        private volatile boolean shown;
        private boolean cleanOn;
        /** Blendet in der Home-Assistant-Oberfläche Seitenleiste und obere Leiste aus (Stile in die offenen Shadow-Roots). */
        private static final String CLEAN_JS = "(function(){if(window.__fglClean)return;window.__fglClean=true;var css={main:\":host{--mdc-drawer-width:0px!important}ha-sidebar{display:none!important}\",root:\":host{--header-height:0px!important}.header,.toolbar{display:none!important}#view{min-height:100vh!important;padding-top:0!important}\"};function add(r,k){if(!r||r.querySelector('style[data-fgl=\"'+k+'\"]'))return;var s=document.createElement(\"style\");s.setAttribute(\"data-fgl\",k);s.textContent=css[k];r.appendChild(s)}function sr(e){return e&&e.shadowRoot}function tick(){var h=document.querySelector(\"home-assistant\"),m=sr(h)&&sr(h).querySelector(\"home-assistant-main\"),ms=sr(m);if(!ms)return;add(ms,\"main\");var p=ms.querySelector(\"ha-panel-lovelace\"),ps=sr(p),r=ps&&ps.querySelector(\"hui-root\");add(sr(r),\"root\")}tick();setInterval(tick,700)})();";

        private boolean valid(String url) {
            return url != null && url.length() < 300 && url.matches("^https?://[^\\s/$.?#][^\\s]*$");
        }

        @JavascriptInterface
        public String show(String url, double x, double y, double w, double h, boolean clean) {
            if (!valid(url)) return "ERR:url";
            final float d = getResources().getDisplayMetrics().density;
            final int px = Math.round((float) x * d), py = Math.round((float) y * d);
            final int pw = Math.max(1, Math.round((float) w * d)), ph = Math.max(1, Math.round((float) h * d));
            runOnUiThread(() -> {
                if (web == null) create();
                CoordinatorLayout.LayoutParams lp = new CoordinatorLayout.LayoutParams(pw, ph);
                lp.leftMargin = px;
                lp.topMargin = py;
                web.setLayoutParams(lp);
                if (!url.equals(base) || clean != cleanOn) {
                    base = url;
                    cleanOn = clean;
                    host = Uri.parse(url).getHost();
                    canBack = false;
                    web.loadUrl(url);
                }
                web.setVisibility(View.VISIBLE);
                shown = true;
            });
            return "ok";
        }

        @JavascriptInterface
        public void hide() {
            shown = false;
            runOnUiThread(() -> { if (web != null) web.setVisibility(View.GONE); });
        }

        /** true, wenn das Dashboard sichtbar ist und eine Seite zurückgegangen wurde. */
        @JavascriptInterface
        public boolean back() {
            if (!shown || !canBack) return false;
            runOnUiThread(() -> { if (web != null && web.canGoBack()) web.goBack(); });
            return true;
        }

        private void create() {
            web = new WebView(MainActivity.this);
            web.setBackgroundColor(0xFF14161A);
            WebSettings st = web.getSettings();
            st.setJavaScriptEnabled(true);
            st.setDomStorageEnabled(true);
            st.setAllowFileAccess(false);
            st.setAllowContentAccess(false);
            st.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
            CookieManager.getInstance().setAcceptCookie(true);
            web.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                    Uri u = r.getUrl();
                    String sc = u.getScheme();
                    if (("http".equals(sc) || "https".equals(sc)) && host != null && host.equalsIgnoreCase(u.getHost())) return false;
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* kein Browser */ }
                    return true;
                }

                @Override
                public void onPageFinished(WebView v, String url) {
                    String h = Uri.parse(String.valueOf(url)).getHost();
                    if (cleanOn && host != null && host.equalsIgnoreCase(h)) v.evaluateJavascript(CLEAN_JS, null);
                }

                @Override
                public void doUpdateVisitedHistory(WebView v, String url, boolean isReload) {
                    canBack = v.canGoBack();
                }

                @Override
                public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                    if (!r.isForMainFrame()) return;
                    String msg = TextUtils.htmlEncode(String.valueOf(e.getDescription()));
                    String link = TextUtils.htmlEncode(String.valueOf(base));
                    v.loadDataWithBaseURL(null, "<html><body style=\"background:#14161a;color:#e8eaed;font:16px sans-serif;padding:24px\"><p>" + msg + "</p><p><a style=\"color:#18bcf2\" href=\"" + link + "\">&#8635;</a></p></body></html>", "text/html", "utf-8", null);
                }
            });
            ((ViewGroup) getBridge().getWebView().getParent()).addView(web);
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getBridge().getWebView().addJavascriptInterface(new ShareBridge(), "STShare");
        getBridge().getWebView().addJavascriptInterface(new TcpBridge(), "STTcp");
        getBridge().getWebView().addJavascriptInterface(new DeviceBridge(), "STDevice");
        getBridge().getWebView().addJavascriptInterface(new TvBridge(), "STTv");
        getBridge().getWebView().addJavascriptInterface(new HaBridge(), "STHa");
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
