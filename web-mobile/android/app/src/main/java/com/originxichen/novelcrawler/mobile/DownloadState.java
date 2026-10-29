package com.originxichen.novelcrawler.mobile;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** 后台下载任务的落盘状态：进程被杀后，下次启动仍能知道哪个包已经下完。 */
final class DownloadState {

    static final String PREFS = "background-downloads";
    private static final String PREFIX = "state:";

    private DownloadState() {
    }

    static JSONObject create(
            String id,
            String state,
            String path,
            String fileName,
            String title,
            long received,
            long total,
            String error
    ) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("id", id);
            obj.put("state", state);
            obj.put("path", path == null ? "" : path);
            obj.put("fileName", fileName == null ? "" : fileName);
            obj.put("title", title == null ? "" : title);
            obj.put("received", received);
            obj.put("total", total);
            obj.put("error", error == null ? "" : error);
            obj.put("updated", System.currentTimeMillis());
        } catch (Exception ignored) {
        }
        return obj;
    }

    static void write(Context context, JSONObject state, boolean sync) {
        if (state == null) return;
        String id = state.optString("id", "");
        if (id.isEmpty()) return;
        SharedPreferences prefs =
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor editor =
                prefs.edit().putString(PREFIX + id, state.toString());
        if (sync) editor.commit();
        else editor.apply();
    }

    static JSONObject read(Context context, String id) {
        if (id == null || id.isEmpty()) return null;
        SharedPreferences prefs =
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(PREFIX + id, "");
        if (raw == null || raw.isEmpty()) return null;
        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return null;
        }
    }

    static List<JSONObject> all(Context context) {
        SharedPreferences prefs =
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        List<JSONObject> out = new ArrayList<>();
        for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
            String key = entry.getKey();
            if (!key.startsWith(PREFIX)) continue;
            Object value = entry.getValue();
            if (!(value instanceof String)) continue;
            try {
                out.add(new JSONObject((String) value));
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    static void remove(Context context, String id) {
        if (id == null || id.isEmpty()) return;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .remove(PREFIX + id)
                .apply();
    }
}
