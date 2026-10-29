package com.originxichen.novelcrawler.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * 后台下载插件：把离线包交给前台服务下载，JS 只负责轮询进度和导入。
 * 这样切后台/锁屏时 WebView 被冻结，下载仍然继续。
 */
@CapacitorPlugin(name = "BackgroundDownload")
public class BackgroundDownloadPlugin extends Plugin {

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String requested = call.getString("fileName", "");
        String title = call.getString("title", "离线包");
        JSObject headers = call.getObject("headers", new JSObject());
        boolean pinned = Boolean.TRUE.equals(call.getBoolean("pinned", false));
        if (url == null || url.isEmpty()) {
            call.reject("下载地址为空");
            return;
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            call.reject("不支持的下载地址");
            return;
        }
        if (DownloadService.isRunning()) {
            call.reject("已有下载任务在进行，请稍后再试");
            return;
        }

        String id = UUID.randomUUID().toString();
        String fileName = sanitizeFileName(requested, id);
        File dir = new File(getContext().getFilesDir(), "downloads");
        File out = new File(dir, fileName);
        DownloadState.write(
                getContext(),
                DownloadState.create(
                        id, "running", out.getAbsolutePath(), fileName, title, 0, -1, ""
                ),
                true
        );

        requestNotificationPermission();

        Intent intent = new Intent(getContext(), DownloadService.class);
        intent.setAction(DownloadService.ACTION_START);
        intent.putExtra(DownloadService.EXTRA_ID, id);
        intent.putExtra(DownloadService.EXTRA_URL, url);
        intent.putExtra(DownloadService.EXTRA_FILE_NAME, fileName);
        intent.putExtra(DownloadService.EXTRA_TITLE, title);
        intent.putExtra(DownloadService.EXTRA_HEADERS, headers == null ? "{}" : headers.toString());
        intent.putExtra(DownloadService.EXTRA_PINNED, pinned);
        try {
            ContextCompat.startForegroundService(getContext(), intent);
        } catch (Exception exc) {
            DownloadState.write(
                    getContext(),
                    DownloadState.create(
                            id, "error", out.getAbsolutePath(), fileName, title,
                            0, -1, "无法启动下载服务: " + exc.getMessage()
                    ),
                    true
            );
            call.reject("无法启动下载服务");
            return;
        }

        JSObject ret = new JSObject();
        ret.put("id", id);
        ret.put("path", out.getAbsolutePath());
        ret.put("fileName", fileName);
        call.resolve(ret);
    }

    @PluginMethod
    public void status(PluginCall call) {
        String id = call.getString("id");
        JSONObject state = DownloadState.read(getContext(), id);
        if (state == null) {
            call.reject("下载任务不存在");
            return;
        }
        call.resolve(toJs(state));
    }

    @PluginMethod
    public void list(PluginCall call) {
        List<JSONObject> states = DownloadState.all(getContext());
        boolean serviceRunning = DownloadService.isRunning();
        String activeId = DownloadService.activeId();
        JSArray items = new JSArray();
        for (JSONObject state : states) {
            String id = state.optString("id", "");
            String status = state.optString("state", "");
            long age = System.currentTimeMillis() - state.optLong("updated", 0);
            if ("running".equals(status)
                    && age > 15000
                    && (!serviceRunning || !id.equals(activeId))) {
                // 进程被杀/服务被系统停掉后遗留的 running 状态：不会再继续了
                String stalePath = state.optString("path", "");
                File part = new File(stalePath + ".part");
                if (part.isFile()) part.delete();
                JSONObject failed = DownloadState.create(
                        id,
                        "error",
                        state.optString("path", ""),
                        state.optString("fileName", ""),
                        state.optString("title", ""),
                        state.optLong("received", 0),
                        state.optLong("total", -1),
                        "下载已中断"
                );
                DownloadState.write(getContext(), failed, true);
                state = failed;
            }
            items.put(toJs(state));
        }
        JSObject ret = new JSObject();
        ret.put("items", items);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.reject("缺少任务 id");
            return;
        }
        if (DownloadService.isRunning() && id.equals(DownloadService.activeId())) {
            Intent intent = new Intent(getContext(), DownloadService.class);
            intent.setAction(DownloadService.ACTION_CANCEL);
            intent.putExtra(DownloadService.EXTRA_ID, id);
            try {
                ContextCompat.startForegroundService(getContext(), intent);
            } catch (Exception ignored) {
            }
            call.resolve();
            return;
        }
        JSONObject state = DownloadState.read(getContext(), id);
        if (state != null) {
            DownloadState.write(
                    getContext(),
                    DownloadState.create(
                            id,
                            "cancelled",
                            state.optString("path", ""),
                            state.optString("fileName", ""),
                            state.optString("title", ""),
                            state.optLong("received", 0),
                            state.optLong("total", -1),
                            "已取消"
                    ),
                    true
            );
        }
        call.resolve();
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) {
            call.reject("缺少任务 id");
            return;
        }
        if (DownloadService.isRunning() && id.equals(DownloadService.activeId())) {
            call.reject("下载仍在进行，不能删除");
            return;
        }
        JSONObject state = DownloadState.read(getContext(), id);
        if (state != null) {
            File dir = new File(getContext().getFilesDir(), "downloads");
            File file = new File(state.optString("path", ""));
            if (inside(dir, file)) {
                file.delete();
                new File(file.getAbsolutePath() + ".part").delete();
            }
        }
        DownloadState.remove(getContext(), id);
        call.resolve();
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        Activity activity = getActivity();
        if (activity == null) return;
        if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    9101
            );
        }
    }

    private static String sanitizeFileName(String requested, String id) {
        String name = requested == null ? "" : requested.trim();
        name = name.replaceAll("[\\\\/:*?\"<>|\\s]+", "_");
        name = name.replace("..", ".");
        if (name.isEmpty()) name = "bundle-" + id + ".zip";
        if (!name.toLowerCase(Locale.US).endsWith(".zip")) name += ".zip";
        if (name.length() > 120) {
            name = name.substring(name.length() - 120);
            if (!name.endsWith(".zip")) name += ".zip";
        }
        return name;
    }

    private static boolean inside(File dir, File file) {
        try {
            String base = dir.getCanonicalPath() + File.separator;
            return file.getCanonicalPath().startsWith(base);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static JSObject toJs(JSONObject state) {
        JSObject out = new JSObject();
        out.put("id", state.optString("id", ""));
        out.put("state", state.optString("state", ""));
        out.put("path", state.optString("path", ""));
        out.put("fileName", state.optString("fileName", ""));
        out.put("title", state.optString("title", ""));
        out.put("received", state.optLong("received", 0));
        out.put("total", state.optLong("total", -1));
        out.put("error", state.optString("error", ""));
        out.put("updated", state.optLong("updated", 0));
        return out;
    }
}
