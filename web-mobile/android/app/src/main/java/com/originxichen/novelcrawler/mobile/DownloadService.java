package com.originxichen.novelcrawler.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocketFactory;

/**
 * 手机端离线包的后台下载服务。
 *
 * 为什么必须放到原生：WebView 的 JS 在切后台/锁屏后会被系统冻结，
 * fetch 和 JSZip 都会停；离线包动辄几十上百 MB，用户不可能一直盯着屏幕。
 * 这里用前台服务下载到应用私有目录，完成后 JS 回前台再导入本地书库。
 */
public class DownloadService extends Service {

    static final String ACTION_START =
            "com.originxichen.novelcrawler.mobile.action.DOWNLOAD_START";
    static final String ACTION_CANCEL =
            "com.originxichen.novelcrawler.mobile.action.DOWNLOAD_CANCEL";
    static final String EXTRA_ID = "id";
    static final String EXTRA_URL = "url";
    static final String EXTRA_FILE_NAME = "fileName";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_HEADERS = "headers";
    static final String EXTRA_PINNED = "pinned";

    private static final String CHANNEL_ID = "novelcrawler-download";
    private static final int NOTIFY_PROGRESS = 8801;
    private static final int NOTIFY_DONE = 8802;

    private static volatile boolean running = false;
    private static volatile String activeId = "";

    private volatile HttpURLConnection connection;
    private volatile boolean cancelled = false;
    private Thread worker;

    static boolean isRunning() {
        return running;
    }

