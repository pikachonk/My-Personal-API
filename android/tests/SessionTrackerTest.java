import app.daybook.collector.SessionTracker;
import java.util.ArrayList;
import java.util.List;

public class SessionTrackerTest {
    public static void main(String[] args) {
        List<String> events = new ArrayList<>();
        SessionTracker t = new SessionTracker((app, start, end) -> events.add(app + ":" + start + ":" + end));
        t.event(1, "chrome", "Main", 100); t.event(1, "chrome", "Tab", 200);
        t.event(2, "chrome", "Main", 201); // Old activity pauses after the new one resumes.
        t.checkpoint(300); t.event(1, "youtube", "Video", 400); t.event(16, null, null, 500);
        t.checkpoint(600); // Screen off must not add time.
        if (!events.toString().equals("[chrome:100:300, chrome:300:400, youtube:400:500]")) throw new AssertionError(events);
        t.event(1, "maps", "Main", 700); t.event(27, null, null, 1000); t.checkpoint(1200);
        if (events.size() != 3) throw new AssertionError("Counted a restart gap");
        t.event(1, "messages", "Main", 1300); t.event(17, null, null, 1400); t.checkpoint(1500);
        if (!events.get(3).equals("messages:1300:1400")) throw new AssertionError("Counted locked time");
        System.out.println("Android session tracker tests passed.");
    }
}
