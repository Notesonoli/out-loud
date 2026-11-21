// Out Loud: natural voice engine.
// Runs inside the extension (Firefox: the background page; Chrome/Edge: an
// offscreen page). It turns text into speech with the Kokoro model ON YOUR
// COMPUTER and plays it. The text you read is never sent anywhere. The only
// network requests are a one-time download of the voice model from Hugging Face
// and, if you enter one, checking your Pro licence key with Gumroad.

import { KokoroTTS, env } from "../vendor/kokoro.web.js";
import { getPro, freeLeft, useFree } from "../pro.js";

const api = globalThis.browser ?? globalThis.chrome;
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const CACHE_MAX = 12;

env.wasmPaths = api.runtime.getURL("vendor/ort/");

let ttsPromise = null; // the loaded model, shared by every tab
let loadPct = 0;
const listeners = new Set(); // ports waiting to hear about loading progress

function loadModel() {
  if (ttsPromise) return ttsPromise;
  const seen = new Map();
  ttsPromise = KokoroTTS.from_pretrained(MODEL, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p) => {
      if (p.status !== "progress" || !p.total) return;
      // Only the big model file matters; small config files would make the
      // percentage jump around.
      if (p.total < 1e6) return;
      seen.set(p.file, [p.loaded, p.total]);
      let loaded = 0, total = 0;
      for (const [l, t] of seen.values()) { loaded += l; total += t; }
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      if (pct !== loadPct) {
        loadPct = pct;
        for (const port of listeners) safePost(port, { type: "loading", pct });
      }
    },
  }).catch((err) => {
    ttsPromise = null; // let the next attempt retry (e.g. after going online)
    throw err;
  });
  return ttsPromise;
}

// ---------- synthesis queue (one sentence at a time, the current one first) ----------

const cache = new Map(); // key -> Promise<{ audio, rate, ms }>
const queue = []; // { key, text, voice, speed, resolve, reject }
let busy = false;

const keyFor = (text, voice, speed) => `${voice}|${speed}|${text}`;

function synth(text, voice, speed, urgent) {
  const key = keyFor(text, voice, speed);
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key); cache.set(key, hit); // most recently used last
    if (urgent) {
      const i = queue.findIndex((j) => j.key === key);
      if (i > 0) queue.unshift(...queue.splice(i, 1));
    }
    return hit;
  }
  const p = new Promise((resolve, reject) => {
    const job = { key, text, voice, speed, resolve, reject };
    if (urgent) queue.unshift(job); else queue.push(job);
  });
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  pump();
  return p;
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        const tts = await loadModel();
        const t0 = performance.now();
        const out = await tts.generate(job.text, { voice: job.voice, speed: job.speed });
        job.resolve({ audio: out.audio, rate: out.sampling_rate, ms: performance.now() - t0 });
      } catch (err) {
        job.reject(err);
      }
    }
  } finally {
    busy = false;
  }
}

function dropPrefetches() {
  // Forget queued look-ahead work that nobody is waiting for any more.
  for (const job of queue.splice(0)) {
    cache.delete(job.key);
    job.reject(new Error("dropped"));
  }
}

// ---------- playback ----------

let ctx = null;
function audioContext() {
  if (!ctx || ctx.state === "closed") ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function safePost(port, msg) {
  try { port.postMessage(msg); } catch { /* tab went away */ }
}

// Each tab that reads with a natural voice holds one port.
function onPort(port) {
  if (port.name !== "outloud-tts") return;
  let source = null;
  let current = 0; // id of the sentence we're meant to be playing
  listeners.add(port);

  const stop = () => {
    current = 0;
    if (source) { source.onended = null; try { source.stop(); } catch { /* not started */ } }
    source = null;
  };

  async function speak(msg) {
    stop();
    dropPrefetches();
    const id = msg.id;
    current = id;
    const pro = await getPro();
    if (!pro.active) {
      if ((await freeLeft()) <= 0) { safePost(port, { type: "limit", id }); current = 0; return; }
    }
    // Kokoro sounds best between 0.5x and 2x; faster speeds also speed up playback.
    const speed = Math.max(0.5, Math.min(2, msg.rate || 1));
    const playbackRate = (msg.rate || 1) > 2 ? msg.rate / 2 : 1;
    if (!ttsPromise || loadPct < 100) {
      loadModel().then(() => { loadPct = 100; safePost(port, { type: "ready" }); }).catch(() => {});
    }
    let clip;
    try {
      clip = await synth(msg.text, msg.voice, speed, true);
    } catch (err) {
      if (current !== id) return;
      safePost(port, { type: "error", id, message: String(err?.message ?? err) });
      return;
    }
    if (current !== id) return; // paused or moved on while we were working
    if (!pro.active) await useFree();
    const ac = audioContext();
    const buf = ac.createBuffer(1, clip.audio.length, clip.rate);
    buf.copyToChannel(clip.audio, 0);
    source = ac.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = playbackRate;
    source.connect(ac.destination);
    source.onended = () => {
      if (current !== id) return;
      source = null;
      current = 0;
      safePost(port, { type: "ended", id });
    };
    source.start();
    const seconds = clip.audio.length / clip.rate;
    // Slower than real time means there may be pauses between sentences.
    safePost(port, { type: "started", id, slow: clip.ms > seconds * 1000 * 1.1, left: pro.active ? null : await freeLeft() });
    // Get the next sentences ready while this one plays.
    for (const t of (msg.ahead || []).slice(0, 2)) synth(t, msg.voice, speed, false).catch(() => {});
  }

  port.onMessage.addListener((msg) => {
    if (msg?.type === "speak") {
      speak(msg).catch((err) => {
        if (current === msg.id) safePost(port, { type: "error", id: msg.id, message: String(err?.message ?? err) });
      });
    }
    else if (msg?.type === "stop") { stop(); dropPrefetches(); }
    // "ping" just keeps the background page awake while a tab is reading.
  });
  port.onDisconnect.addListener(() => { stop(); listeners.delete(port); });
}

api.runtime.onConnect.addListener(onPort);

// Test hook for the automated tests.
globalThis.__outloudEngine = { loadModel, synth, cache, queue };
