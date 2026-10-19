/* Bundled local WebAssembly kernel. The embedded bytes let index.html work from file:// without fetch(). */
(function (global) {
  'use strict';
  const WASM_BASE64 = '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AWotAABB6AdsIBJqIRILIA5BAWoiASAFTg0AIA5Bf0gNACAQQcMFaiEQIAAgASACakECdGoiAi0AAEHDBWwgEWohESACQQJqLQAAQcMFbCATaiETIAJBAWotAABBwwVsIBJqIRILAkAgDCAGTg0AIAxBAEgNAAJAIA4gBUoNACAOQQFIDQAgEEHoB2ohECAOIBRqQQJ0IABqQXxqIgItAABB6AdsIBFqIREgAkECai0AAEHoB2wgE2ohEyACQQFqLQAAQegHbCASaiESCyAOQQFqIgIgBU4NACAOQX9IDQAgEEHoB2ohECAAIAIgFGpBAnRqIgItAABB6AdsIBFqIREgAkECai0AAEHoB2wgE2ohEyACQQFqLQAAQegHbCASaiESCwJAAkACQCAMQQFqIgwgBk4NACAMQQBIDQAgDCAFbCEMAkAgDiAFSg0AIA5BAUgNACAQQcMFaiEQIA4gDGpBAnQgAGpBfGoiAi0AAEHDBWwgEWohESACQQJqLQAAQcMFbCATaiETIAJBAWotAABBwwVsIBJqIRILAkAgDiAFTg0AIA5BAEgNACAQQegHaiEQIAAgDiAMakECdGoiAi0AAEHoB2wgEWohESACQQJqLQAAQegHbCATaiETIAJBAWotAABB6AdsIBJqIRILIA5BAWoiAiAFTg0AIA5Bf0gNACAJQQJ0IQ4gEEHDBWohECAAIAIgDGpBAnRqIgwtAABBwwVsIBFqIREgDEECai0AAEHDBWwgE2ohEyAMQQFqLQAAQcMFbCASaiESDAELIAlBAnQhDiAQDQAgBCAOaiAAIA5qLQAAOgAAIAQgDkEBciIQaiAAIBBqLQAAOgAAIAAgDkECciIOai0AACEQDAELIAQgDmogACAOai0AAEHCA2wgESAQbkGmBGxqQegHbjoAACAEIA5BAXIiEWogACARai0AAEHCA2wgEiAQbkGmBGxqQegHbjoAACAAIA5BAnIiDmotAABBwgNsIBMgEG5BpgRsakHoB25B/wFxIRALIAQgDmogEDoAACALQQRqIQsgD0F/aiIPDQALIAMhECAHIREDQCAAIBAoAgBBAnQiDmogBCAOai0AADoAACAAIA5BAXIiEmogBCASai0AADoAACAAIA5BAnIiDmogBCAOai0AADoAACAQQQRqIRAgEUF/aiIRDQALIApBAWoiCiAIRw0A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';
  let instance = null;
  let memory = null;
  let ready = false;
  let disabled = false;
  let heapBase = 0;
  let failure = null;

  const align16 = value => Math.ceil(value / 16) * 16;
  const align4 = value => Math.ceil(value / 4) * 4;
  const PAGE_BYTES = 65536;

  function decodeBase64(value) {
    const binary = global.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function ensureMemory(requiredBytes) {
    const requiredPages = Math.ceil(requiredBytes / PAGE_BYTES);
    const currentPages = memory.buffer.byteLength / PAGE_BYTES;
    if (requiredPages > currentPages) memory.grow(requiredPages - currentPages);
  }

  // Every layout is placed at the start of the heap, so only the most recently built one is intact.
  let activeLayout = null;

  function layoutFor(plan) {
    if (plan.__wasmLayout && plan.__wasmLayout.instance === instance && activeLayout === plan.__wasmLayout) return plan.__wasmLayout;
    const pixels = plan.width * plan.height;
    let offset = align16(heapBase);
    const maskOffset = offset; offset = align4(offset + pixels);
    const distanceOffset = offset; offset = align4(offset + pixels * 2);
    const queueOffset = offset; offset = align4(offset + plan.count * 4);
    const dataOffset = offset; offset = align4(offset + pixels * 4);
    const scratchOffset = offset; offset = align4(offset + pixels * 4);
    ensureMemory(offset);

    new Uint8Array(memory.buffer, maskOffset, pixels).set(plan.mask);
    new Uint16Array(memory.buffer, distanceOffset, pixels).set(plan.distance);
    new Uint32Array(memory.buffer, queueOffset, plan.count).set(plan.queue.subarray(0, plan.count));
    const layout = {instance, width: plan.width, height: plan.height, count: plan.count,
      maskOffset, distanceOffset, queueOffset, dataOffset, scratchOffset, endOffset: offset};
    plan.__wasmLayout = layout;
    activeLayout = layout;
    return layout;
  }

  // ---- texture fill (watermark_texture_fill in src/wasm_fill.c) ----
  const H = { LEVELS: 0, PASSES: 1, IT_FINE: 2, IT_COARSE: 3, IT_WARM: 4, DATA: 5, SCRATCH: 6, STATE_VALID: 7,
              MEAN_COST: 8, SAMPLE: 9, OUT: 10, RESULT: 11, LEVEL0: 16, STRIDE: 16 };
  const SAMPLE_STRIDE = 7;

  function textureLayoutFor(plan) {
    if (plan.__wasmTexLayout && plan.__wasmTexLayout.instance === instance && activeLayout === plan.__wasmTexLayout) return plan.__wasmTexLayout;
    const levels = plan.levels, L = levels.length;
    const w0 = plan.width, h0 = plan.height, area0 = w0 * h0;
    let offset = align16(heapBase);
    const take = bytes => { const at = offset; offset = align16(offset + bytes); return at; };
    const hdr = take((H.LEVEL0 + H.STRIDE * L) * 4);
    const regions = levels.map((lv, l) => {
      const size = lv.width * lv.height;
      return {
        mask: take(size), distance: take(size * 2), queue: take(lv.count * 4), valid: take(size),
        targets: take(lv.targets.length * 4), validList: take(lv.validList.length * 4),
        img: l === 0 ? 0 : take(size * 4), nnf: take(size * 4), cost: take(size * 4), bias: take(size * 6)
      };
    });
    const data = take(area0 * 4);
    const coarsest = levels[L - 1];
    const scratch = take(coarsest.width * coarsest.height * 4);
    const sampleCount = Math.ceil(area0 / SAMPLE_STRIDE);
    const sample = take(sampleCount * 3 * 2);        // previous sample followed by the current one
    const out = take(plan.count * 3);
    ensureMemory(offset);

    const u32 = new Uint32Array(memory.buffer, hdr, H.LEVEL0 + H.STRIDE * L);
    u32.fill(0);
    levels.forEach((lv, l) => {
      const r = regions[l], size = lv.width * lv.height;
      new Uint8Array(memory.buffer, r.mask, size).set(lv.mask);
      new Uint16Array(memory.buffer, r.distance, size).set(lv.distance);
      new Uint32Array(memory.buffer, r.queue, lv.count).set(lv.queue.subarray(0, lv.count));
      new Uint8Array(memory.buffer, r.valid, size).set(lv.valid);
      new Uint32Array(memory.buffer, r.targets, lv.targets.length).set(lv.targets);
      new Uint32Array(memory.buffer, r.validList, lv.validList.length).set(lv.validList);
      new Int32Array(memory.buffer, r.nnf, size).fill(-1);
      const e = H.LEVEL0 + l * H.STRIDE;
      u32[e] = lv.width; u32[e + 1] = lv.height; u32[e + 2] = lv.count; u32[e + 3] = lv.targets.length;
      u32[e + 4] = lv.validList.length; u32[e + 5] = lv.radius;
      u32[e + 6] = r.mask; u32[e + 7] = r.distance; u32[e + 8] = r.queue; u32[e + 9] = r.valid;
      u32[e + 10] = r.targets; u32[e + 11] = r.validList; u32[e + 12] = l === 0 ? data : r.img;
      u32[e + 13] = r.nnf; u32[e + 14] = r.cost; u32[e + 15] = r.bias;
    });
    u32[H.LEVELS] = L; u32[H.DATA] = data; u32[H.SCRATCH] = scratch; u32[H.SAMPLE] = sample; u32[H.OUT] = out;
    const layout = { instance, hdr, data, pixels: area0 * 4, endOffset: offset };
    plan.__wasmTexLayout = layout;
    activeLayout = layout;
    return layout;
  }

  function tryApplyTexture(sourceContext, outputContext, plan, requestedPasses = 0) {
    if (!ready || disabled || !instance || !plan || !plan.count || !plan.levels) return false;
    try {
      const inpaint = global.LocalWatermarkInpaint;
      const layout = textureLayoutFor(plan);
      ensureMemory(layout.endOffset);
      const source = sourceContext.getImageData(0, 0, plan.width, plan.height);
      new Uint8Array(memory.buffer, layout.data, layout.pixels).set(source.data);
      const passes = inpaint.normalisePasses(requestedPasses, plan.count);
      const it = inpaint.textureIterations(passes, plan.count);
      const hdr = new Uint32Array(memory.buffer, layout.hdr, H.LEVEL0);
      hdr[H.PASSES] = passes; hdr[H.IT_FINE] = it.fine; hdr[H.IT_COARSE] = it.coarse; hdr[H.IT_WARM] = it.warm;
      instance.exports.watermark_texture_fill(layout.hdr);
      if (!hdr[H.RESULT]) return false;
      const output = outputContext.createImageData(plan.width, plan.height);
      output.data.set(new Uint8Array(memory.buffer, layout.data, layout.pixels));
      outputContext.putImageData(output, 0, 0);
      return true;
    } catch (error) {
      failure = error;
      disabled = true;
      return false;
    }
  }

  // Forget the previous frame so the next fill starts from scratch (seek, new selection, export start).
  function resetTemporal(plan) {
    if (!ready || !plan || !plan.__wasmTexLayout || activeLayout !== plan.__wasmTexLayout) return;
    new Uint32Array(memory.buffer, plan.__wasmTexLayout.hdr, H.LEVEL0)[H.STATE_VALID] = 0;
  }

  function tryApply(sourceContext, outputContext, plan, requestedPasses = 0) {
    if (!ready || disabled || !instance || !plan || !plan.count) return false;
    try {
      const layout = layoutFor(plan);
      ensureMemory(layout.endOffset);
      const source = sourceContext.getImageData(0, 0, plan.width, plan.height);
      const bytes = new Uint8Array(memory.buffer, layout.dataOffset, source.data.length);
      bytes.set(source.data);
      const defaultPasses = plan.count < 25000 ? 8 : plan.count < 120000 ? 5 : plan.count < 350000 ? 3 : 1;
      const passes = Number.isFinite(Number(requestedPasses)) && Number(requestedPasses) > 0 ? Math.max(1, Math.min(16, Math.round(Number(requestedPasses)))) : defaultPasses;
      instance.exports.watermark_diffusion_fill(
        layout.dataOffset, layout.maskOffset, layout.distanceOffset, layout.queueOffset,
        layout.scratchOffset, plan.width, plan.height, plan.count, passes
      );
      const resultBytes = new Uint8Array(memory.buffer, layout.dataOffset, source.data.length);
      const output = outputContext.createImageData(plan.width, plan.height);
      output.data.set(resultBytes);
      outputContext.putImageData(output, 0, 0);
      return true;
    } catch (error) {
      failure = error;
      disabled = true;
      return false;
    }
  }

  const readyPromise = (async () => {
    if (!global.WebAssembly) throw new Error('WebAssembly is not supported in this browser.');
    const result = await global.WebAssembly.instantiate(decodeBase64(WASM_BASE64), {});
    instance = result.instance;
    memory = instance.exports.memory;
    const heap = instance.exports.__heap_base;
    heapBase = align16(Number(heap && typeof heap === 'object' && 'value' in heap ? heap.value : heap) || 65536);
    ready = true;
    if (typeof global.dispatchEvent === 'function' && typeof global.Event === 'function') {
      global.dispatchEvent(new global.Event('watermark-wasm-ready'));
    }
    return true;
  })().catch(error => {
    failure = error;
    disabled = true;
    return false;
  });

  global.LocalWatermarkWasm = {
    readyPromise,
    isReady: () => ready && !disabled,
    tryApply,
    tryApplyTexture,
    resetTemporal,
    getError: () => failure ? String(failure.message || failure) : ''
  };
})(window);
