package com.originxichen.novelcrawler.mobile;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;

/**
 * 自签 HTTPS 的证书固定(TOFU + 指纹校验)。
 *
 * 为什么需要原生:WebView 只认系统信任库,装过任何第三方 CA 的手机都"信任"一堆
 * 与电脑无关的根证书;而且 JS 拿不到对端证书,没法做固定。这里用
 * 「只信任这一张 CA」的 TrustManager 走 OkHttp 之外的 HttpsURLConnection:
 *
 *   • anchor 只有电脑那张 CA —— 系统里其他 CA 一律不认;
 *   • 首次连接先把 CA 证书取回来,用二维码里携带的指纹校验,对不上直接拒绝
 *     (指纹走「用户肉眼可见的二维码」这条可信通道,不依赖网络)。
 *
 * 之后所有 https 请求都经 {@link #request} 走这条固定通道。
 */
@CapacitorPlugin(name = "PinnedHttps")
public class PinnedHttpsPlugin extends Plugin {

    private static final String STORE_NAME = "pinned-trust.bks";
    private static final String STORE_PASS = "novelist-pin";

    private volatile SSLSocketFactory factory;

    @Override
    public void load() {
        // 进程重启后自动恢复上次固定过的 CA,不用每次重新扫码
        try {
            File file = storeFile();
            if (file.isFile() && file.length() > 0) {
                factory = buildFactory(loadStore(file));
            }
        } catch (Exception ignored) {
            factory = null;
        }
    }

    private File storeFile() {
        return new File(getContext().getFilesDir(), STORE_NAME);
    }

    private static KeyStore loadStore(File file) throws Exception {
        KeyStore ks = KeyStore.getInstance("BKS");
        try (InputStream in = new FileInputStream(file)) {
            ks.load(in, STORE_PASS.toCharArray());
        }
        return ks;
    }

