# Cloudflare and device setup

SimonSealsAPI now supports **Cloudflare Workers + D1** at **https://simonsealsapi.dev**. Workers serves the dashboard and API; D1 stores activity, paired devices, and login sessions. Your Windows collectors and Pixel APK use the same pairing/upload format.

**Deployed September 23, 2026:** open https://simonsealsapi.dev and sign in. Your generated dashboard password is in [data/cloudflare-dashboard-password.txt](data/cloudflare-dashboard-password.txt) in this workspace. That file is restricted to your Windows account and excluded from release ZIPs and version control. Save the password in your password manager. It is separate from your Cloudflare login.

The remote D1 database, password secret, Worker, and custom domain have been created. Live HTTPS checks passed for login/logout, manual activities, five temporary device pairings, a 200-event upload, retries, and revocation. Temporary test records were removed. Your physical devices still need pairing below.

The deployment steps below are retained for rebuilding or deploying from another computer. For your current installation, continue at **2. Pair three Windows PCs**. Do not recreate the database during normal updates.

## 1. Deploy to your Cloudflare account

### Sign in from PowerShell

Use the Cloudflare account that owns `simonsealsapi.dev`. In Cloudflare, confirm the domain is **Active**, and keep **Workers on the Free plan**. Domain registration and Workers billing are separate.

In this workspace, run:

```powershell
cd "C:\Users\pikac\Simon\My-Personal-API\cloudflare"
npm ci
npm run cf -- login
```

Wrangler opens a browser. Sign in and authorize it, then return to PowerShell. Do not paste passwords, API tokens, or OAuth callback URLs into chat. Check the selected account with:

```powershell
npm run cf -- whoami
```

The dependencies have already been installed in this workspace. On a fresh checkout, run `npm ci` first. The project includes a local Node 22 runtime for its npm scripts because this PC's system Node 21 is too old for current Wrangler; it does not replace your system Node. On another computer, install Node.js 22 or newer with npm first. If PowerShell blocks npm.ps1, use **npm.cmd** in these commands.

The release ZIPs are generated locally and are not included in the GitHub repository. To create them from a checkout, open PowerShell at the repository root, run `python android/build.py`, then `python scripts/package_release.py`. Extract `release/SimonSealsAPI-cloudflare.zip` and open PowerShell in its `cloudflare` subfolder. Otherwise, continue using the checked-out `cloudflare` folder.

### Confirm or create the persistent database

This repository is already configured to use the existing `simonsealsapi-db` database. For this deployment, check that it appears in the account's database list and keep the ID in `cloudflare/wrangler.jsonc`:

```powershell
npm run cf -- d1 list
```

Do not create a replacement database or run `configure-db` for the current deployment. Only create a database if you are intentionally setting up a separate deployment with a separate database.

```powershell
npm run cf -- d1 create simonsealsapi-db --location enam --update-config=false
```

The enam hint requests Eastern North America; it does not guarantee Canadian residency. Copy the returned **database_id** (UUID), then run this command with your actual ID:

```powershell
npm run configure-db -- YOUR-DATABASE-ID
```

For a separate deployment, this updates `cloudflare/wrangler.jsonc` to point to the new database. A database ID is an identifier, not a password. Never replace the configured ID for the current deployment. If Wrangler asks which account to use, choose the one containing your domain.

### Set your dashboard password

```powershell
npm run cf -- secret put ADMIN_PASSWORD
```

Enter a unique password of **at least 16 characters** into the terminal prompt. This is your SimonSealsAPI login password, not your Cloudflare password. Save it in your password manager. If Wrangler asks to create the simonsealsapi Worker, accept. The secret is stored by Cloudflare, not in the source code. The Worker refuses access if the secret is missing or too short.

### Deploy the app and connect your domain

```powershell
npm run deploy
```

This checks that the database ID and password secret are configured, builds the Worker, applies pending D1 migrations, then deploys the app and static dashboard. Accept the database migration and custom-domain prompts if shown for simonsealsapi-db and simonsealsapi.dev.

The configuration already declares **simonsealsapi.dev as a Workers Custom Domain**. Cloudflare creates its DNS record and manages the HTTPS certificate. The alternative workers.dev and preview URLs are disabled. See [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

If an existing DNS record or another application already occupies the root domain, inspect that record before accepting a replacement. Resolve only the conflicting record for simonsealsapi.dev; keep unrelated records such as email MX/TXT records. Do not enable a cache-everything rule for this app. API and authenticated dashboard responses use no-store.

Open **https://simonsealsapi.dev**, sign in, and verify:

1. You can log a water entry and see it after refreshing.
2. **Pair device** downloads a JSON file with server_url set to https://simonsealsapi.dev and an empty certificate_sha256 (normal public HTTPS validation).
3. Pair one Windows PC and confirm a real last-sync time and screen activity before installing the other four devices.
4. Sign out and confirm the dashboard requires login again.

The domain must finish HTTPS provisioning before collectors can connect. Do not add Cloudflare Access or browser challenges to /api/sync: collectors use their own bearer keys and cannot complete an interactive browser login.

### Free-plan limits

This deployment does not subscribe to a paid Workers plan. Keep your account on Free; check **Workers & Pages usage** and **D1 metrics/storage** after your devices have been running. Actual usage depends on app switching, dashboard views, and accumulated history.

As checked September 2026, Workers Free allows 100,000 requests/day and 10 ms CPU per invocation. D1 Free allows 5 million rows read/day, 100,000 rows written/day, and **500 MB per database** (5 GB total across the account). Index maintenance also counts toward writes, and usage is shared with your other apps. Since September 1, 2026, exceeding a D1 daily read or write limit causes queries to fail until the quota resets at midnight UTC. Reaching the storage limit can prevent inserts and schema changes until space is freed or the plan is changed. See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), and [D1 Free-plan enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).

