package app.daybook.collector;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

public final class MainActivity extends Activity {
    private EditText pairing;
    private TextView status;
    private Button sync;
    private Button toggle;
    private LinearLayout content;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        ScrollView scroll = new ScrollView(this); content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL); content.setPadding(32, 32, 32, 32); content.setBackgroundColor(Color.rgb(246,247,243));
        scroll.addView(content); setContentView(scroll);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> { view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom()); return insets; });
        text("SimonSealsAPI", 32); text("Your Pixel, connected.", 24);
        text("Track foreground app time automatically. Records stay on this phone until they sync to your server. No screenshots, messages, URLs, or keystrokes are collected.", 16);
        text("1. Pair this phone", 20);
        text("In the web dashboard, add a Pixel device and download its pairing file. Import that file below, or paste the pairing JSON.", 15);
        button("Import pairing file", v -> { Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.setType("*/*"); intent.addCategory(Intent.CATEGORY_OPENABLE); startActivityForResult(intent, 10); });
        pairing = new EditText(this); pairing.setHint("Paste pairing JSON"); pairing.setMinLines(3); pairing.setMaxLines(5);
        pairing.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS); content.addView(pairing);
        button("Save pairing", v -> savePairing(pairing.getText().toString()));
        text("2. Allow usage access", 20);
        text("Android requires you to allow Usage Access for SimonSealsAPI once. This lets SimonSealsAPI read app usage times.", 15);
        button("Open Usage Access settings", v -> startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:" + getPackageName()))));
        text("Automatic tracking", 20);
        text("Background sync is scheduled about every 15 minutes. Android may delay it to save battery. Keep background battery usage allowed in App settings. Opening SimonSealsAPI also syncs immediately.", 15);
        status = text("Not paired yet.", 16);
        sync = button("Sync now", v -> syncNow());
        toggle = button("Pause tracking", v -> {
            SharedPreferences prefs = Collector.settings(this);
            boolean enabled = !prefs.getBoolean("enabled", false);
            prefs.edit().putBoolean("enabled", enabled).apply();
            if (enabled) { resetCheckpoint(); SyncJob.schedule(this); syncNow(); } else SyncJob.cancel(this);
            refresh();
        });
        button("Open app settings", v -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
        text("To disconnect this phone, revoke its device key in your dashboard. To stop recording on this phone, pause tracking here or uninstall SimonSealsAPI.", 14);
    }
    private TextView text(String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(Color.rgb(36,52,45)); view.setPadding(0, 12, 0, 12); content.addView(view); return view;
    }
    private Button button(String label, View.OnClickListener action) { Button button = new Button(this); button.setText(label); button.setOnClickListener(action); content.addView(button); return button; }
    private void resetCheckpoint() {
        synchronized (Collector.class) {
            try (Store store = new Store(this)) { store.set("cursor", Long.toString(System.currentTimeMillis())); store.set("app", ""); }
        }
    }
    private void savePairing(String raw) {
        try {
            JSONObject config = Collector.validateConfig(raw);
            SharedPreferences prefs = Collector.settings(this);
            String old = prefs.getString("config", "");
            if (!old.isEmpty() && !new JSONObject(old).getString("device_id").equals(config.getString("device_id"))) {
                status.setText("This app already belongs to another device pairing. Clear SimonSealsAPI's app storage before pairing it as a different device; export/sync queued data first."); return;
            }
            prefs.edit().putString("config", config.toString()).putBoolean("enabled", true).apply();
            pairing.setText("");
            if (old.isEmpty()) resetCheckpoint();
            SyncJob.schedule(this); refresh(); syncNow();
        } catch (Exception e) { status.setText("Could not pair: " + e.getMessage()); }
    }
    @Override protected void onActivityResult(int request, int result, Intent intent) {
        super.onActivityResult(request, result, intent);
        if (request != 10 || result != RESULT_OK || intent == null || intent.getData() == null) return;
        try (InputStream input = getContentResolver().openInputStream(intent.getData())) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int size;
            while ((size = input.read(buffer)) != -1) { if (bytes.size() + size > 16384) throw new Exception("Pairing file is too large."); bytes.write(buffer, 0, size); }
            savePairing(bytes.toString("UTF-8"));
        } catch (Exception e) { status.setText("Could not import pairing: " + e.getMessage()); }
    }
    @Override public void onResume() {
        super.onResume(); if (status == null) return;
        refresh();
        if (Collector.settings(this).getBoolean("enabled", false) && Collector.permission(this)) { SyncJob.schedule(this); syncNow(); }
    }
    private void refresh() {
        SharedPreferences prefs = Collector.settings(this);
        String name = "Not paired";
        try { name = new JSONObject(prefs.getString("config", "")).optString("device_name", "Pixel"); } catch (Exception ignored) { }
        status.setText(name + "\nUsage access: " + (Collector.permission(this) ? "allowed" : "needed") + "\n" + prefs.getString("status", "Ready to pair.") + "\nLast sync: " + prefs.getString("last_success", "never"));
        boolean paired = !prefs.getString("config", "").isEmpty();
        toggle.setEnabled(paired); sync.setEnabled(paired);
        toggle.setText(prefs.getBoolean("enabled", false) ? "Pause tracking" : "Resume tracking");
    }
    private void syncNow() {
        if (!sync.isEnabled()) return;
        sync.setEnabled(false); status.setText("Collecting and syncing…");
        new Thread(() -> {
            Collector.run(getApplicationContext());
            runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) { sync.setEnabled(true); refresh(); } });
        }, "SimonSealsAPI manual sync").start();
    }
}
