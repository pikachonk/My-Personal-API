# SimonSealsAPI for Google Pixel

The companion uses Android's UsageStatsManager and JobScheduler. It needs Android 10+ and one-time Usage Access permission. Pair it using a separate Android pairing JSON from your cloud dashboard. The UI imports that file through Android's file picker.

The app records foreground app intervals, closes sessions on screen-off, lock, and shutdown events, and persists a cursor and pending uploads in one SQLite transaction. Upload acknowledgements remove pending records only after server acceptance. No Accessibility API or screen recording permission is used.

Jobs are requested every 15 minutes, persist across reboot, and can be delayed by Android's power management. Collection starts at pairing. It measures foreground usage rather than precisely reproducing Digital Wellbeing. Activity lifecycle/multi-window behavior and gaps in retained OS history may cause differences. Pause/resume intentionally excludes paused time. Uninstalling or clearing app storage removes unsent records.

## Build on Windows

With a JDK (Java 11+) and Python 3.12+ installed, run from the project root:

```powershell
python android/build.py
```

The script downloads official API 35 SDK archives, checks their published SHA-1 checksums, compiles Java, converts to DEX, packages, aligns, signs, and verifies `android/build/SimonSealsAPI.apk`. Dependencies are stored only under `android/.tools` and do not change your global Android SDK configuration. No emulator or connected phone is required for the build.

Preserve `.tools/daybook-dev.jks` to sign future updates with the same development key. This personal-use APK is not prepared for Play Store distribution. A physical Pixel test is still required to verify installation, permission flow, background scheduling, reboot, and cloud sync on your phones.

## Session logic test

```powershell
javac -d android/build/test-classes android/src/app/daybook/collector/SessionTracker.java android/tests/SessionTrackerTest.java
java -cp android/build/test-classes SessionTrackerTest
```

Official references: [usage events](https://developer.android.com/reference/android/app/usage/UsageEvents.Event), [usage access and retention](https://developer.android.com/reference/android/app/usage/UsageStatsManager), [periodic job scheduling](https://developer.android.com/reference/android/app/job/JobInfo.Builder#setPeriodic(long)).
