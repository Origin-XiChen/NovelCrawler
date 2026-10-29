package com.originxichen.novelcrawler.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App 内自定义插件必须先注册,再交给 Bridge 初始化
        registerPlugin(PinnedHttpsPlugin.class);
        registerPlugin(SshTunnelPlugin.class);
        registerPlugin(BackgroundDownloadPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
