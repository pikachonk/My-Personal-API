"""Build the Pixel companion APK on Windows using a JDK and official Android SDK tools."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / ".tools"
PACKAGES = {
    "platform": ("platform-35_r02.zip", "0bb560a90a7a2cbd0dd8348224d518b638fe7949"),
    "build-tools": ("build-tools_r35_windows.zip", "af059bb67cf7786f45ee0db85e2d24985df1b4b6"),
}


def prepare():
    TOOLS.mkdir(parents=True, exist_ok=True)
    for name, (filename, checksum) in PACKAGES.items():
        destination = TOOLS / name
        if (destination / ".ready").exists():
            continue
        archive = TOOLS / filename
        if not archive.exists() or hashlib.sha1(archive.read_bytes()).hexdigest() != checksum:
            print("Downloading official Android SDK: " + filename, flush=True)
            urllib.request.urlretrieve("https://dl.google.com/android/repository/" + filename, archive)
        if hashlib.sha1(archive.read_bytes()).hexdigest() != checksum:
            raise RuntimeError("Android SDK checksum mismatch: " + filename)
        destination.mkdir(exist_ok=True)
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(destination)
        (destination / ".ready").touch()
    return next((TOOLS / "platform").rglob("android.jar")), next((TOOLS / "build-tools").rglob("aapt2.exe")).parent


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def build():
    android_jar, binaries = prepare()
    javac, java, keytool = [shutil.which(name) for name in ("javac", "java", "keytool")]
    if not all((javac, java, keytool)):
        raise RuntimeError("Install a JDK (Java 11 or later) with javac, java, and keytool on PATH.")
    output = ROOT / "build"
    classes, dex = output / "classes", output / "dex"
    classes.mkdir(parents=True, exist_ok=True)
    dex.mkdir(exist_ok=True)
    run(javac, "-encoding", "UTF-8", "--release", "8", "-classpath", android_jar,
        "-d", classes, *sorted((ROOT / "src").rglob("*.java")))
    with zipfile.ZipFile(output / "classes.jar", "w") as archive:
        for source in classes.rglob("*.class"):
            archive.write(source, source.relative_to(classes).as_posix())
    run(java, "-cp", binaries / "lib" / "d8.jar", "com.android.tools.r8.D8", "--lib", android_jar,
        "--min-api", "29", "--output", dex, output / "classes.jar")
    run(binaries / "aapt2.exe", "link", "-I", android_jar, "--manifest", ROOT / "AndroidManifest.xml",
        "-o", output / "unsigned.apk", "--min-sdk-version", "29", "--target-sdk-version", "35")
    with zipfile.ZipFile(output / "unsigned.apk", "a", compression=zipfile.ZIP_DEFLATED) as archive:
        for source in dex.glob("*.dex"):
            archive.write(source, source.name)
    run(binaries / "zipalign.exe", "-f", "4", output / "unsigned.apk", output / "aligned.apk")
    signing_key = TOOLS / "daybook-dev.jks"
    if not signing_key.exists():
        run(keytool, "-genkeypair", "-keystore", signing_key, "-storepass", "android", "-keypass", "android",
            "-alias", "daybook", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
            "-dname", "CN=SimonSealsAPI Personal Build", "-noprompt")
    signer = binaries / "lib" / "apksigner.jar"
    run(java, "-jar", signer, "sign", "--ks", signing_key, "--ks-key-alias", "daybook", "--ks-pass", "pass:android",
        "--key-pass", "pass:android", "--out", output / "SimonSealsAPI.apk", output / "aligned.apk")
    run(java, "-jar", signer, "verify", "--verbose", output / "SimonSealsAPI.apk")
    print("APK ready: " + str(output / "SimonSealsAPI.apk"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare", action="store_true")
    if parser.parse_args().prepare:
        prepare()
    else:
        build()
