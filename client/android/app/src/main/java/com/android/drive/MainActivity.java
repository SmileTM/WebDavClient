package com.android.drive;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WebDavPlugin.class);
        super.onCreate(savedInstanceState);
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
