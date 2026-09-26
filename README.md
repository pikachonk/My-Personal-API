# SimonSealsAPI

Renamed from Daybook. Existing database filenames, `DAYBOOK_*` configuration keys, Windows data directories, and Android package/signing identity are retained so existing installations and saved data remain compatible.

A personal dashboard and API with automatic screen-time collection across three Windows PCs and two Google Pixel phones. Water, work, gym, sleep, and custom activities also remain available.

## Automatic tracking

Each device needs a one-time installation and its own pairing file. After setup, no manual screen-time logging is required.

- **Windows:** foreground app sampling every five seconds; durable local SQLite queue; background HTTPS sync about every minute; automatic start at Windows sign-in. An optional Chrome extension records the active website's domain alongside app time.
- **Pixel / Android 10+:** companion APK uses Android Usage Access, stores readable foreground app names locally, and schedules background collection/sync about every 15 minutes. Android may delay jobs. No accessibility service, screenshots, message content, or keystrokes are collected.
- **Cloud:** password-protected dashboard, HTTPS, individual revocable device keys, retry deduplication, per-device daily totals, and an additional total that counts simultaneous usage only once.

**Start here: [cloud and device setup](CLOUD_SETUP.md).**

The cloud deployment uses **Cloudflare Workers + D1**, live at **https://simonsealsapi.dev**. The JavaScript Worker in `cloudflare/` serves the dashboard and implements the device upload protocol. The Python server remains available for local preview and development. Live login, upload, retry and revocation checks passed; physical-device installation and verification still need your PCs and Pixels. See [CLOUD_SETUP.md](CLOUD_SETUP.md) for your local password file and pairing instructions.

Release files in `release/` include `SimonSealsAPI-cloudflare.zip`, `SimonSealsAPI-windows.zip`, and `SimonSealsAPI.apk`. Follow [CLOUD_SETUP.md](CLOUD_SETUP.md) for cloud and device setup.

### Cloudflare development

```powershell
cd cloudflare
npm ci
npm test
npm run check
```

Tests use Cloudflare's local Workers runtime and isolated D1 databases. The dry run checks deployment packaging without creating remote resources. Dependencies include a local Node 22 runtime for npm scripts. Activity is stored in D1 after cloud deployment, not in this PC's SQLite file. Existing local data is not automatically imported.

## Preview locally

Python 3.12+ is the only server requirement:

```powershell
python server.py
```

Open http://localhost:8000. Data is stored in `data/daybook.db`. The local preview does not pair devices until a sync endpoint is configured; use the deployed cloud dashboard for your five devices.

For local HTTPS integration testing, OpenSSL (included with Git for Windows) can generate a paired certificate:

```powershell
python server.py --sync-url https://YOUR-PC-IP:8443
```

This leaves the dashboard on loopback and opens a write-only, authenticated HTTPS sync endpoint on port 8443. Pairing files include a certificate fingerprint for this mode. Cloud deployment uses normal public HTTPS certificate validation.

## Build and verify

```powershell
python -m unittest discover -s tests -v
node --check static/app.js
node --check static/login.js
python android/build.py
javac -d android/build/test-classes android/src/app/daybook/collector/SessionTracker.java android/tests/SessionTrackerTest.java
java -cp android/build/test-classes SessionTrackerTest
python scripts/package_release.py
```

The Android build requires a Windows JDK (Java 11+) and downloads checksum-verified Android API 35 SDK tools from Google. It produces a signed personal-use APK without Gradle or Android Studio. Its signing key is kept in `android/.tools/daybook-dev.jks`; preserve that key for updates. It is a development signing key, not a Play Store release key.

## Data and accuracy

- Old databases migrate in place; existing entries are retained.
- Local time boundaries, overnight sessions, and daylight-saving changes are handled in the dashboard.
- Device totals add usage across devices. The separate elapsed screen-time total merges overlapping intervals.
- Windows excludes lock screens, sleep gaps, and samples after five minutes without input. Passive video watching may therefore be excluded. Sampling is approximate.
- The optional Chrome extension reads only the active tab's domain, excludes incognito tabs, and stores no page paths, search terms, or titles. Website time is a breakdown of Windows Chrome time and is not added again to screen-time totals.
- Android measures foreground app usage, not a clone of Digital Wellbeing. Multi-window behavior, missed OS events, force-stop, or long background restrictions can cause differences or gaps. Collection begins after pairing; old phone history is not imported. Usage-event history is retained by Android only for a few days.
- Revoking a key stops uploads; pause/uninstall the collector to stop local recording. Queues survive restarts and retry, but clearing app data/uninstalling deletes unsent phone records.
- JSON export includes activity and device metadata, never device keys. SQLite and collector queues are not independently encrypted by SimonSealsAPI; device/server disk protection is managed by the operating system.
- Back up the cloud database using the steps in `CLOUD_SETUP.md`. JSON import is not implemented.

This is a single-user application. Cloudflare Free has request, CPU, database read/write and storage limits; monitor usage after connecting your devices.
