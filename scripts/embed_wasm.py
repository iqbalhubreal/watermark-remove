#!/usr/bin/env python3
"""Embed js/diffusion-fill.wasm into js/wasm-kernel.js after rebuilding it."""
from pathlib import Path
import base64
import re

ROOT = Path(__file__).resolve().parents[1]
wasm_path = ROOT / "js" / "diffusion-fill.wasm"
loader_path = ROOT / "js" / "wasm-kernel.js"

if not wasm_path.is_file() or not loader_path.is_file():
    raise SystemExit("Expected js/diffusion-fill.wasm and js/wasm-kernel.js beside this script.")

encoded = base64.b64encode(wasm_path.read_bytes()).decode("ascii")
source = loader_path.read_text(encoding="utf-8")
updated, count = re.subn(
    r"const WASM_BASE64 = '[A-Za-z0-9+/=]+';",
    f"const WASM_BASE64 = '{encoded}';",
    source,
    count=1,
)
if count != 1:
    raise SystemExit("Could not find the WASM_BASE64 constant in js/wasm-kernel.js")
loader_path.write_text(updated, encoding="utf-8")
print(f"Embedded {wasm_path.stat().st_size:,} bytes into {loader_path.relative_to(ROOT)}")
