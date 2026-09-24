package app.daybook.collector;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;
import java.util.UUID;

final class Store extends SQLiteOpenHelper {
    Store(Context context) { super(context, "daybook.db", null, 1); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        db.execSQL("CREATE TABLE pending (id TEXT PRIMARY KEY, app TEXT NOT NULL, started INTEGER NOT NULL, ended INTEGER NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { }
    String get(String key, String fallback) {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT value FROM state WHERE key=?", new String[]{key})) {
            return c.moveToFirst() ? c.getString(0) : fallback;
        }
    }
    void set(String key, String value) {
        ContentValues values = new ContentValues(); values.put("key", key); values.put("value", value);
        getWritableDatabase().insertWithOnConflict("state", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }
    void add(String app, long start, long end) {
        if (end <= start) return;
        // Keep sessions within the server's maximum duration even after extended scheduler delays.
        for (long cursor = start; cursor < end; cursor += 86400000L) {
            ContentValues values = new ContentValues(); values.put("id", UUID.randomUUID().toString());
            values.put("app", app); values.put("started", cursor); values.put("ended", Math.min(end, cursor + 86400000L));
            getWritableDatabase().insertOrThrow("pending", null, values);
        }
    }
    JSONArray batch() throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT id,app,started,ended FROM pending ORDER BY started LIMIT 200", null)) {
            while (c.moveToNext()) {
                JSONObject event = new JSONObject(); event.put("event_id", c.getString(0)); event.put("app", c.getString(1));
                event.put("started_at", Instant.ofEpochMilli(c.getLong(2)).toString());
                event.put("ended_at", Instant.ofEpochMilli(c.getLong(3)).toString()); result.put(event);
            }
        }
        return result;
    }
    void acknowledge(JSONArray batch) throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            for (int i=0;i<batch.length();i++) db.delete("pending", "id=?", new String[]{batch.getJSONObject(i).getString("event_id")});
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    int count() {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM pending", null)) { c.moveToFirst(); return c.getInt(0); }
    }
}