Uploads use a three-statement database transaction for up to 200 events. Day queries use indexed time ranges; older chart days are cached in the browser for ten minutes. The selected day still refreshes about once a minute. Hosted CPU usage and real-world quotas need checking after deployment. If a daily limit is reached, affected requests can fail until it resets; collectors keep unacknowledged uploads queued locally. No history is automatically deleted. Review database growth and back up before approaching 500 MB.

## 2. Pair three Windows PCs

On the cloud dashboard, select **Pair device**, give the PC a distinct name, select **Windows PC**, and download its pairing JSON. Repeat separately for every PC; do not share one pairing between PCs.

On each PC:

1. Install Python 3.12 or later if needed.
2. Extract `SimonSealsAPI-windows.zip` and place that PC's pairing JSON nearby.
3. Open PowerShell in the extracted directory and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install_windows.ps1 -Config .\SimonSealsAPI-YOUR-DEVICE-ID.json
```

The installer copies the collector to `%LOCALAPPDATA%\Daybook\collector`, limits access to the pairing key, creates a per-user Startup shortcut, and starts a hidden collector. You do not need to keep a terminal open. Only one collector runs per Windows sign-in session.

The Windows account must be signed in. Sleep, shutdown, and the lock screen are excluded. The default five-minute idle cutoff also excludes long passive sessions such as video playback without input. Windows app names are recorded as process names; Chrome's website detail is an optional Chrome extension described below.

Records waiting for upload and rotating diagnostic logs are stored under `%LOCALAPPDATA%\Daybook\DEVICE-ID`. A failed network request keeps the records on disk. The cloud rejects repeated event IDs, so retries cannot duplicate the same session.

To disable future auto-start, delete **SimonSealsAPI Screen Time** from your Windows Startup folder (`shell:startup`). To stop a running collector, end its `pythonw.exe` process in Task Manager, verifying its command line points to SimonSealsAPI. Revoking the device in the dashboard stops uploads but does not stop local recording.

### Track active websites in Chrome

The Chrome extension records the domain of the active tab on a paired Windows PC. It does not record page paths, search terms, page titles, or browsing history. Incognito tabs and non-web pages are excluded. The Chrome `tabs` permission can be described by Chrome as access to browsing history; the extension uses it to inspect the active tab URL and keeps only its domain.

Use the original Windows pairing JSON for that PC. The dashboard cannot reveal an existing device key again; if you no longer have the file, create a new Windows pairing and update the Windows installer and Chrome extension to use that new key.

1. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
2. Choose **Load unpacked**. Select `collectors/chrome_extension` from the project checkout, or the `chrome-extension` folder from `SimonSealsAPI-windows.zip`.
3. Click the SimonSealsAPI extension icon, paste the same Windows pairing JSON used by the Windows installer, and choose **Connect this PC**. Approve Chrome's request to connect to your SimonSealsAPI server.
4. The extension starts tracking the active website in the focused Chrome window. Its popup shows connection status and lets you pause or resume website tracking.

The extension keeps unsent website sessions in the Chrome profile and retries them. Tracking is sampled about once a minute and uses the same five-minute inactivity cutoff as the Windows collector. It starts after setup; it cannot import past browsing activity. The domain breakdown is part of Chrome's app time, so it does not add extra minutes to the screen-time total. The Windows collector and extension use the same pairing: revoking that Windows key stops uploads from both. To stop local recording, pause the extension and stop or disable the Windows collector too.

## 3. Pair both Google Pixel phones

Create a separate **Google Pixel / Android** pairing for each phone in the cloud dashboard.

The APK is not included in this GitHub repository. From a fresh checkout, build it at the repository root with `python android/build.py`; this creates `android/build/SimonSealsAPI.apk`. See [android/README.md](android/README.md) for the JDK requirement. To package the local release files, run `python scripts/package_release.py` after building the APK.

On each Pixel:

1. Transfer `SimonSealsAPI.apk` to the phone and install it. Android may ask you to allow installation from the app opening the APK. The APK is built for Android 10 and later and signed for personal use.
2. Open SimonSealsAPI and import that phone's pairing JSON (or paste its JSON).
3. Tap **Open Usage Access settings** and allow SimonSealsAPI usage access.
4. Return to SimonSealsAPI. It syncs immediately, and then Android schedules periodic background jobs. Check that the cloud dashboard shows a recent sync for the phone.
5. In Android's app battery settings, allow background usage for SimonSealsAPI. If sync is consistently delayed, use the unrestricted option where available. The exact UI varies with Android version.

The app reads foreground app usage from Android's usage events. It records neither screen contents nor interactions. Data starts from pairing, and jobs are requested approximately every 15 minutes; Android can delay them during Doze, battery restrictions, or force-stop. A persisted job survives a normal reboot, but Android must be unlocked once. If you force-stop the app, reopen it to resume jobs. These are platform constraints, described in [UsageStatsManager](https://developer.android.com/reference/android/app/usage/UsageStatsManager) and [JobScheduler](https://developer.android.com/reference/android/app/job/JobInfo.Builder#setPeriodic(long)).

The app saves its upload queue in private app storage. Opening the app manually also triggers a sync, but routine collection does not require you to log individual sessions. A gap longer than Android's retained usage history cannot be reconstructed reliably. Use **Pause tracking** to stop collection. Clearing app storage or uninstalling deletes unsent records.

The APK has been compiled and signature-verified, and the foreground-session state machine has automated tests. The app still needs on-device verification on your two Pixels; no phones are connected to this workspace.

## 4. Understand the numbers

Every device card shows its daily app total and actual last successful upload. A paired device with no uploads is shown as waiting, not connected. The main screen-time number adds app time across devices. The line underneath merges overlapping app intervals, so 30 minutes using a phone while on a PC counts as 30 elapsed minutes and 60 device-minutes. App and website breakdowns are shown by device in the dashboard and journal. Website time is a detail within Windows Chrome time and is not counted twice.

To estimate work time automatically, open **Choose work apps & sites** on the Work card. Classify observed apps or website domains as **Work** or **Personal**; everything else remains unclassified. Start with dedicated work tools. Treat mixed-use email, chat, and browsers conservatively. The dashboard recalculates past days when you change a rule. Work website time needs the Chrome extension and is clipped to Chrome's foreground time; browser apps themselves cannot be marked Work. Overlapping work across devices and manually logged sessions counts once in the Work total.

## Backups and updates

The dashboard's **Export** button downloads readable JSON with all activity and device metadata, excluding credentials. Cloudflare exports are fetched in pages of 500 records; API clients must follow next_cursor via /api/export?cursor=... until it is null. The browser combines pages into one file. Concurrent additions/deletions can affect this export; use database backup/recovery for a consistent restore. JSON import is not implemented.

For a restorable database backup, run from cloudflare/:

```powershell
New-Item -ItemType Directory -Force ..\backups | Out-Null
$backupStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
npm run cf -- d1 export simonsealsapi-db --remote --output "../backups/simonsealsapi-$backupStamp.sql"
```

Treat SQL backups as private: they contain activity, hashed device keys, and session records. Store another copy somewhere safe. D1 Free also provides seven days of [Time Travel recovery](https://developers.cloudflare.com/d1/reference/time-travel/). Check [D1 import/export guidance](https://developers.cloudflare.com/d1/best-practices/import-export-data/) before restoring. For an SQL restore, use a new empty D1 database, import with d1 execute NEW-DATABASE --remote --file BACKUP.sql, verify tables, indexes and the two triggers, clear the sessions table, then point the Worker binding at the restored database. Preserve the original until recovery is verified. Do not apply the initial migration over already-restored tables; the backup includes migration history.

Code updates: run npm ci if dependencies changed, npm test, then npm run deploy. The same D1 database remains in place. To change the login password, rerun npm run cf -- secret put ADMIN_PASSWORD. Existing sessions immediately become invalid; device pairing keys are unaffected. Sessions otherwise expire after 12 hours and survive Worker restarts/deployments.

Keep android/.tools/daybook-dev.jks if rebuilding the APK so Android accepts updates. Existing local Python/SQLite data is not automatically copied into D1; this cloud deployment starts empty. Do not upload data/daybook.db directly into D1 because its schema differs.

## Local Cloudflare testing

From cloudflare/:

```powershell
npm test
npm run check
npm run cf -- d1 migrations apply simonsealsapi-db --local
Copy-Item .dev.vars.example .dev.vars
# Edit .dev.vars to choose a local-only password before starting.
npm run dev
```

Open http://localhost:8787. Local D1 data stays under .wrangler/ and is separate from production. Local HTTP pairings are for API development only; actual collectors require the public HTTPS deployment. npm test runs isolated Workers/D1 integration tests and does not contact the live app. npm run check builds without deploying. These do not prove hosted free-tier CPU limits or physical-device behavior; complete the live checks above after deploying.
