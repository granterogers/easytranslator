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
// CAVEAT: the CDN URLs and model naming scheme below are correct as of
// this code being written, but this project has already been burned once
// by a hardcoded list of third-party URLs going stale (see js/api.js
// history) — and unlike that one, this file could not be verified against
// the real network before shipping (this dev sandbox's egress is
// restricted to GitHub only; huggingface.co and jsdelivr.net are both
// unreachable from it). Errors are surfaced to the UI with their real
// message rather than a generic failure, specifically so a bad URL here
// is diagnosable from the app itself without needing devtools.
//
// `+esm` (not a raw /dist/ path) asks jsdelivr to guarantee a real ES
// module regardless of the package's own build format — importing a
// UMD/IIFE bundle directly would fail with a confusing syntax error that
// has nothing to do with network reachability. esm.sh is a second,
// independent CDN tried if jsdelivr's fails.
const TRANSFORMERS_CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm',
  'https://esm.sh/@xenova/transformers@2.17.2',
];

let transformersPromise = null;
async function loadTransformers() {
  if (transformersPromise) return transformersPromise;

  transformersPromise = (async () => {
    let lastErr;
    for (const url of TRANSFORMERS_CDN_URLS) {
      try {
        return await import(url);
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`Could not load the translation library from any CDN: ${lastErr && lastErr.message}`);
  })();

  try {
    return await transformersPromise;
  } catch (err) {
    transformersPromise = null; // don't wedge future retries on a stale rejected promise
    throw err;
  }
}

// Xenova converted a subset of Helsinki-NLP's opus-mt pairs to ONNX under
// their own account; some pairs missing there (confirmed live: en-bg) turn
// up instead under `onnx-community`, the org Xenova's conversions are
// gradually migrating to. Try both, in order, before giving up on a pair.
function modelIdsFor(src, tgt) {
  return [
    `Xenova/opus-mt-${src}-${tgt}`,
    `onnx-community/opus-mt-${src}-${tgt}`,
  ];
}

// pairKey -> Promise<translator fn>, so concurrent requests for the same
// pair share one download/load instead of racing duplicate ones, and a
// pair already loaded this session is reused instantly.
const pipelines = new Map();

function getPipeline(src, tgt, onProgress) {
  const key = `${src}:${tgt}`;
  if (!pipelines.has(key)) {
    pipelines.set(key, (async () => {
      try {
        const { pipeline, env } = await loadTransformers();
        env.allowLocalModels = false;

        let lastErr;
        for (const modelId of modelIdsFor(src, tgt)) {
          try {
            return await pipeline('translation', modelId, { progress_callback: onProgress });
          } catch (err) {
            lastErr = err;
          }
        }
        throw lastErr;
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
