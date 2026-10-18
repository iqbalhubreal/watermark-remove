/* Bundled local WebAssembly kernel. The embedded bytes let index.html work from file:// without fetch(). */
(function (global) {
  'use strict';
  const WASM_BASE64 = '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';
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

  function layoutFor(plan) {
    if (plan.__wasmLayout && plan.__wasmLayout.instance === instance) return plan.__wasmLayout;
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
    return layout;
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
    getError: () => failure ? String(failure.message || failure) : ''
  };
})(window);
