package app.daybook.collector;

/** Pure Java usage-event state machine. One foreground app, excluding lock/screen-off time. */
public final class SessionTracker {
    public interface Sink { void add(String app, long start, long end); }
    public String app = "";
    public String activity = "";
    public long start;
    private final Sink sink;
    public SessionTracker(Sink sink) { this.sink = sink; }
    private void finish(long time) {
        if (!app.isEmpty() && time > start) sink.add(app, start, time);
        app = ""; activity = ""; start = 0;
    }
    public void event(int type, String pkg, String cls, long time) {
        pkg = pkg == null ? "" : pkg;
        cls = cls == null ? "" : cls;
        if (type == 1 && !pkg.isEmpty()) { // ACTIVITY_RESUMED
            if (!app.equals(pkg)) { finish(time); app = pkg; start = time; }
            activity = cls;
        } else if ((type == 2 || type == 23) && app.equals(pkg) && (activity.equals(cls) || cls.isEmpty())) {
            finish(time); // ACTIVITY_PAUSED / STOPPED for the current activity
        } else if (type == 16 || type == 17 || type == 26) {
            finish(time); // SCREEN_NON_INTERACTIVE, KEYGUARD_SHOWN, DEVICE_SHUTDOWN
        } else if (type == 27) {
            // An unmatched session across a restart has no trustworthy end timestamp.
            app = ""; activity = ""; start = 0;
        }
    }
    public void checkpoint(long end) {
        if (!app.isEmpty() && end > start) { sink.add(app, start, end); start = end; }
    }
}
