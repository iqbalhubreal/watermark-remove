/*
 * LocalWatermarkInpaint
 * Small, dependency-free diffusion inpainting implementation used as the
 * JavaScript fallback when the bundled WebAssembly kernel is unavailable.
 */
(function (global) {
  'use strict';

  const OFFSETS = [
    [-1, -1, 0.7071], [0, -1, 1], [1, -1, 0.7071],
    [-1, 0, 1],                       [1, 0, 1],
    [-1, 1, 0.7071],  [0, 1, 1],  [1, 1, 0.7071]
  ];

  function buildPlan(maskContext, width, height) {
    if (!maskContext || !width || !height) return null;
    const maskPixels = maskContext.getImageData(0, 0, width, height).data;
    const size = width * height;
    const mask = new Uint8Array(size);
    let count = 0;

    for (let i = 0, p = 3; i < size; i++, p += 4) {
      if (maskPixels[p] > 20) {
        mask[i] = 1;
        count++;
      }
    }
    if (!count) return null;

    // Distance is only needed for masked pixels. 16-bit storage keeps this
    // plan fairly small for typical watermark selections.
    const UNVISITED = 65535;
    const distance = new Uint16Array(size);
    distance.fill(UNVISITED);
    const queue = new Uint32Array(count);
    let tail = 0;

    function isBoundary(index, x, y) {
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
      const x = i % width, y = (i / width) | 0;
      if (isBoundary(i, x, y)) {
        distance[i] = 1;
        queue[tail++] = i;
      }
    }

    // In rare fully enclosed cases, give the flood-fill a seed.
    if (!tail) {
      const first = mask.findIndex ? mask.findIndex(Boolean) : 0;
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

  function applyPlan(sourceContext, outputContext, plan, requestedPasses = 0) {
    if (!sourceContext || !outputContext || !plan || !plan.count) return false;
    // The bundled WebAssembly kernel is preferred for video frame throughput.
    // This fallback keeps the tool functional in browsers without WebAssembly.
    if (global.LocalWatermarkWasm && global.LocalWatermarkWasm.tryApply(sourceContext, outputContext, plan, requestedPasses)) return true;
    const { width, height, mask, distance, queue, count } = plan;
    const source = sourceContext.getImageData(0, 0, width, height);
    const output = outputContext.createImageData(width, height);
    output.data.set(source.data);
    const data = output.data;

    // Extend nearby known colours inward in BFS order. It blends information
    // from every available edge instead of copying a repeated rectangular patch.
    for (let q = 0; q < count; q++) {
      const index = queue[q];
      const x = index % width, y = (index / width) | 0;
      const d = distance[index];
      let red = 0, green = 0, blue = 0, totalWeight = 0;

      for (const [dx, dy, weight] of OFFSETS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (mask[ni] && distance[ni] >= d) continue;
        const p = ni * 4;
        red += data[p] * weight;
        green += data[p + 1] * weight;
        blue += data[p + 2] * weight;
        totalWeight += weight;
      }

      if (totalWeight > 0) {
        const p = index * 4;
        data[p] = red / totalWeight;
        data[p + 1] = green / totalWeight;
        data[p + 2] = blue / totalWeight;
        // Keep original alpha so PNG transparency is preserved.
      }
    }

    // A few relaxed diffusion passes soften transitions while keeping every
    // unselected pixel fixed. Work is proportional to the selected area.
    const defaultPasses = count < 25000 ? 8 : count < 120000 ? 5 : count < 350000 ? 3 : 1;
    const passes = Number.isFinite(Number(requestedPasses)) && Number(requestedPasses) > 0 ? Math.max(1, Math.min(16, Math.round(Number(requestedPasses)))) : defaultPasses;
    let current = data;
    let scratch = new Uint8ClampedArray(data.length);
    for (let pass = 0; pass < passes; pass++) {
      scratch.set(current);
      for (let q = 0; q < count; q++) {
        const index = queue[q];
        const x = index % width, y = (index / width) | 0;
        let red = 0, green = 0, blue = 0, totalWeight = 0;
        for (const [dx, dy, weight] of OFFSETS) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const p = (ny * width + nx) * 4;
          red += current[p] * weight;
          green += current[p + 1] * weight;
          blue += current[p + 2] * weight;
          totalWeight += weight;
        }
        if (totalWeight > 0) {
          const p = index * 4;
          const blend = 0.55;
          scratch[p] = current[p] + (red / totalWeight - current[p]) * blend;
          scratch[p + 1] = current[p + 1] + (green / totalWeight - current[p + 1]) * blend;
          scratch[p + 2] = current[p + 2] + (blue / totalWeight - current[p + 2]) * blend;
        }
      }
      const oldCurrent = current;
      current = scratch;
      scratch = oldCurrent;
    }

    if (current !== data) data.set(current);
    outputContext.putImageData(output, 0, 0);
    return true;
  }

  global.LocalWatermarkInpaint = { buildPlan, applyPlan };
})(window);
