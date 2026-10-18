# Local Watermark Studio

A free, browser-based image and video cleanup tool. No installer or account is required. The input media is processed locally in the browser and is not uploaded.

## Run it

1. Extract `Local-Watermark-Studio.zip` into a folder.
2. Open `index.html` in a current version of Chrome, Edge, or Firefox.
3. Choose an image or video, select the watermark with **Rectangle** or **Brush**, and refine the selection with **Erase**.
4. Choose **Remove** or **Blur**, then use **Process & download**.

The tool uses regular local files (`css/styles.css`, `js/app.js`, `js/site.js`, `js/inpaint.js`, and `js/wasm-kernel.js`), so the project is easy to edit. It does not need a build step.

## The website

`index.html` is a single-page product site with the working studio built in: a hero with a before/after example, the studio, features, how it works, privacy, expected results, FAQ and a responsible-use note. It follows the visitor's light or dark setting, has a theme switch, and works down to phone width.

- **Hosting:** it is plain static files. Upload the whole folder to any static host (Netlify, Cloudflare Pages, GitHub Pages, an S3 bucket, or your own server). There is no build step.
- **No third-party requests:** the fonts (Bricolage Grotesque, Hanken Grotesk, IBM Plex Mono, all SIL Open Font License) are bundled in `fonts/`, so the privacy claims on the page stay true. Keep it that way if you add analytics or embeds.
- **Edit the content:** the copy is in `index.html`; colours, type and spacing are tokens at the top of `css/styles.css`; `js/site.js` handles the theme switch and the before/after slider.

## Fill quality

- **Bundled WebAssembly fill:** A compact WebAssembly kernel uses nearby pixels from all available edges, then runs a few diffusion passes to smooth the reconstruction. The selection geometry is cached between video frames to reduce repeated work.
- **JavaScript fallback:** If WebAssembly is unavailable or fails to initialise, the included JavaScript implementation applies the same general fill approach.
- **Fill refinement:** Adjust the number of smoothing passes. More passes can blend the patch more smoothly, but can soften background details.
- **Blur:** Softens the selected shape with adjustable strength.

This is a local diffusion/inpainting-style algorithm, not AI generative fill. It is designed to improve plain and moderately smooth backgrounds and to avoid duplicating a nearby rectangular patch. Complex textures, fine patterns, moving details, and large selections can still show artifacts. Smaller, accurate selections generally look better.

## Privacy and network use

The WebAssembly bytes are embedded in `js/wasm-kernel.js`, so the application can run from a local folder without fetching a runtime library. Your media stays in browser memory and is never sent to a server by this project. No external code is required.

## Export notes

- Images export as PNG.
- Videos export as WebM using the browser's recording APIs.
- Video export records in real time. Keep the tab visible; if it is hidden, the export pauses and resumes when you return. Use **Cancel export** to stop without saving.
- Audio is included only if the browser exposes a captureable audio track.
- Video support and performance vary by browser, device, resolution, and duration.

## Project structure

```text
Local-Watermark-Studio/
├── index.html
├── README.md
├── WASM-BUILD.md
├── css/
│   └── styles.css
├── fonts/
│   ├── *.woff2
│   └── OFL-LICENSE.txt
├── js/
│   ├── app.js
│   ├── site.js
│   ├── inpaint.js
│   ├── wasm-kernel.js
│   └── diffusion-fill.wasm
├── src/
│   └── wasm_fill.c
└── scripts/
    └── embed_wasm.py
```
