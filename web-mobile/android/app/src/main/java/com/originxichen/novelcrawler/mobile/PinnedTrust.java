package com.originxichen.novelcrawler.mobile;

import android.content.Context;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/**
 * 与 PinnedHttpsPlugin 共用同一份自签 CA 存储。
 * 后台下载服务不能依赖 WebView 的 TrustManager，只能自己把这张 CA 装进
 * HttpsURLConnection；没有固定过证书时返回 null，走系统信任库。
 */
final class PinnedTrust {

    static final String STORE_NAME = "pinned-trust.bks";
    static final String STORE_PASS = "novelist-pin";

    private PinnedTrust() {
    }

    static File storeFile(Context context) {
        return new File(context.getFilesDir(), STORE_NAME);
    }

    static SSLSocketFactory socketFactory(Context context) {
        File file = storeFile(context);
        if (!file.isFile() || file.length() == 0) return null;
        try (InputStream in = new FileInputStream(file)) {
            KeyStore store = KeyStore.getInstance("BKS");
            store.load(in, STORE_PASS.toCharArray());
            TrustManagerFactory tmf =
                    TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init(store);
            SSLContext contextTls = SSLContext.getInstance("TLS");
            contextTls.init(null, tmf.getTrustManagers(), new SecureRandom());
            return contextTls.getSocketFactory();
        } catch (Exception ignored) {
            return null;
        }
    }
}
