package com.originxichen.novelcrawler.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;

import java.util.Properties;

/**
 * App 内置 SSH 通道 —— 只做「密码认证 + 本地端口转发」。
 *
 * 设计取舍（按用户要求）:
 *   • 不传任何密钥文件:手机侧只用密码登录,不需要导入私钥,也不需要电脑改
 *     authorized_keys。连接参数由扫码配对带进来。
 *   • 只开一条本地转发:phone:localPort → 127.0.0.1:remotePort(电脑上的服务端口),
 *     相当于把 `ssh -N -L` 内建进 App,免装第三方 SSH 客户端。
 *   • 主机密钥首次接受并回报指纹(TOFU):配对走的是屏幕上的二维码,
 *     这一层只做「换台电脑连了就告诉你」的可见性。
 */
@CapacitorPlugin(name = "SshTunnel")
public class SshTunnelPlugin extends Plugin {

    private Session session;
    private int localPort;
    private String hostFingerprint = "";
    private String target = "";

    private synchronized void closeQuietly() {
        if (session != null) {
            try {
                session.disconnect();
            } catch (Exception ignored) {
            }
            session = null;
        }
        localPort = 0;
        target = "";
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String host = call.getString("host", "");
        String user = call.getString("user", "");
        String password = call.getString("password", "");
        int port = call.getInt("port", 22) == null ? 22 : call.getInt("port", 22);
        int local = call.getInt("localPort", 0) == null ? 0 : call.getInt("localPort", 0);
        int remote = call.getInt("remotePort", 0) == null ? 0 : call.getInt("remotePort", 0);
        if (host == null || host.isEmpty() || user == null || user.isEmpty()) {
            call.reject("缺少主机或用户名");
            return;
        }
        if (remote <= 0) {
            call.reject("缺少要转发的目标端口");
            return;
        }
        if (local <= 0) local = remote;   // 默认用同一个端口,手机侧访问更直观

        closeQuietly();
        try {
            JSch jsch = new JSch();
            Session s = jsch.getSession(user, host, port);
            s.setPassword(password == null ? "" : password);
            Properties cfg = new Properties();
            // 首次连接接受主机密钥(TOFU),指纹回传给界面供人工核对
            cfg.put("StrictHostKeyChecking", "no");
            cfg.put("PreferredAuthentications", "password,keyboard-interactive");
            s.setConfig(cfg);
            s.setServerAliveInterval(20000);   // 手机切网/待机后别被静默掐断
            s.setServerAliveCountMax(3);
            s.connect(15000);

            s.setPortForwardingL(local, "127.0.0.1", remote);
            session = s;
            localPort = local;
            target = host;
            try {
                // HostKey.getKey() 返回的是 base64 文本(不是 DER 字节)
                String keyText = s.getHostKey() == null ? "" : s.getHostKey().getKey();
                hostFingerprint = keyText.isEmpty() ? ""
                        : fingerprint(keyText.getBytes("UTF-8"));
            } catch (Exception ignored) {
            }

            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("localPort", local);
            ret.put("host", host);
            ret.put("hostFingerprint", hostFingerprint);
            call.resolve(ret);
        } catch (Exception exc) {
            closeQuietly();
            String msg = exc.getMessage() == null ? exc.getClass().getSimpleName() : exc.getMessage();
            call.reject("SSH 连接失败: " + msg);
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        boolean alive = session != null && session.isConnected();
        ret.put("connected", alive);
        ret.put("localPort", alive ? localPort : 0);
        ret.put("host", target);
        ret.put("hostFingerprint", hostFingerprint);
        call.resolve(ret);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        closeQuietly();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    private static String fingerprint(byte[] data) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(data);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 16; i++) {
                if (i > 0) sb.append(':');
                sb.append(String.format("%02X", d[i]));
            }
            return sb.toString();
        } catch (Exception exc) {
            return "";
        }
    }
}
