# Rebuilding the local WebAssembly fill kernel

This is optional developer documentation. The app already includes a compiled kernel and works without rebuilding it.

The C source is `src/wasm_fill.c`. With a Clang toolchain that supports the `wasm32` target and `wasm-ld`, run this from the project root:

```sh
clang --target=wasm32 -O3 -nostdlib \
  -Wl,--no-entry \
  -Wl,--export=watermark_diffusion_fill \
  -Wl,--export-memory \
  -Wl,--export=__heap_base \
  -Wl,--initial-memory=262144 \
  -Wl,--max-memory=1073741824 \
  -Wl,--strip-all \
  -o js/diffusion-fill.wasm src/wasm_fill.c
python scripts/embed_wasm.py
```

`js/wasm-kernel.js` embeds the small Wasm binary as base64 so the app can be opened directly from a local file without `fetch()` or a local web server. The standalone `.wasm` file is retained to make the build reproducible. The page uses no external runtime library.
