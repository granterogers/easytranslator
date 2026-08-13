// Runs on-device neural translation entirely inside a Worker, so a heavy
// WASM model load/inference never blocks typing on the main thread.
//
// Uses transformers.js loaded from a CDN (no build step, no bundler) to run
// small Helsinki-NLP/opus-mt models converted to ONNX. The first call for a
// given language pair downloads that model (tens of MB); the library caches
// the downloaded files via the browser's Cache Storage, so every call after
// that — including after the tab is closed and reopened, and while fully
// offline — is served from disk with no network request at all.
//
// CAVEAT: the CDN URL and model naming scheme below are correct as of this
// code being written, but this project has already been burned once by a
// hardcoded list of third-party URLs going stale (see js/api.js history) —
// and unlike that one, this file could not be verified against the real
// network before shipping (this dev sandbox cannot reach huggingface.co or
// jsdelivr.net at all). If downloads fail here, check the browser console
// for the actual error before assuming the app is broken — it may just mean
// this URL or model-naming scheme has moved on.
const TRANSFORMERS_CDN_URL = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

let transformersPromise = null;
function loadTransformers() {
  if (!transformersPromise) transformersPromise = import(TRANSFORMERS_CDN_URL);
  return transformersPromise;
}

function modelIdFor(src, tgt) {
  return `Xenova/opus-mt-${src}-${tgt}`;
}

// pairKey -> Promise<translator fn>, so concurrent requests for the same
// pair share one download/load instead of racing duplicate ones, and a
// pair already loaded this session is reused instantly.
const pipelines = new Map();

function getPipeline(src, tgt, onProgress) {
  const key = `${src}:${tgt}`;
  if (!pipelines.has(key)) {
    pipelines.set(key, (async () => {
      const { pipeline, env } = await loadTransformers();
      env.allowLocalModels = false;
      try {
        return await pipeline('translation', modelIdFor(src, tgt), {
          progress_callback: onProgress,
        });
      } catch (err) {
        pipelines.delete(key); // don't cache a failed load — allow retry
        throw err;
      }
    })());
  }
  return pipelines.get(key);
}

self.onmessage = async (event) => {
  const { id, type, src, tgt, text } = event.data;

  try {
    if (type === 'warmup') {
      await getPipeline(src, tgt, (p) => {
        if (p.status === 'progress') {
          self.postMessage({ id, type: 'progress', pct: p.progress || 0, file: p.file });
        }
      });
      self.postMessage({ id, type: 'ready' });
    } else if (type === 'translate') {
      const translator = await getPipeline(src, tgt);
      const output = await translator(text);
      const translatedText = Array.isArray(output) ? output[0].translation_text : output.translation_text;
      self.postMessage({ id, type: 'result', text: translatedText });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || 'Offline model failed to load' });
  }
};
