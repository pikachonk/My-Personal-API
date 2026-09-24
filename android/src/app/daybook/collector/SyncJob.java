package app.daybook.collector;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

public final class SyncJob extends JobService {
    private Thread worker;
    private volatile boolean stopped;
    static void schedule(Context context) {
        JobScheduler scheduler = (JobScheduler)context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler.getPendingJob(1) == null) scheduler.schedule(new JobInfo.Builder(1, new ComponentName(context, SyncJob.class))
            .setPeriodic(15 * 60 * 1000L).setPersisted(true).build());
    }
    static void cancel(Context context) { ((JobScheduler)context.getSystemService(Context.JOB_SCHEDULER_SERVICE)).cancel(1); }
    @Override public boolean onStartJob(JobParameters params) {
        stopped = false;
        worker = new Thread(() -> { Collector.run(getApplicationContext()); if (!stopped) jobFinished(params, false); }, "SimonSealsAPI sync");
        worker.start(); return true;
    }
    @Override public boolean onStopJob(JobParameters params) { stopped = true; if (worker != null) worker.interrupt(); return true; }
}
