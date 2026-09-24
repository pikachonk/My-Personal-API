"""Automatic Windows app screen time with durable, paired cloud sync."""
import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path, PureWindowsPath
import sys
import threading
import time
try:
    from .sync_client import Outbox, load_config
except ImportError:
    from sync_client import Outbox, load_config


class WindowsActivity:
    def __init__(self):
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.user32.GetForegroundWindow.restype = wintypes.HWND
        self.user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel32.OpenProcess.restype = wintypes.HANDLE
        self.kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        self.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel32.GetTickCount.restype = wintypes.DWORD

    def foreground(self):
        class LastInput(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]
        info = LastInput()
        info.cbSize = ctypes.sizeof(info)
        if not self.user32.GetLastInputInfo(ctypes.byref(info)):
            return None
        idle_ms = (self.kernel32.GetTickCount() - info.dwTime) & 0xFFFFFFFF
        if idle_ms >= 300000:
            return None
        window = self.user32.GetForegroundWindow()
        if not window:
            return None
        pid = wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
        handle = self.kernel32.OpenProcess(0x1000, False, pid.value)
        if not handle:
            return None
        try:
            size = wintypes.DWORD(32768)
            buffer = ctypes.create_unicode_buffer(size.value)
            if self.kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                name = PureWindowsPath(buffer.value).name
                return None if name.lower() in {"lockapp.exe", "logonui.exe"} else name
        finally:
            self.kernel32.CloseHandle(handle)
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True, help="Pairing JSON downloaded from the dashboard")
    parser.add_argument("--check", action="store_true", help="Verify cloud connection without collecting activity")
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("This collector requires Windows.")
    config = load_config(args.config)
    state = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Daybook" / config["device_id"]
    state.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(state / "collector.log", maxBytes=250000, backupCount=2)
    logging.basicConfig(level=logging.INFO, handlers=[handler], format="%(asctime)s %(message)s")
    # Prevent two startup instances from counting the same PC twice.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    mutex = kernel.CreateMutexW(None, False, "Local\\DaybookScreenCollector")
    if not mutex or ctypes.get_last_error() == 183:
        logging.info("A collector is already running.")
        return
    outbox = Outbox(state / "outbox.db")
    if args.check:
        outbox.flush(config)
        print("Cloud connection verified.")
        return
    activity = WindowsActivity()
    stop = threading.Event()

    def upload():
        while not stop.is_set():
            try:
                outbox.flush(config)
                logging.info("Sync complete; %s pending sessions", outbox.count())
            except Exception as error:
                logging.warning("Sync delayed; records remain on disk: %s", error)
            stop.wait(60)

    worker = threading.Thread(target=upload, daemon=True)
    worker.start()
    logging.info("Automatic collection started for %s", config.get("device_name", "Windows PC"))
    previous = datetime.now(timezone.utc)
    previous_app = activity.foreground()
    previous_tick = time.monotonic()
    try:
        while True:
            time.sleep(5)
            now = datetime.now(timezone.utc)
            tick = time.monotonic()
            app = activity.foreground()
            # Skip suspended/locked periods and intervals whose end is already idle.
            if tick - previous_tick < 15 and app:
                outbox.add(previous_app, previous, now)
            else:
                outbox.seal()
            previous, previous_tick, previous_app = now, tick, app
    except KeyboardInterrupt:
        now = datetime.now(timezone.utc)
        if time.monotonic() - previous_tick < 15 and activity.foreground():
            outbox.add(previous_app, previous, now)
    finally:
        outbox.seal()
        stop.set()
        worker.join(timeout=20)
        logging.info("Collection stopped. Unsent sessions remain on disk.")


if __name__ == "__main__":
    main()
