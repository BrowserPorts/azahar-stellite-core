# SPDX-License-Identifier: GPL-2.0-or-later

import importlib.util
import hashlib
from pathlib import Path
import subprocess
import sys


source = Path(sys.argv[1]).resolve()
revisions = {
    source: "1220477c7fb0f8fe4b500f4bd211de52f6dfe638",
    source / "unicorn": "8028ec436f2d9376525352dd38ed9ed6b9f6be10",
}
for repository, revision in revisions.items():
    actual = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=repository, text=True
    ).strip()
    if actual != revision:
        raise RuntimeError(f"The Unicorn test oracle revision changed: {repository}")

stamp = source / ".azahar-wasm-oracle"
fingerprint = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
if stamp.exists() and stamp.read_text() == fingerprint:
    sys.exit(0)

spec = importlib.util.spec_from_file_location("unicorn_wasm_build", source / "build.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.patchUnicorn()

# QEMU's compiler probes must accept an Emscripten installation path with spaces.
configure = source / "unicorn/qemu/configure"
original = configure.read_text()
adapted = original.replace('$compiler "$@"', '"$compiler" "$@"').replace(
    '$compiler -Werror "$@"', '"$compiler" -Werror "$@"'
)
if adapted != original:
    configure.write_text(adapted)
stamp.write_text(fingerprint)