    private static SSLSocketFactory buildFactory(KeyStore ks) throws Exception {
        TrustManagerFactory tmf =
                TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(ks);
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, tmf.getTrustManagers(), new java.security.SecureRandom());
        return ctx.getSocketFactory();
    }

    /** SHA-256(整张证书 DER) 的 base64url 前 16 字节,与桌面端 short_fingerprint 同口径。 */
    private static String shortPin(byte[] der) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] digest = md.digest(der);
        int size = Math.min(16, digest.length);
        byte[] head = new byte[size];
        System.arraycopy(digest, 0, head, 0, size);
        return Base64.encodeToString(head, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private static List<X509Certificate> parseCerts(byte[] derOrPem) throws Exception {
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        List<X509Certificate> out = new ArrayList<>();
        // CertificateFactory 直接吃 PEM 字节流(可含多张)
        try (InputStream in = new java.io.ByteArrayInputStream(derOrPem)) {
            for (java.security.cert.Certificate c : cf.generateCertificates(in)) {
                out.add((X509Certificate) c);
            }
        }
        return out;
    }

    /** POST /pinned/status → { installed, pin } */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        File file = storeFile();
        ret.put("installed", factory != null && file.isFile());
        String pin = "";
        try {
            if (file.isFile()) {
                KeyStore ks = loadStore(file);
                java.util.Enumeration<String> aliases = ks.aliases();
                if (aliases.hasMoreElements()) {
                    X509Certificate cert = (X509Certificate) ks.getCertificate(aliases.nextElement());
                    pin = shortPin(cert.getEncoded());
                }
            }
        } catch (Exception ignored) {
        }
        ret.put("pin", pin);
        call.resolve(ret);
    }

    /**
     * POST /pinned/install { pem, pin } → 固定一张 CA。
     * pin 非空时必须与证书算出来的指纹一致,否则拒绝安装(防替换)。
     */
    @PluginMethod
    public void install(PluginCall call) {
        String pem = call.getString("pem", "");
        String pin = call.getString("pin", "");
        if (pem == null || pem.trim().isEmpty()) {
            call.reject("证书内容为空");
            return;
        }
        try {
            List<X509Certificate> certs = parseCerts(pem.getBytes(StandardCharsets.US_ASCII));
            if (certs.isEmpty()) {
                call.reject("证书解析失败");
                return;
            }
            // 第一张就是 CA 本身(桌面端 /tls/ca.crt 只发一张)
            byte[] der = certs.get(0).getEncoded();
            String actual = shortPin(der);
            if (pin != null && !pin.isEmpty() && !pin.equals(actual)) {
                call.reject("证书指纹不匹配，可能存在中间人");
                return;
            }
            KeyStore ks = KeyStore.getInstance("BKS");
            ks.load(null, null);
            ks.setCertificateEntry("novelist-ca", certs.get(0));
            File file = storeFile();
            try (OutputStream out = new FileOutputStream(file)) {
                ks.store(out, STORE_PASS.toCharArray());
            }
            factory = buildFactory(ks);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("pin", actual);
            call.resolve(ret);
        } catch (Exception exc) {
            call.reject("安装证书失败: " + exc.getMessage());
        }
    }

    /** POST /pinned/clear */
    @PluginMethod
    public void clear(PluginCall call) {
        factory = null;
        File file = storeFile();
        boolean ok = !file.isFile() || file.delete();
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        call.resolve(ret);
    }

    /**
     * POST /pinned/fetch { url, method, headers, dataBase64, timeout, insecure, wantCert }
     *  → { status, headers, bodyBase64, certPin, chainPem }
     *
     * insecure=true 只用于「首次取回 CA 证书」这一步:此时还没有可信任的锚,
     * 只能先连上去、把证书拿回来,由 JS 用二维码里的指纹判断要不要信它。
     * wantCert=true 时额外返回对端证书指纹与证书链 PEM(供校验/提示)。
     */
    @PluginMethod
    public void fetch(PluginCall call) {
        String url = call.getString("url", "");
        String method = call.getString("method", "GET");
        boolean insecure = Boolean.TRUE.equals(call.getBoolean("insecure", false));
        boolean wantCert = Boolean.TRUE.equals(call.getBoolean("wantCert", false));
        Integer timeout = call.getInt("timeout", 20000);
        if (url == null || url.isEmpty()) {
            call.reject("url 不能为空");
            return;
        }
        if (!insecure && factory == null) {
            call.reject("尚未固定证书，请先完成证书安装");
            return;
        }
        String data = call.getString("dataBase64", "");
        JSObject headers = call.getObject("headers", new JSObject());

        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method == null ? "GET" : method.toUpperCase(Locale.ROOT));
            conn.setConnectTimeout(timeout == null ? 20000 : timeout);
            conn.setReadTimeout(timeout == null ? 20000 : timeout);
            conn.setInstanceFollowRedirects(!insecure);   // 取证书阶段不跟随跳转,避免被引到别处
            conn.setRequestProperty("Accept-Encoding", "identity");
            if (headers != null) {
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    conn.setRequestProperty(key, String.valueOf(headers.get(key)));
                }
            }
            if (data != null && !data.isEmpty()) {
                conn.setDoOutput(true);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(Base64.decode(data, Base64.DEFAULT));
                }
            }
            if (conn instanceof HttpsURLConnection) {
                HttpsURLConnection https = (HttpsURLConnection) conn;
                if (insecure) {
                    // 只在这一步:接受任何证书(拿回来自己校验),其余情况严禁
                    https.setSSLSocketFactory(trustAllFactory());
                    https.setHostnameVerifier((host, session) -> true);
                } else {
                    https.setSSLSocketFactory(factory);
                }
            }
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            byte[] body = in == null ? new byte[0] : readAll(in);
            if (in != null) {
                in.close();
            }
            JSObject ret = new JSObject();
            ret.put("status", status);
            JSObject outHeaders = new JSObject();
            for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
                if (entry.getKey() == null) continue;
                outHeaders.put(entry.getKey(), entry.getValue().isEmpty() ? "" : entry.getValue().get(0));
            }
            ret.put("headers", outHeaders);
            ret.put("bodyBase64", Base64.encodeToString(body, Base64.NO_WRAP));
            if (conn instanceof HttpsURLConnection && wantCert) {
                try {
                    java.security.cert.Certificate[] chain = ((HttpsURLConnection) conn).getServerCertificates();
                    if (chain != null && chain.length > 0) {
                        ret.put("certPin", shortPin(chain[0].getEncoded()));
                        StringBuilder pem = new StringBuilder();
                        for (java.security.cert.Certificate c : chain) {
                            pem.append("-----BEGIN CERTIFICATE-----\n")
                               .append(Base64.encodeToString(c.getEncoded(), Base64.NO_WRAP))
                               .append("\n-----END CERTIFICATE-----\n");
                        }
                        ret.put("chainPem", pem.toString());
                    }
                } catch (Exception ignored) {
                }
            }
            call.resolve(ret);
        } catch (Exception exc) {
            call.reject(String.valueOf(exc.getMessage()));
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static SSLSocketFactory trustAllFactory() throws Exception {
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new javax.net.ssl.TrustManager[]{new javax.net.ssl.X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) {
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        }}, new java.security.SecureRandom());
        return ctx.getSocketFactory();
    }
}
