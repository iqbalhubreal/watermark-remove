/*
 * LocalWatermarkInpaint
 * Dependency-free fill used for the "Remove" effect. Two methods are provided:
 *
 *  - "smooth":  the original diffusion fill. Fast, but it blurs textured backgrounds.
 *  - "texture": a multi-scale, patch-based fill. The hole is first filled with a smooth
 *               estimate at a coarse scale, then repeatedly rebuilt from real patches found
 *               around the selection (PatchMatch search plus patch voting), coarse to fine.
 *               This keeps grain, lines and repeated detail instead of smearing colours.
 *               For video, the patch correspondences are carried from frame to frame and the
 *               result is blended with the previous frame when the scene is steady, which
 *               stops the filled area from shimmering.
 *
 * This file is the JavaScript implementation. js/wasm-kernel.js runs the same integer
 * algorithm (src/wasm_fill.c) faster; both produce identical pixels, so the fallback is only
 * a speed difference. Keep the constants below in sync with src/wasm_fill.c.
 */
(function (global) {
  'use strict';

  const OFFSETS = [
    [-1, -1, 0.7071], [0, -1, 1], [1, -1, 0.7071],
    [-1, 0, 1],                       [1, 0, 1],
    [-1, 1, 0.7071],  [0, 1, 1],  [1, 1, 0.7071]
  ];

  // Texture-fill constants (shared with src/wasm_fill.c).
  const MAX_LEVELS = 4;
  const COARSE_TARGET = 8;      // keep halving until the hole is at most this thick
  const MIN_SOURCES = 24;       // a level needs at least this many usable source pixels
  const HOLE_WEIGHT = 5;        // weight (of 16) of not-yet-known pixels when matching patches
  const LAMBDA = 8;             // penalty per pixel of distance between a patch and its source
  const SAMPLE_STRIDE = 7;      // known pixels compared between frames to detect scene change
  const ALPHA_MAX = 154;        // of 256: maximum blend with the previous frame
  const TAU = 10;               // mean per-channel change at which temporal blending stops
  const BIAS_MAX = 24;          // largest colour correction applied to a copied patch
const BIAS_GAIN = 16;         // of 16: how much of the measured colour offset is applied
const MAX_TEXTURE_PIXELS = 450000;   // larger holes fall back to the smooth fill to stay responsive
const SEED = 0x2545F491;

  // ---------------------------------------------------------------- plans

  function makeLevelPlan(mask, width, height) {
    const size = width * height;
    let count = 0;
    for (let i = 0; i < size; i++) if (mask[i]) count++;
    if (!count) return null;

    // Distance is only needed for masked pixels. 16-bit storage keeps this
    // plan fairly small for typical watermark selections.
    const UNVISITED = 65535;
    const distance = new Uint16Array(size);
    distance.fill(UNVISITED);
    const queue = new Uint32Array(count);
    let tail = 0;

    function isBoundary(x, y) {
      for (const [dx, dy] of OFFSETS) {
        const nx = x + dx, ny = y + dy;
        // The image edge is not known content, so it must not count as a
        // boundary; only real unselected pixels can seed the fill.
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (!mask[ny * width + nx]) return true;
      }
      return false;
    }

    // Seed the queue with every selected pixel adjacent to an unselected pixel.
    for (let i = 0; i < size; i++) {
      if (!mask[i]) continue;
      if (isBoundary(i % width, (i / width) | 0)) {
        distance[i] = 1;
        queue[tail++] = i;
      }
    }

    // In rare fully enclosed cases, give the flood-fill a seed.
    if (!tail) {
      const first = mask.findIndex(Boolean);
      distance[first] = 1;
      queue[tail++] = first;
    }

    // Breadth-first ordering means boundary pixels are processed before the
    // interior, so each fill pixel can sample already reconstructed neighbours.
    for (let head = 0; head < tail; head++) {
      const index = queue[head];
      const x = index % width, y = (index / width) | 0;
      const nextDistance = Math.min(65534, distance[index] + 1);
      for (const [dx, dy] of OFFSETS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (mask[ni] && distance[ni] === UNVISITED) {
          distance[ni] = nextDistance;
          queue[tail++] = ni;
        }
      }
    }
    return { width, height, mask, distance, queue, count: tail };
  }

  // Patch bookkeeping for one level: which pixels are patch centres (their patch touches the
  // hole), and which pixels are usable as sources (their whole patch is known and in bounds).
  function textureStructures(level, radius) {
    const { width: w, height: h, mask } = level;
    const size = w * h, r = radius;
    const tmp = new Uint8Array(size), dil = new Uint8Array(size);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let xx = Math.max(0, x - r), x1 = Math.min(w - 1, x + r); xx <= x1; xx++) if (mask[y * w + xx]) { v = 1; break; }
      tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let yy = Math.max(0, y - r), y1 = Math.min(h - 1, y + r); yy <= y1; yy++) if (tmp[yy * w + x]) { v = 1; break; }
      dil[y * w + x] = v;
    }
    let nT = 0, nV = 0;
    const valid = new Uint8Array(size);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dil[i]) nT++;
      else if (x >= r && x < w - r && y >= r && y < h - r) { valid[i] = 1; nV++; }
    }
    const targets = new Uint32Array(nT), validList = new Uint32Array(nV);
    let a = 0, b = 0;
    for (let i = 0; i < size; i++) { if (dil[i]) targets[a++] = i; else if (valid[i]) validList[b++] = i; }
    level.radius = r; level.valid = valid; level.targets = targets; level.validList = validList;
  }

  function buildTextureLevels(plan) {
    const levels = [plan];
    let thickness = plan.distance[plan.queue[plan.count - 1]];
    while (thickness > COARSE_TARGET && levels.length < MAX_LEVELS) {
      const p = levels[levels.length - 1];
      if (Math.min(p.width, p.height) < 64) break;
      const w2 = (p.width + 1) >> 1, h2 = (p.height + 1) >> 1;
      const m2 = new Uint8Array(w2 * h2);
      for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) if (p.mask[y * p.width + x]) m2[(y >> 1) * w2 + (x >> 1)] = 1;
      const next = makeLevelPlan(m2, w2, h2);
      if (!next) break;
      levels.push(next);
      thickness = (thickness + 1) >> 1;
    }
    // Keep only the leading levels that have enough source material.
    let usable = 0;
    for (let l = 0; l < levels.length; l++) {
      const lv = levels[l];
      const lvThickness = lv.distance[lv.queue[lv.count - 1]];
      textureStructures(lv, (l === 0 && lvThickness <= 3) ? 2 : 3);
      if (lv.validList.length < MIN_SOURCES || !lv.targets.length) break;
      usable++;
    }
    if (!usable) return null;
    levels.length = usable;
    levels.forEach(lv => {
      const size = lv.width * lv.height;
      lv.img = new Uint8Array(size * 4);
      lv.nnf = new Int32Array(size).fill(-1);   // -1 = not a patch centre
      lv.cost = new Uint32Array(size);
      lv.bias = new Int16Array(size * 3);
    });
    return levels;
  }

  // Square dilation of a binary mask by `radius` pixels (separable, so cost is linear in radius).
  function growMask(mask, width, height, radius) {
    const size = width * height, tmp = new Uint8Array(size), out = new Uint8Array(size);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let v = 0;
      for (let xx = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius); xx <= x1; xx++) if (mask[y * width + xx]) { v = 1; break; }
      tmp[y * width + x] = v;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let v = 0;
      for (let yy = Math.max(0, y - radius), y1 = Math.min(height - 1, y + radius); yy <= y1; yy++) if (tmp[yy * width + x]) { v = 1; break; }
      out[y * width + x] = v;
    }
    return out;
  }

  // options.grow: expand the selection by this many pixels before filling. Watermarks have soft,
  // anti-aliased edges that a hand-drawn selection often misses; growing it removes that faint halo.
  // options.maxTexturePixels: above this hole size the fast smooth fill is used instead.
  function buildPlan(maskContext, width, height, options) {
    if (!maskContext || !width || !height) return null;
    options = options || {};
    const maskPixels = maskContext.getImageData(0, 0, width, height).data;
    const size = width * height;
    let mask = new Uint8Array(size);
    for (let i = 0, p = 3; i < size; i++, p += 4) if (maskPixels[p] > 20) mask[i] = 1;
    const grow = Math.max(0, Math.min(16, Math.round(Number(options.grow) || 0)));
    if (grow) mask = growMask(mask, width, height, grow);
    const plan = makeLevelPlan(mask, width, height);
    if (!plan) return null;
    plan.grow = grow;
    const limit = options.maxTexturePixels || MAX_TEXTURE_PIXELS;
    plan.levels = plan.count > limit ? null : buildTextureLevels(plan);   // null: too little material or too large
    plan.state = { valid: false };            // frame-to-frame state, see resetTemporal()
    return plan;
  }

  function resetTemporal(plan) {
    if (!plan) return;
    if (plan.state) plan.state.valid = false;
    if (global.LocalWatermarkWasm && global.LocalWatermarkWasm.resetTemporal) global.LocalWatermarkWasm.resetTemporal(plan);
  }

  // ------------------------------------------------------- smooth (diffusion) fill

  const ORTHOGONAL_WEIGHT = 1000, DIAGONAL_WEIGHT = 707, BLEND_WEIGHT = 550;

  // Integer diffusion fill, identical to watermark_diffusion_fill() in src/wasm_fill.c.
  // `pixels` is RGBA; only the hole pixels listed in the level's queue are written.
  function diffusionFill(pixels, level, passes, scratch) {
    const { width, height, mask, distance, queue, count } = level;
    for (let q = 0; q < count; q++) {
      const index = queue[q], x = index % width, y = (index / width) | 0, d = distance[index];
      let red = 0, green = 0, blue = 0, total = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (mask[ni] && distance[ni] >= d) continue;
        const weight = (dx && dy) ? DIAGONAL_WEIGHT : ORTHOGONAL_WEIGHT, p = ni * 4;
        red += pixels[p] * weight; green += pixels[p + 1] * weight; blue += pixels[p + 2] * weight; total += weight;
      }
      if (total) {
        const p = index * 4;
        pixels[p] = Math.floor(red / total); pixels[p + 1] = Math.floor(green / total); pixels[p + 2] = Math.floor(blue / total);
      }
    }
    for (let pass = 0; pass < passes; pass++) {
      for (let q = 0; q < count; q++) {
        const index = queue[q], x = index % width, y = (index / width) | 0;
        let red = 0, green = 0, blue = 0, total = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const weight = (dx && dy) ? DIAGONAL_WEIGHT : ORTHOGONAL_WEIGHT, p = (ny * width + nx) * 4;
          red += pixels[p] * weight; green += pixels[p + 1] * weight; blue += pixels[p + 2] * weight; total += weight;
        }
        const p = index * 4;
        if (total) {
          scratch[p] = Math.floor((pixels[p] * (1000 - BLEND_WEIGHT) + Math.floor(red / total) * BLEND_WEIGHT) / 1000);
          scratch[p + 1] = Math.floor((pixels[p + 1] * (1000 - BLEND_WEIGHT) + Math.floor(green / total) * BLEND_WEIGHT) / 1000);
          scratch[p + 2] = Math.floor((pixels[p + 2] * (1000 - BLEND_WEIGHT) + Math.floor(blue / total) * BLEND_WEIGHT) / 1000);
        } else { scratch[p] = pixels[p]; scratch[p + 1] = pixels[p + 1]; scratch[p + 2] = pixels[p + 2]; }
      }
      for (let q = 0; q < count; q++) {
        const p = queue[q] * 4;
        pixels[p] = scratch[p]; pixels[p + 1] = scratch[p + 1]; pixels[p + 2] = scratch[p + 2];
      }
    }
  }

  function defaultPasses(count) { return count < 25000 ? 8 : count < 120000 ? 5 : count < 350000 ? 3 : 1; }
  function normalisePasses(requested, count) {
    const n = Number(requested);
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(16, Math.round(n))) : defaultPasses(count);
  }
  // The fill-refinement slider also sets how long the texture fill refines. Mirrored in wasm-kernel.js.
  function textureIterations(passes, count) {
    let fine = Math.max(2, Math.min(6, 2 + Math.floor(passes / 3)));
    let warm = passes >= 10 ? 3 : 2;
    // Large holes get fewer refinement rounds so playback and export stay responsive.
    if (count > 200000) { fine = Math.min(fine, 2); warm = 1; }
    else if (count > 90000) { fine = Math.min(fine, 3); warm = Math.min(warm, 2); }
    return { fine, coarse: fine + 2, warm };
  }

  // ------------------------------------------------------------ texture fill

  // Halve a level image. A coarse pixel is known only when all of its children are known.
  function downsample(src, srcLevel, dst, dstLevel) {
    const sw = srcLevel.width, sh = srcLevel.height, dw = dstLevel.width, dh = dstLevel.height;
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const di = y * dw + x;
      if (dstLevel.mask[di]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const sx = 2 * x + dx, sy = 2 * y + dy;
        if (sx >= sw || sy >= sh) continue;
        const p = (sy * sw + sx) * 4;
        r += src[p]; g += src[p + 1]; b += src[p + 2]; n++;
      }
      const half = n >> 1;
      dst[di * 4] = Math.floor((r + half) / n); dst[di * 4 + 1] = Math.floor((g + half) / n);
      dst[di * 4 + 2] = Math.floor((b + half) / n); dst[di * 4 + 3] = 255;
    }
  }

  const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v;

  // Start a finer level's hole from the coarser level's result (nearest pixel).
  function upsampleHole(coarse, coarseLevel, fine, fineLevel) {
    const cw = coarseLevel.width, fw = fineLevel.width;
    for (let q = 0; q < fineLevel.count; q++) {
      const i = fineLevel.queue[q], x = i % fw, y = (i / fw) | 0;
      const c = ((y >> 1) * cw + (x >> 1)) * 4, p = i * 4;
      fine[p] = coarse[c]; fine[p + 1] = coarse[c + 1]; fine[p + 2] = coarse[c + 2];
    }
  }

  // One cold or warm pass of the multi-scale fill. `data` is the level-0 RGBA crop.
  // Returns the mean patch cost of the finest level (used to spot scene cuts).
  function runTexture(data, plan, iter, warm) {
    const levels = plan.levels, L = levels.length, state = plan.state;
    let rng = SEED | 0;
    const rand = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return rng >>> 0; };

    const imgs = new Array(L);
    imgs[0] = data;
    for (let l = 1; l < L; l++) imgs[l] = levels[l].img;
    if (!warm) {
      for (let l = 1; l < L; l++) downsample(imgs[l - 1], levels[l - 1], imgs[l], levels[l]);
      diffusionFill(imgs[L - 1], levels[L - 1], iter.passes, new Uint8Array(imgs[L - 1].length));
    }

    let prevNnf = null, prevW = 0, prevH = 0, meanCost = 0;
    for (let l = warm ? 0 : L - 1; l >= 0; l--) {
      const lv = levels[l], w = lv.width, h = lv.height, r = lv.radius, d = imgs[l], mask = lv.mask;
      const valid = lv.valid, targets = lv.targets, validList = lv.validList, nV = validList.length, nT = targets.length;
      const nnf = lv.nnf, cost = lv.cost, count = lv.count, queue = lv.queue;

      const dist = (tx, ty, sx, sy, limit) => {
        let sum = 0;
        for (let dy = -r; dy <= r; dy++) {
          let ty2 = ty + dy; if (ty2 < 0) ty2 = 0; else if (ty2 >= h) ty2 = h - 1;
          const tRow = ty2 * w, sRow = (sy + dy) * w;
          for (let dx = -r; dx <= r; dx++) {
            let tx2 = tx + dx; if (tx2 < 0) tx2 = 0; else if (tx2 >= w) tx2 = w - 1;
            const ti = tRow + tx2, p = ti * 4, q = (sRow + sx + dx) * 4;
            const e0 = d[p] - d[q], e1 = d[p + 1] - d[q + 1], e2 = d[p + 2] - d[q + 2];
            sum += (mask[ti] ? HOLE_WEIGHT : 16) * (e0 * e0 + e1 * e1 + e2 * e2);
          }
          if (sum >= limit) return sum;
        }
        return sum;
      };
      const tryCandidate = (ti, tx, ty, sx, sy) => {
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
        const si = sy * w + sx;
        if (!valid[si]) return;
        const pen = (Math.abs(sx - tx) + Math.abs(sy - ty)) * LAMBDA * 16, limit = cost[ti];
        if (pen >= limit) return;
        const dd = dist(tx, ty, sx, sy, limit - pen) + pen;
        if (dd < limit) { cost[ti] = dd; nnf[ti] = si; }
      };
      // Every hole pixel becomes the weighted mean of what the patches covering it say it should be.
      // A copied patch is shifted by the average colour difference between it and the area it
      // replaces, so brightness gradients and shading continue across the hole.
      const bias = lv.bias;
      const vote = () => {
        for (let k = 0; k < nT; k++) {
          const ti = targets[k], tx = ti % w, ty = (ti / w) | 0, si = nnf[ti], sx = si % w, sy = (si / w) | 0;
          let b0 = 0, b1 = 0, b2 = 0, bw = 0;
          for (let dy = -r; dy <= r; dy++) {
            let ty2 = ty + dy; if (ty2 < 0) ty2 = 0; else if (ty2 >= h) ty2 = h - 1;
            const tRow = ty2 * w, sRow = (sy + dy) * w;
            for (let dx = -r; dx <= r; dx++) {
              let tx2 = tx + dx; if (tx2 < 0) tx2 = 0; else if (tx2 >= w) tx2 = w - 1;
              const tj = tRow + tx2, p = tj * 4, q = (sRow + sx + dx) * 4, wt = mask[tj] ? HOLE_WEIGHT : 16;
              b0 += wt * (d[p] - d[q]); b1 += wt * (d[p + 1] - d[q + 1]); b2 += wt * (d[p + 2] - d[q + 2]); bw += wt;
            }
          }
          let c0 = Math.trunc(b0 / bw), c1 = Math.trunc(b1 / bw), c2 = Math.trunc(b2 / bw);
          c0 = Math.trunc(Math.max(-BIAS_MAX, Math.min(BIAS_MAX, c0)) * BIAS_GAIN / 16);
          c1 = Math.trunc(Math.max(-BIAS_MAX, Math.min(BIAS_MAX, c1)) * BIAS_GAIN / 16);
          c2 = Math.trunc(Math.max(-BIAS_MAX, Math.min(BIAS_MAX, c2)) * BIAS_GAIN / 16);
          bias[ti * 3] = c0; bias[ti * 3 + 1] = c1; bias[ti * 3 + 2] = c2;
        }
        for (let q = 0; q < count; q++) {
          const zi = queue[q], zx = zi % w, zy = (zi / w) | 0;
          let sr = 0, sg = 0, sb = 0, sw = 0;
          for (let dy = -r; dy <= r; dy++) {
            const ty = zy + dy; if (ty < 0 || ty >= h) continue;
            for (let dx = -r; dx <= r; dx++) {
              const tx = zx + dx; if (tx < 0 || tx >= w) continue;
              const si = nnf[ty * w + tx]; if (si < 0) continue;
              const sx = (si % w) - dx, sy = ((si / w) | 0) - dy;
              const tri = (r + 1 - Math.abs(dx)) * (r + 1 - Math.abs(dy)), wt = tri * tri, p = (sy * w + sx) * 4, bi = (ty * w + tx) * 3;
              sr += (d[p] + bias[bi]) * wt; sg += (d[p + 1] + bias[bi + 1]) * wt; sb += (d[p + 2] + bias[bi + 2]) * wt; sw += wt;
            }
          }
          if (sw) {
            const p = zi * 4, half = sw >> 1;
            d[p] = clamp255(Math.floor((sr + half) / sw)); d[p + 1] = clamp255(Math.floor((sg + half) / sw)); d[p + 2] = clamp255(Math.floor((sb + half) / sw));
          }
        }
      };

      // Initial correspondences: carried from the previous frame (warm), from the coarser level,
      // or random nearby sources.
      const haveCoarse = prevNnf !== null;
      if (haveCoarse) upsampleHole(imgs[l + 1], levels[l + 1], d, lv);
      for (let k = 0; k < nT; k++) {
        const ti = targets[k], tx = ti % w, ty = (ti / w) | 0;
        let done = false;
        if (warm) {
          done = nnf[ti] >= 0;        // level-0 nnf still holds the previous frame's result
        } else {
          cost[ti] = 0xFFFFFFFF;
          nnf[ti] = -1;
          if (haveCoarse) {
            const px = tx >> 1, py = ty >> 1;
            const ps = (px < prevW && py < prevH) ? prevNnf[py * prevW + px] : -1;
            if (ps >= 0) {
              const sx = 2 * (ps % prevW) + (tx & 1), sy = 2 * ((ps / prevW) | 0) + (ty & 1);
              if (sx < w && sy < h && valid[sy * w + sx]) { nnf[ti] = sy * w + sx; done = true; }
            }
          }
        }
        if (!done) {
          nnf[ti] = -1; cost[ti] = 0xFFFFFFFF;
          for (let n = 0; n < 8; n++) tryCandidate(ti, tx, ty, tx + (rand() % 49) - 24, ty + (rand() % 49) - 24);
          if (nnf[ti] < 0) for (let n = 0; n < 6; n++) { const si = validList[rand() % nV]; tryCandidate(ti, tx, ty, si % w, (si / w) | 0); }
          if (nnf[ti] < 0) nnf[ti] = validList[0];
        }
      }
      if (haveCoarse || warm) vote();
      for (let k = 0; k < nT; k++) {
        const ti = targets[k], tx = ti % w, ty = (ti / w) | 0, si = nnf[ti], sx = si % w, sy = (si / w) | 0;
        cost[ti] = dist(tx, ty, sx, sy, 0xFFFFFFFF) + (Math.abs(sx - tx) + Math.abs(sy - ty)) * LAMBDA * 16;
      }

      const maxR = Math.min(64, Math.max(w, h) >> 1);
      const iters = l === 0 ? (warm ? iter.warm : iter.fine) : iter.coarse;
      for (let it = 0; it < iters; it++) {
        const fwd = (it & 1) === 0;
        for (let k = 0; k < nT; k++) {
          const ti = targets[fwd ? k : nT - 1 - k], tx = ti % w, ty = (ti / w) | 0, step = fwd ? 1 : -1;
          const n1 = fwd ? ti - 1 : ti + 1, n2 = fwd ? ti - w : ti + w;
          if (((fwd && tx > 0) || (!fwd && tx < w - 1)) && nnf[n1] >= 0) { const si = nnf[n1]; tryCandidate(ti, tx, ty, (si % w) + step, (si / w) | 0); }
          if (((fwd && ty > 0) || (!fwd && ty < h - 1)) && nnf[n2] >= 0) { const si = nnf[n2]; tryCandidate(ti, tx, ty, si % w, ((si / w) | 0) + step); }
          const bi = nnf[ti], bx = bi % w, by = (bi / w) | 0;
          for (let R = maxR; R >= 1; R >>= 1) tryCandidate(ti, tx, ty, bx + (rand() % (2 * R + 1)) - R, by + (rand() % (2 * R + 1)) - R);
        }
        vote();
      }
      if (l > 0) { prevNnf = nnf; prevW = w; prevH = h; }
      else {
        let total = 0;
        for (let k = 0; k < nT; k++) total += cost[targets[k]];
        meanCost = Math.floor(total / nT);
      }
    }
    return meanCost;
  }

  function textureFill(data, plan, passes) {
    const levels = plan.levels, state = plan.state, lv0 = levels[0];
    const iter = Object.assign({ passes }, textureIterations(passes, lv0.count));
    const w0 = lv0.width, h0 = lv0.height, m0 = lv0.mask;

    // Known pixels sampled from this frame, to tell whether the scene is steady.
    const sampleCount = Math.ceil(w0 * h0 / SAMPLE_STRIDE);
    const sample = new Uint8Array(sampleCount * 3);
    for (let i = 0, k = 0; i < w0 * h0; i += SAMPLE_STRIDE, k++) {
      if (m0[i]) continue;
      const p = i * 4;
      sample[k * 3] = data[p]; sample[k * 3 + 1] = data[p + 1]; sample[k * 3 + 2] = data[p + 2];
    }

    let warm = !!(state.valid && state.sample && state.sample.length === sample.length);
    // A warm start continues from the previous frame's clean fill, never from this frame's raw hole
    // pixels (they still contain the watermark, and would leak into the colour matching).
    if (warm) {
      for (let q = 0; q < lv0.count; q++) {
        const p = lv0.queue[q] * 4;
        data[p] = state.out[q * 3]; data[p + 1] = state.out[q * 3 + 1]; data[p + 2] = state.out[q * 3 + 2];
      }
    }
    let meanCost = runTexture(data, plan, iter, warm);
    // A big jump in matching cost means a scene cut or a seek: start over from scratch.
    if (warm && meanCost * 2 > state.meanCost * 5 + 2 * 16 * (2 * lv0.radius + 1) * (2 * lv0.radius + 1) * 30) {
      warm = false;
      meanCost = runTexture(data, plan, iter, false);
    }

    // Blend with the previous frame's fill while the surroundings hardly changed.
    let alpha = 0;
    if (warm) {
      let sum = 0, n = 0;
      for (let i = 0, k = 0; i < w0 * h0; i += SAMPLE_STRIDE, k++) {
        if (m0[i]) continue;
        const b = k * 3;
        sum += Math.abs(sample[b] - state.sample[b]) + Math.abs(sample[b + 1] - state.sample[b + 1]) + Math.abs(sample[b + 2] - state.sample[b + 2]);
        n += 3;
      }
      if (n && sum < TAU * n) alpha = Math.floor(ALPHA_MAX * (TAU * n - sum) / (TAU * n));
    }
    const out = new Uint8Array(lv0.count * 3);
    for (let q = 0; q < lv0.count; q++) {
      const p = lv0.queue[q] * 4;
      if (alpha > 0) {
        for (let c = 0; c < 3; c++) data[p + c] = (data[p + c] * (256 - alpha) + state.out[q * 3 + c] * alpha + 128) >> 8;
      }
      out[q * 3] = data[p]; out[q * 3 + 1] = data[p + 1]; out[q * 3 + 2] = data[p + 2];
    }
    state.valid = true; state.sample = sample; state.out = out; state.meanCost = meanCost;
  }

  // ------------------------------------------------------------------ apply

  function applyPlan(sourceContext, outputContext, plan, requestedPasses = 0, options = {}) {
    if (!sourceContext || !outputContext || !plan || !plan.count) return false;
    const smooth = options.mode === 'smooth' || !plan.levels;
    const wasm = global.LocalWatermarkWasm;
    // The bundled WebAssembly kernel is preferred for video frame throughput.
    // The JavaScript below produces the same pixels, only more slowly.
    if (wasm) {
      const done = smooth ? wasm.tryApply(sourceContext, outputContext, plan, requestedPasses)
                          : wasm.tryApplyTexture(sourceContext, outputContext, plan, requestedPasses);
      if (done) return true;
    }
    const passes = normalisePasses(requestedPasses, plan.count);
    const source = sourceContext.getImageData(0, 0, plan.width, plan.height);
    const output = outputContext.createImageData(plan.width, plan.height);
    output.data.set(source.data);
    if (smooth) diffusionFill(output.data, plan, passes, new Uint8Array(output.data.length));
    else textureFill(output.data, plan, passes);
    outputContext.putImageData(output, 0, 0);
    return true;
  }

  global.LocalWatermarkInpaint = { buildPlan, growMask, applyPlan, resetTemporal, textureIterations, normalisePasses };
})(window);
