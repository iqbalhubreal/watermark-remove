/*
 * LocalWatermarkWebM
 * A small WebM (Matroska) muxer for WebCodecs output. It stores every encoded chunk with its
 * exact presentation timestamp, so the exported file has the true frame timing of the source
 * instead of whatever a real-time recorder happened to capture. Includes the total duration
 * and a seek index (Cues), so players show the right length and can scrub.
 *
 *   const mux = new LocalWatermarkWebM.Muxer({ video: {codecId, width, height}, audio: {...} });
 *   mux.addVideo(chunk, isKeyframe);           // EncodedVideoChunk (timestamp in microseconds)
 *   mux.addAudio(chunk);                       // EncodedAudioChunk
 *   const blob = mux.finish();
 */
(function (global) {
  'use strict';

  const enc = new TextEncoder();

  // ---- EBML encoding helpers ---------------------------------------------------------------
  function idBytes(id) {                       // element IDs already carry their length marker
    const out = [];
    for (let shift = 24; shift >= 0; shift -= 8) {
      const b = Math.floor(id / Math.pow(2, shift)) & 0xff;
      if (out.length || b) out.push(b);
    }
    return new Uint8Array(out);
  }
  function sizeBytes(value) {                  // always 8 bytes: simple and valid
    const out = new Uint8Array(8);
    out[0] = 0x01;
    let v = value;
    for (let i = 7; i >= 1; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
    return out;
  }
  function uintBytes(value) {
    const out = [];
    let v = value;
    do { out.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0);
    return new Uint8Array(out);
  }
  function float64Bytes(value) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, value, false);
    return out;
  }
  function float32Bytes(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setFloat32(0, value, false);
    return out;
  }
  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
  function el(id, payload) { return concat([idBytes(id), sizeBytes(payload.length), payload]); }
  const elUint = (id, v) => el(id, uintBytes(v));
  const elStr = (id, s) => el(id, enc.encode(s));
  const elF64 = (id, v) => el(id, float64Bytes(v));
  const elF32 = (id, v) => el(id, float32Bytes(v));

  function medianDelta(times) {
    if (times.length < 2) return 0;
    const d = [];
    for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
    d.sort((a, b) => a - b);
    return d[d.length >> 1];
  }

  class Muxer {
    constructor(options) {
      this.video = options.video;
      this.audio = options.audio || null;
      this.blocks = [];                        // {track, timeUs, key, data}
    }

    addVideo(chunk, isKey) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      this.blocks.push({ track: 1, timeUs: chunk.timestamp, key: !!isKey, data });
    }

    addAudio(chunk) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      this.blocks.push({ track: 2, timeUs: chunk.timestamp, key: true, data });
    }

    // Longest of the video and audio tracks, in milliseconds.
    durationMs(frameIntervalUs) {
      let end = 0;
      for (const b of this.blocks) {
        let t = b.timeUs;
        if (b.track === 1) t += frameIntervalUs;
        else t += this.audio && this.audio.chunkDurationUs ? this.audio.chunkDurationUs : 20000;
        if (t > end) end = t;
      }
      return end / 1000;
    }

    finish() {
      const blocks = this.blocks.slice().sort((a, b) => a.timeUs - b.timeUs || a.track - b.track);
      const videoTimes = blocks.filter(b => b.track === 1).map(b => b.timeUs);
      const frameIntervalUs = medianDelta(videoTimes) || 33333;

      const header = el(0x1A45DFA3, concat([
        elUint(0x4286, 1), elUint(0x42F7, 1), elUint(0x42F2, 4), elUint(0x42F3, 8),
        elStr(0x4282, 'webm'), elUint(0x4287, 4), elUint(0x4285, 2)
      ]));

      const info = el(0x1549A966, concat([
        elUint(0x2AD7B1, 1000000),
        elStr(0x4D80, 'Local Watermark Studio'), elStr(0x5741, 'Local Watermark Studio'),
        elF64(0x4489, this.durationMs(frameIntervalUs))
      ]));

      const v = this.video;
      const videoTrack = el(0xAE, concat([
        elUint(0xD7, 1), elUint(0x73C5, 1), elUint(0x83, 1), elStr(0x86, v.codecId),
        elUint(0x23E383, Math.round(frameIntervalUs * 1000)),
        el(0xE0, concat([elUint(0xB0, v.width), elUint(0xBA, v.height)]))
      ]));
      const tracks = [videoTrack];
      if (this.audio) {
        const a = this.audio;
        tracks.push(el(0xAE, concat([
          elUint(0xD7, 2), elUint(0x73C5, 2), elUint(0x83, 2), elStr(0x86, 'A_OPUS'),
          el(0x63A2, a.codecPrivate),
          elUint(0x56AA, Math.round((a.preSkip || 0) / 48000 * 1e9)),
          elUint(0x56BB, 80000000),
          el(0xE1, concat([elF32(0xB5, a.sampleRate), elUint(0x9F, a.channels)]))
        ])));
      }
      const tracksEl = el(0x1654AE6B, concat(tracks));

      // Clusters: start a new one at a video keyframe once the current one is at least a second long.
      const clusters = [];
      const cues = [];                         // {timeMs, clusterOffset}
      let current = null, offset = info.length + tracksEl.length;
      const flush = () => {
        if (!current) return;
        // A cluster is its Timecode element followed by the blocks.
        const payload = concat([elUint(0xE7, current.startMs), concat(current.parts)]);
        const cluster = concat([idBytes(0x1F43B675), sizeBytes(payload.length), payload]);
        current.offset = offset;
        offset += cluster.length;
        clusters.push(cluster);
        current = null;
      };
      let lastMs = -1;
      for (const b of blocks) {
        let ms = Math.round(b.timeUs / 1000);
        if (ms < lastMs) ms = lastMs;          // keep millisecond timestamps non-decreasing
        lastMs = ms;
        if (!current || (b.track === 1 && b.key && ms - current.startMs >= 1000) || ms - current.startMs > 30000) {
          flush();
          current = { startMs: ms, parts: [], offset: 0, hasKey: false };
        }
        const rel = ms - current.startMs;
        const head = new Uint8Array(4);
        head[0] = 0x80 | b.track;
        head[1] = (rel >> 8) & 0xff; head[2] = rel & 0xff;
        head[3] = b.key ? 0x80 : 0x00;
        const payload = concat([head, b.data]);
        current.parts.push(concat([idBytes(0xA3), sizeBytes(payload.length), payload]));
        if (b.track === 1 && b.key && !current.hasKey) {
          current.hasKey = true;
          cues.push({ timeMs: ms, cluster: current });
        }
      }
      flush();

      const cuePoints = cues.map(c => el(0xBB, concat([
        elUint(0xB3, c.timeMs),
        el(0xB7, concat([elUint(0xF7, 1), elUint(0xF1, c.cluster.offset)]))
      ])));
      const cuesEl = el(0x1C53BB6B, concat(cuePoints));

      const segmentPayload = concat([info, tracksEl, ...clusters, cuesEl]);
      const segment = concat([idBytes(0x18538067), sizeBytes(segmentPayload.length)]);
      return new Blob([header, segment, segmentPayload], { type: 'video/webm' });
    }
  }

  global.LocalWatermarkWebM = { Muxer };
})(window);
