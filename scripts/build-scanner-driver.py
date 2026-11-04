"""Build/package the pinned browser driver; Docker is for compilation, not sample-app runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE_COMMIT = "067b5576f1dde4433c17a29fa6bbaba762c021a8"
BACKEND_COMMIT = "32f335d0f1bb9f4fa25fdab722d0201043614df3"
PATCHES = [ROOT / "scanner-driver/epsonds-longpaper.patch", ROOT / "scanner-driver/epsonds-session.patch"]
PATCH_REVISION = "receipt-longpaper-2"


def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True)


def commit(path):
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Use an existing pinned sane-wasm checkout")
    parser.add_argument("--package-only", action="store_true", help="Package an already built, patched checkout")
    args = parser.parse_args()
    temporary = tempfile.TemporaryDirectory(prefix="receipt-sane-build-") if args.source is None else None
    try:
        source = args.source.resolve() if args.source else Path(temporary.name) / "sane-wasm"
        if not args.source:
            run("git", "clone", "--branch", "v0.5.0", "--depth", "1", "--recurse-submodules", "--shallow-submodules",
                "https://github.com/goncalomb/sane-wasm.git", str(source))
        if commit(source) != SOURCE_COMMIT or commit(source / "deps/backends") != BACKEND_COMMIT:
            parser.error("Source revisions do not match the pinned driver/backend.")
        if args.package_only:
            for patch in PATCHES:
                run("git", "apply", "--reverse", "--check", str(patch), cwd=source / "deps/backends")
        else:
            for patch in PATCHES:
                run("git", "apply", "--check", str(patch), cwd=source / "deps/backends")
                run("git", "apply", str(patch), cwd=source / "deps/backends")
            build = source / "build.sh"
            text = build.read_text()
            selector = 'SANE_WASM_BACKENDS=$(./utils.py usb-backends -i test -e template,unsupported,dell1600n_net,genesys)'
            if selector not in text:
                parser.error("Unexpected upstream build script; refusing to rewrite it.")
            # Only Epson ESC/I-2 and the test backend are needed by this collector.
            build.write_text(text.replace(selector, 'SANE_WASM_BACKENDS="epsonds test"').replace("make -j ", "make -j4 "))
            run("docker", "build", "--platform", "linux/amd64", "-t", "receipt-sane-builder:3.1.50",
                "-f", str(ROOT / "scanner-driver/Dockerfile.builder"), str(ROOT / "scanner-driver"))
            run("docker", "run", "--rm", "--platform", "linux/amd64", "--user", f"{os.getuid()}:{os.getgid()}",
                "-e", "HOME=/tmp", "-e", "EM_CACHE=/tmp/emscripten-cache", "-v", f"{source}:/src", "-w", "/src",
                "--entrypoint", "/bin/bash", "receipt-sane-builder:3.1.50", "./build.sh")
        output = ROOT / "scanner-driver/build"
        output.mkdir(parents=True, exist_ok=True)
        copies = {
            "libsane.js": source / "build/libsane.js",
            "libsane.worker.js": source / "build/libsane.worker.js",
            "libsane.wasm": source / "build/libsane.wasm",
            "LICENSE.txt": source / "LICENSE.txt",
            "LICENSE-LGPL.txt": source / "LICENSE-LGPL.txt",
            "SANE-COPYING": source / "deps/backends/COPYING",
            "SANE-LICENSE": source / "deps/backends/LICENSE",
            **{patch.name: patch for patch in PATCHES},
        }
        checksums = {}
        for name, original in copies.items():
            destination = output / name
            shutil.copyfile(original, destination)
            checksums[name] = hashlib.sha256(destination.read_bytes()).hexdigest()
        provenance = {
            "patch_revision": PATCH_REVISION, "sane_wasm_commit": SOURCE_COMMIT,
            "sane_backends_commit": BACKEND_COMMIT, "source": "https://github.com/goncalomb/sane-wasm",
            "compiler": "Emscripten 3.1.50", "backends": ["epsonds", "test"],
            "patch_sha256": {patch.name: checksums[patch.name] for patch in PATCHES}, "sha256": checksums,
            "physical_long_scan_verified": False,
        }
        (output / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
        print(f"Packaged patched browser driver in {output}")
    finally:
        if temporary:
            temporary.cleanup()


if __name__ == "__main__":
    main()
