# Local Watermark Studio

A free, browser-based image and video cleanup tool. No installer or account is required. The input media is processed locally in the browser and is not uploaded.

## Run it

1. Extract `Local-Watermark-Studio.zip` into a folder.
2. Open `index.html` in a current version of Chrome, Edge, or Firefox.
3. Choose an image or video, select the watermark with **Rectangle** or **Brush**, and refine the selection with **Erase**.
4. Choose **Remove** or **Blur**, then use **Process & download**.

The tool uses regular local files (`css/styles.css`, `js/app.js`, `js/site.js`, `js/inpaint.js`, `js/wasm-kernel.js`, `js/export.js` and `js/webm-writer.js`), so the project is easy to edit. It does not need a build step.

## The website

`index.html` is a single-page product site with the working studio built in: a hero with a before/after example, the studio, features, how it works, privacy, expected results, FAQ and a responsible-use note. It follows the visitor's light or dark setting, has a theme switch, and works down to phone width.

- **Hosting:** it is plain static files. Upload the whole folder to any static host (Netlify, Cloudflare Pages, GitHub Pages, an S3 bucket, or your own server). There is no build step.
- **No third-party requests:** the fonts (Bricolage Grotesque, Hanken Grotesk, IBM Plex Mono, all SIL Open Font License) are bundled in `fonts/`, so the privacy claims on the page stay true. Keep it that way if you add analytics or embeds.
- **Edit the content:** the copy is in `index.html`; colours, type and spacing are tokens at the top of `css/styles.css`; `js/site.js` handles the theme switch and the before/after slider.

## Fill quality

- **Texture-aware fill (default):** The selection is first filled with a smooth estimate at a coarse scale. It is then rebuilt coarse to fine from real patches taken from around the selection (a PatchMatch search with patch voting), so grass, bricks, fabric and grain keep their look instead of turning into smears. Each copied patch is colour-matched to the area it replaces, so shading continues across the gap.
- **Smooth blend:** The original diffusion fill, kept as an option. It is the fastest, and good for plain sky or walls.
- **Grow selection:** Watermarks have soft edges that a drawn selection can miss. Growing the selection by a couple of pixels removes the faint outline.
- **Steady video:** For video, the patch matches carry over from frame to frame and the new fill is blended with the previous one while the scene is steady, so the filled area does not shimmer. A scene cut or a seek restarts the fill from scratch.
- **Bundled WebAssembly kernel:** The fill runs in `src/wasm_fill.c`, compiled into `js/diffusion-fill.wasm` and embedded in `js/wasm-kernel.js`. If WebAssembly is unavailable, `js/inpaint.js` runs the same integer algorithm and produces identical pixels, only more slowly.
- **Fill refinement:** The slider sets how many smoothing passes the smooth estimate gets and how many rounds the texture fill refines for. Higher is slower.
- **Blur:** Softens the selected shape with adjustable strength.

This is a local patch-based inpainting algorithm, not AI generative fill: it can only reuse what is already in the picture. It works best on plain and repetitive backgrounds. Very large selections (about 450,000 selected pixels or more) automatically use the smooth fill so the tool stays responsive, and fine structure that is hidden entirely behind the selection cannot be recovered. Smaller, accurate selections generally look better.

## Privacy and network use

The WebAssembly bytes are embedded in `js/wasm-kernel.js`, so the application can run from a local folder without fetching a runtime library. Your media stays in browser memory and is never sent to a server by this project. No external code is required.

## Export notes

- Images export as PNG.
- **Videos export as WebM, frame by frame.** The tool steps through the original one frame at a time, processes each frame once, encodes it with VP9 using the frame's exact timestamp (WebCodecs), and writes the WebM itself (`js/webm-writer.js`) with the correct duration and a seek index. The result has the same frame count and timing as the source, however long the fill takes. Older versions recorded the canvas in real time, which repeated and dropped frames whenever the fill was slower than the video.
- Because a frame is only taken when the previous one is finished, export is slower than playing the video through, and larger selections take longer. Keep the tab visible; if it is hidden, the export pauses and resumes when you return. Use **Cancel export** to stop without saving.
- Audio is decoded from the source file and re-encoded to Opus, so it stays in sync. If the file has no readable audio, or the browser cannot encode it, the export is silent and the status message says so.
- Browsers without WebCodecs (or without `requestVideoFrameCallback`) fall back to the older real-time recording, which can show uneven frames on slow fills.
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
│   ├── export.js
│   ├── webm-writer.js
│   ├── wasm-kernel.js
│   └── diffusion-fill.wasm
├── src/
│   └── wasm_fill.c
└── scripts/
    └── embed_wasm.py
```
