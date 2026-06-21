"use strict";

/**
 * Cross-platform audio relay (replaces the two Linux FIFOs) — realtime
 * pacer edition.
 *
 *        web music FFmpeg (-re, s16le)              streamer FFmpeg
 *          tcp://127.0.0.1:inPort  ──▶  RELAY  ──▶  tcp://127.0.0.1:outPort
 *                                        │
 *                                        └─ paces a STEADY realtime PCM
 *                                           stream to the consumer: music
 *                                           when buffered, silence on
 *                                           underrun — always, regardless
 *                                           of whether a writer is
 *                                           connected or healthy.
 *
 * Why a pacer (v1.15.1): the streamer's FFmpeg uses this audio input as
 * its timing master. The old relay forwarded writer bytes straight
 * through and only emitted silence when NO writer was connected — so if
 * the music FFmpeg connected but stalled (or its socket got aborted,
 * the Windows -10053 case), the consumer starved, FFmpeg's muxer
 * blocked, and the whole pipeline (including VIDEO) ground to a few fps.
 *
 * The pacer fixes that: it writes exactly realtime-worth of PCM to the
 * consumer on every tick, drawing from a small jitter buffer of music
 * bytes and padding with silence whenever the buffer underruns. The
 * consumer therefore never starves and never sees a gap, so the video
 * pipeline stays at full frame rate no matter what the music side does.
 *
 * Audio format is fixed s16le / 44.1 kHz / stereo.
 */

const net = require("node:net");

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE;                  // 4
const BYTES_PER_SEC = SAMPLE_RATE * FRAME_BYTES;                  // 176400
const TICK_MS = 25;                                              // pacer cadence
// Cap the music jitter buffer so a writer that briefly outruns realtime
// (bursts, decode catch-up) can't build unbounded latency. ~2s.
const MAX_MUSIC_BUFFER = Math.round(BYTES_PER_SEC * 2);
// Build this much of a cushion before we start draining music, so small
// hiccups in the -re music feed (decode jitter, CPU contention) don't
// underrun and inject audible silence ("music cuts every so often").
const PRIME_BYTES = Math.round(BYTES_PER_SEC * 0.25);
// If the consumer (streamer FFmpeg) ever stops reading, don't queue more
// than ~1s of audio into its socket — drop instead of growing RAM.
const MAX_CONSUMER_BACKLOG = BYTES_PER_SEC;
// Reusable silence block (one tick's worth, plus slack).
const SILENCE = Buffer.alloc(Math.ceil(BYTES_PER_SEC * (TICK_MS + 50) / 1000));

class AudioRelay {
  constructor({ inPort, outPort, logger }) {
    this.inPort = inPort;
    this.outPort = outPort;
    this.logger = logger || console;
    this.writer = null;      // connected web music FFmpeg socket
    this.consumer = null;    // connected streamer FFmpeg socket
    this.music = [];         // queued music Buffers (jitter buffer)
    this.musicBytes = 0;
    this.primed = false;     // true once the cushion is built
    this.pacer = null;
    this.clockStart = 0;     // wallclock when the consumer connected
    this.bytesSent = 0;      // bytes written to consumer since clockStart
    this._inServer = null;
    this._outServer = null;
  }

  start() {
    // IN: accept the per-track music writer. Only the latest writer's
    // bytes feed the jitter buffer; an older one (mid-handoff) is dropped.
    this._inServer = net.createServer((sock) => {
      if (this.writer) { try { this.writer.destroy(); } catch {} }
      this.writer = sock;
      sock.on("data", (chunk) => {
        // Only the current writer feeds the buffer — drop a lingering
        // old track's bytes during a handoff so PCM never interleaves.
        if (sock !== this.writer) return;
        this.music.push(chunk);
        this.musicBytes += chunk.length;
        // Trim from the front if we've buffered too much (keeps latency
        // bounded; a steady -re writer never trips this).
        while (this.musicBytes > MAX_MUSIC_BUFFER && this.music.length > 1) {
          const old = this.music.shift();
          this.musicBytes -= old.length;
        }
      });
      const clear = () => { if (this.writer === sock) this.writer = null; };
      sock.on("close", clear);
      sock.on("error", clear);   // isolate writer errors (e.g. -10053)
    });
    this._inServer.on("error", (e) => this.logger.warn?.({ err: e?.message }, "audio relay in-server error"));
    this._inServer.listen(this.inPort, "127.0.0.1");

    // OUT: accept the streamer FFmpeg consumer and pace realtime PCM to it.
    this._outServer = net.createServer((sock) => {
      if (this.consumer) { try { this.consumer.destroy(); } catch {} }
      this.consumer = sock;
      this.clockStart = Date.now();
      this.bytesSent = 0;
      this.primed = false;
      sock.on("error", () => {});
      const clear = () => { if (this.consumer === sock) this.consumer = null; };
      sock.on("close", clear);
    });
    this._outServer.on("error", (e) => this.logger.warn?.({ err: e?.message }, "audio relay out-server error"));
    this._outServer.listen(this.outPort, "127.0.0.1");

    // Realtime pacer: on each tick, top the consumer up to exactly the
    // amount of audio that should have been delivered by now (computed
    // from elapsed wallclock, so it self-corrects against timer drift).
    this.pacer = setInterval(() => this._tick(), TICK_MS);
    this.pacer.unref?.();

    this.logger.info?.({ inPort: this.inPort, outPort: this.outPort }, "audio relay listening (realtime pacer)");
  }

  _tick() {
    const c = this.consumer;
    if (!c || !c.writable) return;

    // How many bytes SHOULD have been sent by now.
    const elapsedMs = Date.now() - this.clockStart;
    let need = Math.floor((BYTES_PER_SEC * elapsedMs) / 1000) - this.bytesSent;
    if (need <= 0) return;
    need -= need % FRAME_BYTES;                 // keep whole stereo frames
    if (need <= 0) return;

    // If the consumer has stopped draining, don't pile on unbounded RAM —
    // skip this tick's audio (FFmpeg will catch the timeline back up).
    if ((c.writableLength || 0) > MAX_CONSUMER_BACKLOG) {
      this.bytesSent += need;                   // keep the clock honest
      return;
    }

    // Only start draining music once a cushion has built; if we ever
    // drain it completely, re-prime before resuming so the next blip of
    // jitter doesn't immediately underrun again.
    if (!this.primed && this.musicBytes >= PRIME_BYTES) this.primed = true;

    const out = Buffer.allocUnsafe(need);
    let filled = 0;

    if (this.primed) {
      while (filled < need && this.music.length) {
        const head = this.music[0];
        const take = Math.min(head.length, need - filled);
        head.copy(out, filled, 0, take);
        filled += take;
        if (take === head.length) { this.music.shift(); this.musicBytes -= head.length; }
        else { this.music[0] = head.subarray(take); this.musicBytes -= take; }
      }
      if (this.musicBytes === 0) this.primed = false; // underran → re-prime
    }
    // Pad the remainder with silence (underrun / not yet primed → quiet,
    // never a gap in the realtime stream the streamer reads).
    if (filled < need) {
      SILENCE.copy(out, filled, 0, need - filled);
    }

    c.write(out);
    this.bytesSent += need;
  }

  stop() {
    if (this.pacer) { clearInterval(this.pacer); this.pacer = null; }
    for (const s of [this.writer, this.consumer]) { try { s?.destroy(); } catch {} }
    this.writer = this.consumer = null;
    this.music = []; this.musicBytes = 0;
    try { this._inServer?.close(); } catch {}
    try { this._outServer?.close(); } catch {}
  }
}

module.exports = { AudioRelay };
