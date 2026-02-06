package com.android.drive;

import android.os.Bundle;
import android.content.Intent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WebDavPlugin.class);
        super.onCreate(savedInstanceState);
        checkIntent(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        checkIntent(intent);
    }

    private void checkIntent(Intent intent) {
        if (intent != null && intent.getData() != null) {
            String data = intent.getData().toString();
            if (data.contains("webdav://transfers")) {
                if (getBridge() != null) {
                    getBridge().triggerWindowJSEvent("openTransferDeepLink");
                }
            }
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        if (getBridge() != null && getBridge().getWebView() != null) {
            android.webkit.WebSettings settings = getBridge().getWebView().getSettings();
            settings.setCacheMode(android.webkit.WebSettings.LOAD_NO_CACHE);
            settings.setDomStorageEnabled(true);
            settings.setJavaScriptEnabled(true);
            getBridge().getWebView().clearCache(true);
        }
    }
}
