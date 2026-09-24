# Optional Linux VM deployment

Cloudflare is now the main deployment path; start with [CLOUD_SETUP.md](CLOUD_SETUP.md). This document preserves the optional Docker/Azure instructions.

## 1. Deploy your private dashboard

For your Azure for Students subscription, use the Azure steps below. The existing package runs on an Ubuntu VM with Docker; no application rewrite is needed. No Azure resources have been created from this workspace.

### Azure for Students: create the server

Once the subscription is activated, open [portal.azure.com](https://portal.azure.com/) and choose **Virtual machines → Create → Azure virtual machine**. Use these settings:

| Field | Choice |
|---|---|
| Subscription | Azure for Students |
| Resource group | Create `simonsealsapi-rg` |
| Virtual machine name | `simonsealsapi` |
| Region | Canada Central if your subscription offers an eligible size there; otherwise another available region |
| Availability options | No infrastructure redundancy required |
| Image | Canonical Ubuntu Server 24.04 LTS, x64, without paid software |
| Size | `Standard_B1s` or `Standard_B2ats_v2`, if available and covered by your subscription's free allowance |
| Security type | Use Standard if the selected B-series size does not support Trusted Launch |
| Authentication type | SSH public key |
| Username | `azureuser` |
| SSH public key source | Use existing public key |
| Inbound ports | SSH 22, HTTP 80, HTTPS 443 |
| OS disk | A small persistent managed disk; check its separate estimate and free allowance |
| Additional services | No Bastion, NAT gateway, load balancer, or paid monitoring add-ons are needed for this setup |
| Advanced / custom data | Leave blank |

Your existing public key is `C:\Users\pikac\key.pub`. On your Windows PC, copy it with:

```powershell
Get-Content "C:\Users\pikac\key.pub" | Set-Clipboard
```

Paste that into Azure's public-key field. Keep `C:\Users\pikac\key` on your PC; it is the private key. If the portal does not accept the key, keep both files and check the exact validation message before replacing anything.

Select **Review + create** and inspect the estimated cost before creating the VM. An eligible VM allowance does not make every associated resource free: the public IP and disk can consume credits. Region and size availability depend on the subscription. If the listed small sizes are unavailable, check another region instead of accepting an expensive default size.

Microsoft documents the [student offer](https://azure.microsoft.com/en-us/free/students/), [eligible free VM sizes](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/create-free-services), and [portal creation process](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/quick-create-portal). A budget alert in Cost Management is useful for tracking credit consumption, but an alert is not an automatic spending cutoff.

### Get an address without buying a domain

After the VM is created, open its **Public IP address** resource, then **Configuration**, and set a unique **DNS name label**, such as `simonsealsapi-your-unique-suffix`. Save and copy the complete DNS name Azure displays. It will be under `cloudapp.azure.com`; use the displayed value rather than guessing it. This avoids a separate domain purchase. The public IP itself is still an Azure resource with its own pricing.

The [Azure public IP documentation](https://learn.microsoft.com/en-us/azure/virtual-network/ip-services/public-ip-addresses) describes DNS labels. This public hostname can be used for the dashboard and HTTPS certificate. Set `DAYBOOK_DOMAIN` to it later, without `https://`. The older `DAYBOOK_*` configuration names are retained for compatibility.

In the VM's networking rules, allow inbound TCP 80 and 443 from the Internet and restrict SSH 22 to your own public IP where practical. Keep port 8000 private. The configured public IP provides the outbound connection for Docker image downloads; this deployment does not require a separate NAT gateway.

### Upload the package and connect

Run these commands in Windows PowerShell, replacing `SERVER_IP` with the VM's public IPv4 address:

```powershell
cd "C:\Users\pikac\Simon\My Personal API"
scp -i "C:\Users\pikac\key" .\release\SimonSealsAPI-cloud.zip azureuser@SERVER_IP:~/
ssh -i "C:\Users\pikac\key" azureuser@SERVER_IP
```

After SSH connects, commands run on the Ubuntu VM. Install Docker Engine and the Compose plugin from Docker's official Ubuntu repository:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl unzip nano
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker compose version
unzip SimonSealsAPI-cloud.zip
cd SimonSealsAPI-cloud
cp .env.example .env
nano .env
```

These repository commands specifically target Ubuntu **24.04** (`noble`). For another Ubuntu release, follow the [official Docker installation instructions](https://docs.docker.com/engine/install/ubuntu/).

In `.env`, enter your full Azure DNS hostname and a unique password of at least 16 characters:

```dotenv
DAYBOOK_DOMAIN=YOUR-AZURE-DNS-HOSTNAME
DAYBOOK_ADMIN_PASSWORD='YOUR-UNIQUE-PASSWORD-AT-LEAST-16-CHARACTERS'
```

Save with **Ctrl+O**, **Enter**, then exit with **Ctrl+X**. Start the application:

```sh
chmod 600 .env
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs --tail=100
```

Open `https://YOUR-AZURE-DNS-HOSTNAME`, sign in, and continue with device pairing below. The Compose volume keeps records across container restarts on the VM's persistent disk. Keep backups before deleting or replacing the VM or disk. Use `sudo` with the Docker commands elsewhere in this guide when connected as `azureuser`.

### Other Linux providers

The equivalent setup on another provider requires Docker Engine and Compose, persistent disk storage, and a public DNS hostname. The general steps are:

1. Point the domain's DNS A record at the server's IPv4 address. Only add an AAAA record if the server is reachable over IPv6 too.
2. Allow inbound TCP ports 80 and 443. Keep the Python application's port 8000 private; the Compose file does not publish it.
3. Extract `SimonSealsAPI-cloud.zip` on the server and enter its `SimonSealsAPI-cloud` directory.
4. Copy `.env.example` to `.env`. Set `DAYBOOK_DOMAIN` to your hostname without `https://` and set a unique `DAYBOOK_ADMIN_PASSWORD` of at least 16 characters. Treat `.env` as private. If a password contains `$`, single-quote it in the `.env` file to preserve it literally.
5. Run:

```sh
docker compose up -d --build
docker compose logs --tail=100
```

Open `https://YOUR-DOMAIN` and sign in. Caddy obtains and renews the HTTPS certificate when DNS and ports are ready. See [Caddy's HTTPS requirements](https://caddyserver.com/docs/automatic-https) and [Compose environment-file rules](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).

The API, dashboard, and device uploads share this HTTPS address. Devices can sync on home Wi-Fi or while away. Dashboard sessions last 12 hours and are invalidated by a server restart. Password changes require recreating the application container (`docker compose up -d --force-recreate daybook`).

This workspace has no Docker installation, so the container stack has not been launched here. After deployment, check login, pair one device, and confirm its first sync before installing on the other four.

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

The Windows account must be signed in. Sleep, shutdown, and the lock screen are excluded. The default five-minute idle cutoff also excludes long passive sessions such as video playback without input. Chrome appears as one app; site-by-site browsing is not captured.

Records waiting for upload and rotating diagnostic logs are stored under `%LOCALAPPDATA%\Daybook\DEVICE-ID`. A failed network request keeps the records on disk. The cloud rejects repeated event IDs, so retries cannot duplicate the same session.

To disable future auto-start, delete **SimonSealsAPI Screen Time** from your Windows Startup folder (`shell:startup`). To stop a running collector, end its `pythonw.exe` process in Task Manager, verifying its command line points to SimonSealsAPI. Revoking the device in the dashboard stops uploads but does not stop local recording.

## 3. Pair both Google Pixel phones

Create a separate **Google Pixel / Android** pairing for each phone in the cloud dashboard.

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

Every device card shows its daily total and actual last successful upload. A paired device with no uploads is shown as waiting, not connected. The main screen-time number adds all devices. The line underneath merges overlapping time, so 30 minutes using a phone while on a PC counts as 30 elapsed minutes and 60 device-minutes. Screen time is grouped by app and device in the journal.

## Backups and updates

Export JSON from the dashboard for readable activity history. For a restorable SQLite backup, stop the application while copying its database (Caddy can remain running):

```sh
docker compose stop daybook
docker compose cp daybook:/data/daybook.db ./daybook-backup.db
docker compose start daybook
```

The database contains hashed device keys and device metadata. Preserve it when moving servers; use the same domain so installed collectors keep working. For a restore, stop SimonSealsAPI, copy the backup into `/data/daybook.db` in the container volume, ensure the file is owned by UID/GID 10001, and start SimonSealsAPI. Retain a copy of the previous database until recovery is verified. Do not remove Docker volumes during an ordinary update.

Deploy code updates with `docker compose up -d --build`. Keep cloud credentials out of version control. Preserve `android/.tools/daybook-dev.jks` locally if rebuilding the APK so Android accepts an in-place update.
