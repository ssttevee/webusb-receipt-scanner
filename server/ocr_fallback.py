"""Persistent local OCR child with a parent-enforced receipt deadline."""
import ctypes
import hashlib
import json
import math
import multiprocessing
import os
from pathlib import Path
import signal
import sys
import threading
import time
import uuid

from .storage import durable_write, encode

MAX_RESULT_BYTES = 16 * 1048576


def child_limits(memory_mib, parent_pid):
    if sys.platform != "linux":
        return False
    import resource
    # A forced worker exit must also terminate its native inference child.
    if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent_pid:
        raise RuntimeError("Cannot bind OCR child lifetime to its parent")
    limit = memory_mib * 1048576
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    return True


def serve(connection, config, parent_pid):
    backend = None
    try:
        # Model setup occurs before the child receives any receipt path.
        for key in list(os.environ):
            if key.startswith("DRIVE_") or key == "OPENROUTER_API_KEY":
                os.environ.pop(key, None)
        limited = child_limits(config["memory_mib"], parent_pid)
        from .ocr_backends import RapidCPU
        from .recognition import recognize
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 160000000
        backend = RapidCPU(config["models"])
        connection.send({"kind": "ready", "backend": backend.descriptor, "linux_limits": limited})
        while True:
            request = connection.recv()
            if request["kind"] == "stop":
                break
            remaining = request["deadline"] - time.monotonic()
            if remaining <= 0:
                connection.send({"kind": "failed", "id": request["id"], "reason": "deadline_exceeded"})
                continue
            if limited:
                import resource
                used = resource.getrusage(resource.RUSAGE_SELF)
                resource.setrlimit(resource.RLIMIT_CPU, (math.ceil(used.ru_utime + used.ru_stime + remaining * 2 + 1), resource.RLIM_INFINITY))
            try:
                output = Path(request["output"])
                with Image.open(request["master"]) as image:
                    if image.width * image.height > 160000000:
                        raise ValueError("Image exceeds the fallback pixel limit")
                    result = recognize(image, dpi=request["dpi"], languages=request["languages"], output=output,
                                       date_order=request["date_order"], century=request["century"],
                                       timeout=remaining, backend=backend)
                content = encode(result).encode()
                if len(content) > MAX_RESULT_BYTES:
                    raise ValueError("Fallback evidence exceeds its limit")
                durable_write(output / f"{request['id']}.json", content)
                connection.send({"kind": "done", "id": request["id"], "sha256": hashlib.sha256(content).hexdigest()})
            except Exception:
                connection.send({"kind": "failed", "id": request["id"], "reason": "inference_failed"})
    except (EOFError, BrokenPipeError):
        pass
    except Exception:
        try:
            connection.send({"kind": "failed", "reason": "backend_unavailable"})
        except (EOFError, BrokenPipeError, OSError):
            pass
    finally:
        if backend:
            backend.close()
        connection.close()


class FallbackClient:
    def __init__(self, *, models="/opt/receipt-ocr-models", timeout=45, memory_mib=4096, target=serve):
        if not 0 < timeout <= 120 or not 1024 <= memory_mib <= 6144:
            raise ValueError("Fallback limits must be at most 120 seconds and 1024–6144 MiB")
        self.config = {"models": str(models), "timeout": timeout, "memory_mib": memory_mib}
        self.context = multiprocessing.get_context("spawn")
        self.target = target
        self.process = None
        self.connection = None
        self.descriptor = None
        self.linux_limits = False
        self.lock = threading.Lock()

    def _receive(self, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not self.connection.poll(remaining):
            raise TimeoutError("Fallback deadline exceeded")
        return self.connection.recv()

    def _start(self, deadline):
        if self.process and self.process.is_alive():
            return
        self.close()
        self.descriptor, self.linux_limits = None, False
        parent, child = self.context.Pipe()
        self.connection = parent
        self.process = self.context.Process(target=self.target, args=(child, self.config, os.getpid()), daemon=True)
        try:
            self.process.start()
        finally:
            child.close()
        response = self._receive(deadline)
        if response.get("kind") != "ready":
            raise ValueError("Fallback unavailable")
        self.descriptor = response["backend"]
        self.linux_limits = response.get("linux_limits", False)

    def request(self, master, *, output, dpi=200, languages=("eng",), date_order=None, century=None):
        started = time.monotonic()
        deadline = started + self.config["timeout"]
        if not self.lock.acquire(blocking=False):
            return {"state": "failed", "reason": "fallback_busy", "seconds": 0, "result": None}
        child_pid = None
        try:
            self._start(deadline)
            child_pid = self.process.pid
            identity = uuid.uuid4().hex
            self.connection.send({"kind": "recognize", "id": identity, "master": str(master), "output": str(output),
                                  "deadline": deadline, "dpi": dpi, "languages": list(languages),
                                  "date_order": date_order, "century": century})
            response = self._receive(deadline)
            if response.get("kind") != "done" or response.get("id") != identity:
                raise ValueError("Fallback failed or returned a different job")
            path = Path(output) / f"{identity}.json"
            if path.stat().st_size > MAX_RESULT_BYTES:
                raise ValueError("Fallback result exceeds its limit")
            content = path.read_bytes()
            if hashlib.sha256(content).hexdigest() != response.get("sha256"):
                raise ValueError("Fallback result checksum failed")
            result = json.loads(content)
            if not isinstance(result.get("extraction"), dict) or not isinstance(result.get("failures"), list):
                raise ValueError("Invalid fallback evidence")
            state, reason = "done", None
        except TimeoutError:
            child_pid = child_pid or (self.process.pid if self.process else None)
            self.close()
            result, state, reason = None, "timeout", "deadline_exceeded"
        except (EOFError, OSError, ValueError, RuntimeError):
            child_pid = child_pid or (self.process.pid if self.process else None)
            self.close()
            result, state, reason = None, "failed", "fallback_unavailable_or_failed"
        finally:
            self.lock.release()
        return {"state": state, "reason": reason, "seconds": round(time.monotonic() - started, 6), "result": result,
                "timeout_seconds": self.config["timeout"], "memory_limit_mib": self.config["memory_mib"],
                "linux_limits": self.linux_limits, "child_pid": child_pid,
                "child_stopped": self.process is None}

    def close(self):
        if self.process:
            if self.process.is_alive() and self.connection:
                try:
                    self.connection.send({"kind": "stop"})
                except (BrokenPipeError, EOFError, OSError):
                    pass
            if self.process.pid is not None:
                self.process.join(timeout=0.2)
                if self.process.is_alive():
                    self.process.terminate()
                    self.process.join(timeout=1)
                if self.process.is_alive():
                    self.process.kill()
                    self.process.join()
            self.process.close()
            self.process = None
        if self.connection:
            self.connection.close()
            self.connection = None