    static String activeId() {
        return activeId;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (ACTION_CANCEL.equals(intent.getAction())) {
            cancelTask(intent.getStringExtra(EXTRA_ID));
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (running) {
            // 同一个服务同一时刻只跑一个下载；第二个任务由插件层排队。
            // 这里不能 stopSelf：那会把正在跑的第一个下载一起停掉。
            return START_NOT_STICKY;
        }

        final String id = intent.getStringExtra(EXTRA_ID);
        final String url = intent.getStringExtra(EXTRA_URL);
        final String fileName = intent.getStringExtra(EXTRA_FILE_NAME);
        final String title = valueOr(intent.getStringExtra(EXTRA_TITLE), "离线包");
        final String headers = valueOr(intent.getStringExtra(EXTRA_HEADERS), "{}");
        final boolean pinned = intent.getBooleanExtra(EXTRA_PINNED, false);
        if (id == null || id.isEmpty() || url == null || url.isEmpty()
                || fileName == null || fileName.isEmpty()) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        running = true;
        activeId = id;
        cancelled = false;
        createChannel();
        startForegroundCompat(buildProgress(title, 0, -1));
        worker = new Thread(
                () -> runDownload(id, url, fileName, title, headers, pinned),
                "novelcrawler-download"
        );
        worker.start();
        return START_NOT_STICKY;
    }

    private void cancelTask(String id) {
        if (id == null || !id.equals(activeId)) return;
        cancelled = true;
        HttpURLConnection conn = connection;
        if (conn != null) conn.disconnect();
        JSONObject previous = DownloadState.read(this, id);
        String path = previous == null ? "" : previous.optString("path", "");
        String fileName = previous == null ? "" : previous.optString("fileName", "");
        String title = previous == null ? "" : previous.optString("title", "");
        DownloadState.write(
                this,
                DownloadState.create(id, "cancelled", path, fileName, title, 0, -1, "已取消"),
                true
        );
        stopForeground(true);
    }

    private void runDownload(
            String id,
            String url,
            String fileName,
            String title,
            String headersJson,
            boolean pinned
    ) {
        File dir = downloadDir();
        File part = new File(dir, fileName + ".part");
        File finalFile = new File(dir, fileName);
        HttpURLConnection conn = null;
        try {
            if (!dir.isDirectory() && !dir.mkdirs()) {
                throw new IOException("无法创建下载目录");
            }
            if (part.exists() && !part.delete()) {
                throw new IOException("无法清理旧临时文件");
            }
            if (finalFile.exists() && !finalFile.delete()) {
                throw new IOException("无法覆盖旧文件");
            }

            conn = (HttpURLConnection) new URL(url).openConnection();
            connection = conn;
            conn.setConnectTimeout(20000);
            // 电脑打包大书时可能几十秒不吐字节，读超时不能太短
            conn.setReadTimeout(180000);
            conn.setRequestProperty("Accept-Encoding", "identity");
            JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                conn.setRequestProperty(key, headers.optString(key));
            }
            if (conn instanceof HttpsURLConnection && pinned) {
                SSLSocketFactory factory = PinnedTrust.socketFactory(this);
                if (factory == null) {
                    throw new IOException("证书尚未固定，请重新扫码配对");
                }
                ((HttpsURLConnection) conn).setSSLSocketFactory(factory);
            }

            int status = conn.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                String detail = readText(conn.getErrorStream(), 4096);
                throw new IOException(
                        "下载失败 (" + status + ")" + (detail.isEmpty() ? "" : ": " + detail)
                );
            }
            String contentType = conn.getContentType();
            if (contentType != null
                    && contentType.toLowerCase(java.util.Locale.US).contains("application/json")) {
                String detail = readText(conn.getInputStream(), 4096);
                throw new IOException(detail.isEmpty() ? "电脑返回了错误信息" : detail);
            }

            long total = -1;
            String contentLength = conn.getHeaderField("Content-Length");
            if (contentLength != null) {
                try {
                    total = Long.parseLong(contentLength.trim());
                } catch (NumberFormatException ignored) {
                    total = -1;
                }
            }

            long received = 0;
            long lastUpdate = 0;
            byte[] buffer = new byte[64 * 1024];
            try (InputStream in = new BufferedInputStream(conn.getInputStream());
                 OutputStream out = new BufferedOutputStream(new FileOutputStream(part))) {
                int read;
                while ((read = in.read(buffer)) > 0) {
                    if (cancelled) throw new CancelledException();
                    out.write(buffer, 0, read);
                    received += read;
                    long now = SystemClock.elapsedRealtime();
                    if (now - lastUpdate >= 500 || (total > 0 && received >= total)) {
                        lastUpdate = now;
                        updateProgress(id, title, finalFile, fileName, received, total);
                    }
                }
                out.flush();
            }

            if (cancelled) throw new CancelledException();
            if (total > 0 && received != total) {
                throw new IOException("下载不完整（" + received + "/" + total + " 字节）");
            }
            if (!part.renameTo(finalFile)) {
                throw new IOException("保存下载文件失败");
            }
            DownloadState.write(
                    this,
                    DownloadState.create(
                            id, "done", finalFile.getAbsolutePath(), fileName,
                            title, received, total, ""
                    ),
                    true
            );
            showDone(title, "");
        } catch (CancelledException cancelledError) {
            part.delete();
            DownloadState.write(
                    this,
                    DownloadState.create(
                            id, "cancelled", finalFile.getAbsolutePath(), fileName,
                            title, 0, -1, "已取消"
                    ),
                    true
            );
        } catch (Exception exc) {
            part.delete();
            String message = exc.getMessage();
            if (message == null || message.trim().isEmpty()) {
                message = exc.getClass().getSimpleName();
            }
            if (cancelled) {
                DownloadState.write(
                        this,
                        DownloadState.create(
                                id, "cancelled", finalFile.getAbsolutePath(), fileName,
                                title, 0, -1, "已取消"
                        ),
                        true
                );
            } else {
                DownloadState.write(
                        this,
                        DownloadState.create(
                                id, "error", finalFile.getAbsolutePath(), fileName,
                                title, 0, -1, message
                        ),
                        true
                );
                showDone(title, message);
            }
        } finally {
            if (conn != null) conn.disconnect();
            connection = null;
            running = false;
            activeId = "";
            stopForeground(true);
            stopSelf();
        }
    }

    private void updateProgress(
            String id,
            String title,
            File file,
            String fileName,
            long received,
            long total
    ) {
        DownloadState.write(
                this,
                DownloadState.create(
                        id, "running", file.getAbsolutePath(), fileName,
                        title, received, total, ""
                ),
                false
        );
        NotificationManager manager =
                (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFY_PROGRESS, buildProgress(title, received, total));
        }
    }

    private void showDone(String title, String error) {
        if (cancelled) return;
        NotificationManager manager =
                (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        boolean ok = error == null || error.isEmpty();
        Notification.Builder builder = newBuilder();
        builder.setSmallIcon(
                        ok
                                ? android.R.drawable.stat_sys_download_done
                                : android.R.drawable.stat_notify_error
                )
                .setContentTitle(ok ? "下载完成" : "下载失败")
                .setContentText(clip(ok ? title : error))
                .setContentIntent(contentIntent())
                .setAutoCancel(true);
        manager.notify(NOTIFY_DONE, builder.build());
    }

    private Notification buildProgress(String title, long received, long total) {
        int percent = total > 0 ? (int) Math.min(100, received * 100 / total) : 0;
        String text = total > 0
                ? percent + "% · " + human(received) + " / " + human(total)
                : human(received);
        Notification.Builder builder = newBuilder();
        builder.setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("正在下载 · " + clip(title))
                .setContentText(text)
                .setContentIntent(contentIntent())
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setProgress(100, percent, total <= 0);
        return builder.build();
    }

    @SuppressWarnings("deprecation")
    private Notification.Builder newBuilder() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return new Notification.Builder(this, CHANNEL_ID);
        }
        return new Notification.Builder(this);
    }

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                    NOTIFY_PROGRESS,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            );
        } else {
            startForeground(NOTIFY_PROGRESS, notification);
        }
    }

    private PendingIntent contentIntent() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, 1, open, flags);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager =
                (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "后台下载",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("手机端离线包下载进度");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private File downloadDir() {
        return new File(getFilesDir(), "downloads");
    }

    private static String valueOr(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }

    private static String clip(String text) {
        if (text == null) return "";
        String trimmed = text.trim();
        return trimmed.length() <= 36 ? trimmed : trimmed.substring(0, 35) + "…";
    }

    private static String human(long bytes) {
        if (bytes < 1024) return bytes + " B";
        double value = bytes;
        String[] units = {"KB", "MB", "GB"};
        for (String unit : units) {
            value /= 1024;
            if (value < 1024) {
                return String.format(java.util.Locale.US, "%.1f %s", value, unit);
            }
        }
        return String.format(java.util.Locale.US, "%.1f TB", value / 1024);
    }

    private static String readText(InputStream in, int max) {
        if (in == null) return "";
        try (InputStream input = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[1024];
            int read;
            int total = 0;
            while ((read = input.read(buffer)) > 0 && total < max) {
                int keep = Math.min(read, max - total);
                out.write(buffer, 0, keep);
                total += keep;
            }
            String text = out.toString("UTF-8").trim();
            try {
                JSONObject obj = new JSONObject(text);
                String error = obj.optString("error", "");
                if (!error.isEmpty()) return error;
            } catch (Exception ignored) {
            }
            return text;
        } catch (Exception ignored) {
            return "";
        }
    }

    @Override
    public void onDestroy() {
        cancelled = true;
        HttpURLConnection conn = connection;
        if (conn != null) conn.disconnect();
        running = false;
        activeId = "";
        super.onDestroy();
    }

    private static final class CancelledException extends Exception {
    }
}
