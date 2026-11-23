package de.krichel.steasyremote;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.JavascriptInterface;

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

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getBridge().getWebView().addJavascriptInterface(new ShareBridge(), "STShare");
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
