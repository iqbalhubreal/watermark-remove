/*
 * LocalWatermarkExport
 * Frame-accurate video export.
 *
 * The old exporter played the video in real time and recorded the canvas, so whenever the fill
 * took longer than one frame the recording repeated or dropped frames and the result looked
 * jerky. This exporter does not depend on speed at all:
 *
 *   1. It steps through the source one decoded frame at a time (the video is paused while a
 *      frame is processed), reading each frame's true presentation time.
 *   2. Every frame is processed once and handed to a WebCodecs VideoEncoder with that exact
 *      timestamp, so frame timing and count match the source.
 *   3. The source audio is decoded and re-encoded to Opus separately, so it stays in sync.
 *   4. js/webm-writer.js packs everything into a WebM with the right duration and seek index.
 *
 * Everything runs locally. Nothing is uploaded.
 */
(function (global) {
  'use strict';

  const WAIT_FOR_FRAME_MS = 6000;
  const MAX_PLAYBACK_RATE = 0.5;   // slow enough that pausing inside a frame callback never skips one
  const MAX_AUDIO_FILE_BYTES = 600 * 1024 * 1024;

  function isSupported() {
    return !!(global.VideoEncoder && global.VideoFrame && global.LocalWatermarkWebM &&
      global.HTMLVideoElement && 'requestVideoFrameCallback' in global.HTMLVideoElement.prototype);
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function pickVideoConfig(width, height, bitrate, framerate) {
    const codecs = [['vp09.00.51.08', 'V_VP9'], ['vp09.00.41.08', 'V_VP9'], ['vp09.00.31.08', 'V_VP9'], ['vp8', 'V_VP8']];
    for (const [codec, codecId] of codecs) {
      const config = { codec, width, height, bitrate, framerate, latencyMode: 'quality', bitrateMode: 'variable' };
      try {
        const result = await global.VideoEncoder.isConfigSupported(config);
        if (result && result.supported) return { config, codecId };
      } catch (e) { /* try the next codec */ }
    }
    return null;
  }

  // Decode the source's audio and encode it to Opus. Returns null when there is none or it can't be read.
  async function encodeAudio(file, signal) {
    if (!global.AudioEncoder || !global.AudioData || !(global.AudioContext || global.webkitAudioContext)) return { note: 'This browser cannot re-encode audio, so the export is silent.' };
    if (file.size > MAX_AUDIO_FILE_BYTES) return { note: 'The file is too large to read its audio here, so the export is silent.' };
    const encoderConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 };
    try {
      const support = await global.AudioEncoder.isConfigSupported(encoderConfig);
      if (!support || !support.supported) return { note: 'This browser cannot encode Opus audio, so the export is silent.' };
    } catch (e) { return { note: 'This browser cannot encode Opus audio, so the export is silent.' }; }

    let buffer;
    const Ctx = global.AudioContext || global.webkitAudioContext;
    const audioCtx = new Ctx({ sampleRate: 48000 });
    try {
      const bytes = await file.arrayBuffer();
      buffer = await audioCtx.decodeAudioData(bytes);
    } catch (e) {
      try { audioCtx.close(); } catch (e2) { /* ignore */ }
      return { note: 'No readable audio track was found, so the export is silent.' };
    }
    try { audioCtx.close(); } catch (e) { /* ignore */ }
    if (!buffer || !buffer.length) return { note: 'No readable audio track was found, so the export is silent.' };

    const chunks = [];
    let description = null, failure = null;
    const encoder = new global.AudioEncoder({
      output: (chunk, meta) => {
        chunks.push(chunk);
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !description) {
          description = new Uint8Array(ArrayBuffer.isView(meta.decoderConfig.description)
            ? meta.decoderConfig.description.buffer.slice(meta.decoderConfig.description.byteOffset, meta.decoderConfig.description.byteOffset + meta.decoderConfig.description.byteLength)
            : meta.decoderConfig.description);
        }
      },
      error: e => { failure = e; }
    });
    encoder.configure(encoderConfig);
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    const FRAMES = 4800;
    for (let start = 0; start < buffer.length; start += FRAMES) {
      if (signal.aborted || failure) break;
      const n = Math.min(FRAMES, buffer.length - start);
      const planar = new Float32Array(n * 2);
      planar.set(left.subarray(start, start + n), 0);
      planar.set(right.subarray(start, start + n), n);
      const data = new global.AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(start / 48000 * 1e6), data: planar });
      encoder.encode(data);
      data.close();
      while (encoder.encodeQueueSize > 16) await sleep(2);
    }
    if (signal.aborted) { try { encoder.close(); } catch (e) { /* ignore */ } return null; }
    await encoder.flush();
    try { encoder.close(); } catch (e) { /* ignore */ }
    if (failure || !chunks.length) return { note: 'The audio could not be encoded, so the export is silent.' };

    // OpusHead for the track header, used when the encoder does not hand one over.
    let head = description;
    if (!head || head.length < 19) {
      head = new Uint8Array(19);
      head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);   // "OpusHead"
      head[8] = 1; head[9] = 2;
      new DataView(head.buffer).setUint16(10, 312, true);              // pre-skip
      new DataView(head.buffer).setUint32(12, 48000, true);
    }
    const preSkip = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(10, true);
    return { chunks, track: { codecPrivate: head, preSkip, sampleRate: 48000, channels: 2, chunkDurationUs: 20000 } };
  }

  // Measure the source frame interval by letting it play for a moment.
  function measureFrameInterval(video) {
    return new Promise(resolve => {
      const times = [];
      let handle = 0, done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { video.pause(); } catch (e) { /* ignore */ }
        if (handle && video.cancelVideoFrameCallback) { try { video.cancelVideoFrameCallback(handle); } catch (e) { /* ignore */ } }
        if (times.length < 3) return resolve(1 / 30);
        const d = [];
        for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
        d.sort((a, b) => a - b);
        resolve(d.length ? d[d.length >> 1] : 1 / 30);
      };
      const cb = (now, meta) => {
        times.push(meta.mediaTime);
        if (times.length >= 12) finish(); else handle = video.requestVideoFrameCallback(cb);
      };
      handle = video.requestVideoFrameCallback(cb);
      video.playbackRate = 1;
      video.play().catch(finish);
      setTimeout(finish, 2000);
    });
  }

  function seekTo(video, time) {
    return new Promise(resolve => {
      if (Math.abs(video.currentTime - time) < 1e-4 && video.readyState >= 2) return resolve();
      const done = () => { video.removeEventListener('seeked', done); resolve(); };
      video.addEventListener('seeked', done);
      video.currentTime = time;
    });
  }

  // Seek (while paused) to `time` and capture the frame shown there, returning its presentation time
  // only when it lies strictly between `after` and `before`.
  function probeFrame(video, time, after, before, ctx, width, height) {
    return new Promise(resolve => {
      let handle = 0, done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (handle && video.cancelVideoFrameCallback) { try { video.cancelVideoFrameCallback(handle); } catch (e) { /* ignore */ } }
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 700);
      handle = video.requestVideoFrameCallback((now, meta) => {
        if (meta.mediaTime > after + 1e-6 && meta.mediaTime < before - 1e-6) {
          ctx.drawImage(video, 0, 0, width, height);
          finish(meta.mediaTime);
        } else finish(null);
      });
      video.currentTime = time;
    });
  }

  /*
   * options:
   *   video, file         the source <video> and its File
   *   render(ctx, canvas, sourceCanvas)   draws one processed frame; sourceCanvas holds the raw frame
   *   onProgress(fraction, text)
   *   onPreview(canvas)   called now and then with the latest processed frame
   *   signal              { aborted: boolean }, set it to true to cancel
   * Returns { blob, frames, audioNote, hasAudio } or null when cancelled.
   */
  async function run(options) {
    const { video, file, render, onProgress, onPreview, signal } = options;
    const width = video.videoWidth, height = video.videoHeight;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const wasMuted = video.muted, oldRate = video.playbackRate;
    const state = { error: null };
    let encoder = null;

    const snap = document.createElement('canvas');
    snap.width = width; snap.height = height;
    const snapCtx = snap.getContext('2d', { willReadFrequently: false });
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = width; probeCanvas.height = height;
    const probeCtx = probeCanvas.getContext('2d');
    const outCanvas = document.createElement('canvas');
    outCanvas.width = width; outCanvas.height = height;
    const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });

    try {
      video.pause();
      video.muted = true;
      onProgress(0, 'Preparing video…');

      await seekTo(video, 0);
      const interval = await measureFrameInterval(video);
      const fps = Math.max(1, Math.min(120, 1 / interval));
      const bitrate = Math.round(Math.max(2.5e6, Math.min(40e6, width * height * Math.max(24, fps) * 0.12)));
      const picked = await pickVideoConfig(width, height, bitrate, fps);
      if (!picked) throw new Error('No supported video encoder');

      const chunks = [];
      encoder = new global.VideoEncoder({
        output: chunk => { chunks.push({ chunk, key: chunk.type === 'key' }); },
        error: e => { state.error = e; }
      });
      encoder.configure(picked.config);

      onProgress(0, 'Preparing audio…');
      const audio = await encodeAudio(file, signal);
      if (signal.aborted) return null;

      await seekTo(video, 0);
      // Faster sources need a slower clock so the pause after a frame callback always lands before the next frame.
      video.playbackRate = Math.max(0.1, Math.min(MAX_PLAYBACK_RATE, interval * 20));
      const keyEvery = Math.max(1, Math.round(fps * 2));
      let lastMedia = -1, lastTs = -1, count = 0;
      const startedAt = performance.now();

      // Wait for the next newly presented frame, freezing the video on it.
      const nextFrame = () => new Promise((resolve, reject) => {
        if (signal.aborted) return resolve(null);
        if (video.ended) return resolve(null);
        let settled = false, handle = 0, watchdog = 0, endTimer = 0;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog); clearTimeout(endTimer);
          video.removeEventListener('ended', onEnded);
          video.removeEventListener('error', onError);
          if (handle && video.cancelVideoFrameCallback) { try { video.cancelVideoFrameCallback(handle); } catch (e) { /* ignore */ } }
          resolve(value);
        };
        const onEnded = () => { endTimer = setTimeout(() => finish(null), 120); };   // let a pending frame callback win
        const onError = () => { if (!settled) { settled = true; clearTimeout(watchdog); reject(new Error('The video failed during export.')); } };
        const cb = (now, meta) => {
          if (settled) return;
          if (meta.mediaTime <= lastMedia + 1e-6) { handle = video.requestVideoFrameCallback(cb); return; }   // same frame again
          video.pause();
          snapCtx.drawImage(video, 0, 0, width, height);
          finish({ mediaTime: meta.mediaTime });
        };
        video.addEventListener('ended', onEnded);
        video.addEventListener('error', onError);
        handle = video.requestVideoFrameCallback(cb);
        watchdog = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Video playback stalled during export.')); } }, WAIT_FOR_FRAME_MS);
        const start = async () => {
          while (document.hidden && !signal.aborted && !settled) {
            onProgress(duration ? Math.max(0, lastMedia) / duration : 0, 'Export paused while this tab is hidden. Return to this tab to continue.');
            await new Promise(r => document.addEventListener('visibilitychange', r, { once: true }));
          }
          if (settled) return;
          clearTimeout(watchdog);
          watchdog = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Video playback stalled during export.')); } }, WAIT_FOR_FRAME_MS);
          try { await video.play(); } catch (e) { if (!settled) { settled = true; reject(e); } }
        };
        start();
      });

      // The first frame is already on screen after the seek, so no frame callback will announce it.
      snapCtx.drawImage(video, 0, 0, width, height);
      let primed = { mediaTime: 0 };

      while (true) {
        if (signal.aborted) return null;
        if (state.error) throw state.error;
        const frame = primed || await nextFrame();
        primed = null;
        if (!frame) break;

        // If pausing came too late the clock may have moved past a frame. Look for a frame between the
        // last one and this one; on variable-frame-rate video there is often none and that is fine.
        const pending = [];
        if (lastMedia >= 0 && frame.mediaTime - lastMedia > interval * 1.6) {
          const probe = await probeFrame(video, lastMedia + interval * 0.5, lastMedia, frame.mediaTime, probeCtx, width, height);
          if (probe) pending.push({ mediaTime: probe, canvas: probeCanvas });
        }
        pending.push({ mediaTime: frame.mediaTime, canvas: snap });

        for (const item of pending) {
          render(outCtx, outCanvas, item.canvas);
          let ts = Math.round(item.mediaTime * 1e6);
          if (ts <= lastTs) ts = lastTs + 1;
          const videoFrame = new global.VideoFrame(outCanvas, { timestamp: ts, duration: Math.round(interval * 1e6) });
          encoder.encode(videoFrame, { keyFrame: count % keyEvery === 0 });
          videoFrame.close();
          lastTs = ts; lastMedia = item.mediaTime; count++;
        }
        const mediaTime = lastMedia;

        while (encoder.encodeQueueSize > 6) { if (state.error) break; await sleep(2); }
        if (count % 8 === 0 && onPreview) onPreview(outCanvas);
        const elapsed = (performance.now() - startedAt) / 1000;
        const frac = duration ? Math.min(0.99, mediaTime / duration) : 0;
        const eta = frac > 0.02 ? Math.round(elapsed * (1 - frac) / frac) : 0;
        onProgress(frac, `Processing frame ${count}… ${Math.round(frac * 100)}%${eta ? ` · about ${eta}s left` : ''}`);
      }

      if (signal.aborted) return null;
      if (state.error) throw state.error;
      if (!count) throw new Error('No frames were read from the video.');
      onProgress(0.99, 'Finishing file…');
      await encoder.flush();
      try { encoder.close(); } catch (e) { /* ignore */ }
      encoder = null;
      if (state.error) throw state.error;

      const mux = new global.LocalWatermarkWebM.Muxer({
        video: { codecId: picked.codecId, width, height },
        audio: audio && audio.track ? audio.track : null
      });
      for (const c of chunks) mux.addVideo(c.chunk, c.key);
      if (audio && audio.chunks) for (const c of audio.chunks) mux.addAudio(c);
      const blob = mux.finish();
      return { blob, frames: count, hasAudio: !!(audio && audio.track), audioNote: audio && audio.note ? audio.note : '' };
    } finally {
      if (encoder) { try { encoder.close(); } catch (e) { /* ignore */ } }
      try { video.pause(); } catch (e) { /* ignore */ }
      video.muted = wasMuted;
      video.playbackRate = oldRate;
    }
  }

  global.LocalWatermarkExport = { isSupported, run };
})(window);
