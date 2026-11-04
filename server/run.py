"""Supervise the API and one bounded worker; either child's exit stops both."""
import os
import signal
import subprocess
import sys
import time

from .storage import Settings, Store


def main():
    os.umask(0o077)
    Store(Settings.environment())
    children = []
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True
        for child in children:
            if child.poll() is None:
                child.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    exit_code = 1
    try:
        children.append(subprocess.Popen([sys.executable, "-m", "uvicorn", "server.api:create_app", "--factory",
            "--host", "0.0.0.0", "--port", os.getenv("PORT", "8000"), "--no-access-log", "--no-proxy-headers"]))
        children.append(subprocess.Popen([sys.executable, "-m", "server.worker"]))
        while not stopping and all(child.poll() is None for child in children):
            time.sleep(0.25)
        exit_code = 0 if stopping else 1
    finally:
        stop()
        for child in children:
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
