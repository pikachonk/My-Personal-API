package app.daybook.collector;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.database.sqlite.SQLiteDatabase;
import android.os.Process;
import org.json.JSONArray;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import java.net.URL;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.text.DateFormat;
import java.util.Date;

final class Collector {
    static SharedPreferences settings(Context c) { return c.getSharedPreferences("daybook", Context.MODE_PRIVATE); }
    static boolean permission(Context c) {
        AppOpsManager ops = (AppOpsManager)c.getSystemService(Context.APP_OPS_SERVICE);
        return ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), c.getPackageName()) == AppOpsManager.MODE_ALLOWED;
    }
    static JSONObject validateConfig(String raw) throws Exception {
        JSONObject config = new JSONObject(raw);
        URL url = new URL(config.getString("server_url"));
        if (!url.getProtocol().equals("https") || url.getHost().isEmpty() || url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null || !(url.getPath().isEmpty() || url.getPath().equals("/"))) throw new Exception("The server must be an HTTPS address.");
        if (!config.optString("platform").equals("android")) throw new Exception("Create a Pixel / Android pairing in your dashboard.");
        if (config.getString("token").isEmpty() || config.getString("device_id").isEmpty()) throw new Exception("Pairing key is missing.");
        String pin = config.optString("certificate_sha256");
        if (!pin.isEmpty() && !pin.matches("[0-9a-f]{64}")) throw new Exception("Invalid server certificate fingerprint.");
        return config;
    }
    static synchronized String run(Context context) {
        SharedPreferences prefs = settings(context);
        if (!prefs.getBoolean("enabled", false)) return "Collection is paused.";
        if (!permission(context)) return saveStatus(prefs, "Enable Usage Access to start automatic tracking.");
        try (Store store = new Store(context)) {
            JSONObject config = validateConfig(prefs.getString("config", ""));
            collect(context, store);
            try {
                for (int i=0;i<4 && !Thread.currentThread().isInterrupted();i++) {
                    JSONArray batch = store.batch();
                    send(config, batch);
                    store.acknowledge(batch);
                    if (batch.length() < 200) break;
                }
                prefs.edit().putString("last_success", DateFormat.getDateTimeInstance().format(new Date())).apply();
                return saveStatus(prefs, "Connected. " + store.count() + " sessions waiting to sync.");
            } catch (Exception e) {
                return saveStatus(prefs, "Saved on this phone; " + store.count() + " sessions waiting. " + e.getMessage());
            }
        } catch (Exception e) { return saveStatus(prefs, "Tracking needs attention: " + e.getMessage()); }
    }
    private static String saveStatus(SharedPreferences prefs, String value) { prefs.edit().putString("status", value).apply(); return value; }
    private static void collect(Context context, Store store) throws Exception {
        long end = System.currentTimeMillis() - 2000; // Avoid an event being written while we checkpoint its timestamp.
        long begin = Long.parseLong(store.get("cursor", Long.toString(end)));
        if (begin > end) { // Wall clock moved backwards: discard open state instead of inventing time.
            store.set("cursor", Long.toString(end)); store.set("app", ""); return;
        }
        UsageStatsManager manager = (UsageStatsManager)context.getSystemService(Context.USAGE_STATS_SERVICE);
        UsageEvents events = manager.queryEvents(begin, end);
        if (events == null) throw new Exception("Unlock the phone once after restarting.");
        SQLiteDatabase db = store.getWritableDatabase(); db.beginTransaction();
        try {
            SessionTracker tracker = new SessionTracker((pkg, start, finish) -> store.add(appLabel(context, pkg), start, finish));
            // Android retains event history for only a few days. Don't bridge an unobserved long gap.
            if (end - begin <= 48L * 3600000) {
                tracker.app = store.get("app", ""); tracker.activity = store.get("activity", "");
                tracker.start = Long.parseLong(store.get("start", Long.toString(begin)));
            }
            UsageEvents.Event event = new UsageEvents.Event();
            while (events.hasNextEvent()) {
                events.getNextEvent(event);
                if (event.getTimeStamp() >= begin && event.getTimeStamp() < end)
                    tracker.event(event.getEventType(), event.getPackageName(), event.getClassName(), event.getTimeStamp());
            }
            tracker.checkpoint(end);
            store.set("app", tracker.app); store.set("activity", tracker.activity); store.set("start", Long.toString(tracker.start));
            store.set("cursor", Long.toString(end));
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    private static String appLabel(Context context, String packageName) {
        try {
            ApplicationInfo info = context.getPackageManager().getApplicationInfo(packageName, 0);
            CharSequence label = info.loadLabel(context.getPackageManager());
            return label == null || label.length() == 0 ? packageName : label.toString();
        } catch (PackageManager.NameNotFoundException ignored) { return packageName; }
    }
    private static void send(JSONObject config, JSONArray events) throws Exception {
        String origin = config.getString("server_url").replaceAll("/+$", "");
        HttpsURLConnection connection = (HttpsURLConnection)new URL(origin + "/api/sync").openConnection();
        String pin = config.optString("certificate_sha256");
        if (!pin.isEmpty()) {
            SSLContext tls = SSLContext.getInstance("TLS");
            tls.init(null, new TrustManager[]{new X509TrustManager() {
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { throw new CertificateException("Client certificates unsupported"); }
                public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                    try {
                        if (chain.length == 0) throw new Exception("Missing server certificate");
                        chain[0].checkValidity();
                        byte[] digest = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                        StringBuilder value = new StringBuilder(); for (byte b : digest) value.append(String.format("%02x", b & 255));
                        if (!MessageDigest.isEqual(pin.getBytes(StandardCharsets.US_ASCII), value.toString().getBytes(StandardCharsets.US_ASCII))) throw new Exception("Server certificate changed. Pair again.");
                    } catch (Exception e) { throw new CertificateException(e); }
                }
            }}, null);
            connection.setSSLSocketFactory(tls.getSocketFactory());
            connection.setHostnameVerifier((host, session) -> true); // Identity is the exact paired certificate above.
        }
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
            connection.setRequestMethod("POST"); connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + config.getString("token"));
            byte[] body = new JSONObject().put("device_id", config.getString("device_id")).put("events", events).toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (java.io.OutputStream out = connection.getOutputStream()) { out.write(body); }
            int code = connection.getResponseCode();
            if (code != 200) throw new Exception(code == 401 ? "Pairing revoked or invalid; pair again." : "Server returned HTTP " + code + ". Will retry automatically.");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[4096]; int size;
                while ((size = input.read(buffer)) != -1) { if (bytes.size() + size > 16384) throw new Exception("Unexpected response size"); bytes.write(buffer, 0, size); }
            }
            JSONObject response = new JSONObject(bytes.toString("UTF-8"));
            if (response.getInt("accepted") != events.length()) throw new Exception("Server did not acknowledge the full batch.");
        } finally { connection.disconnect(); }
    }
}
