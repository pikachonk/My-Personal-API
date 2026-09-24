"""Package the cloud server, Windows collector, and already-built Pixel APK, without personal data."""
import hashlib
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
release = ROOT / "release"
release.mkdir(exist_ok=True)
cloud = ["Dockerfile", ".dockerignore", "compose.yaml", "Caddyfile", ".env.example", "server.py", "device_sync.py", "CLOUD_SETUP.md", "VM_SETUP.md"]
cloud += [path.relative_to(ROOT).as_posix() for path in (ROOT / "static").iterdir() if path.is_file()]
with zipfile.ZipFile(release / "SimonSealsAPI-cloud.zip", "w", zipfile.ZIP_DEFLATED) as bundle:
    for name in cloud:
        bundle.write(ROOT / name, "SimonSealsAPI-cloud/" + name)
with zipfile.ZipFile(release / "SimonSealsAPI-windows.zip", "w", zipfile.ZIP_DEFLATED) as bundle:
    for name in ("windows_screen.py", "sync_client.py", "install_windows.ps1"):
        bundle.write(ROOT / "collectors" / name, name)
    extension = ROOT / "collectors" / "chrome_extension"
    for path in extension.rglob("*"):
        if path.is_file():
            bundle.write(path, "chrome-extension/" + path.relative_to(extension).as_posix())
    bundle.write(ROOT / "CLOUD_SETUP.md", "SETUP.md")
worker = ["README.md", "CLOUD_SETUP.md", "VM_SETUP.md", "cloudflare/package.json", "cloudflare/package-lock.json",
          "cloudflare/wrangler.jsonc", "cloudflare/.dev.vars.example"]
for directory in ("cloudflare/src", "cloudflare/migrations", "cloudflare/scripts", "cloudflare/tests", "static"):
    worker += [p.relative_to(ROOT).as_posix() for p in (ROOT / directory).rglob("*") if p.is_file()]
with zipfile.ZipFile(release / "SimonSealsAPI-cloudflare.zip", "w", zipfile.ZIP_DEFLATED) as bundle:
    for name in worker:
        bundle.write(ROOT / name, "SimonSealsAPI-cloudflare/" + name)
apk = ROOT / "android" / "build" / "SimonSealsAPI.apk"
if not apk.exists():
    raise SystemExit("Build the Pixel app first: python android/build.py")
shutil.copyfile(apk, release / "SimonSealsAPI.apk")
shutil.copyfile(ROOT / "CLOUD_SETUP.md", release / "SETUP.md")
names = ("SimonSealsAPI-cloudflare.zip", "SimonSealsAPI-cloud.zip", "SimonSealsAPI-windows.zip", "SimonSealsAPI.apk", "SETUP.md")
(release / "SHA256SUMS.txt").write_text("\n".join(hashlib.sha256((release / name).read_bytes()).hexdigest() + "  " + name for name in names) + "\n")
print("Release ready: " + str(release))
