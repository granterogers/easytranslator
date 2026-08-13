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

// There used to be a last-resort fallback here for pairs with no dedicated
// bilingual model (confirmed missing: en-bg): NLLB-200, Meta's 200-language
// model, a few hundred MB of weights instead of the ~40-90MB bilingual
// models. Removed after being confirmed on a real device to crash mobile
// Safari mid-download — the WebView's memory limit can't absorb that much
// model data, and there's no way to fix that from page code. A pair with no
// small dedicated model now just reports "not available for offline use"
// (see modelIdsFor's callers) rather than attempting a download that
// reliably takes the whole app down with it.

// pairKey -> Promise<translator fn>, so concurrent requests for the same
// pair share one download/load instead of racing duplicate ones, and a
// pair already loaded this session is reused instantly.
const pipelines = new Map();

// Always resolves to a plain `(text) => Promise<output>` callable.
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
            const fn = await pipeline('translation', modelId, { progress_callback: onProgress });
            return (text) => fn(text);
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

// A model download is several files (tokenizer, config, weights, ...)
// fetched concurrently, each reporting its own independent 0-100 progress.
// Reporting whichever file's event arrived most recently made the download
// percentage look "all over the place" — it would drop back toward 0 every
// time a tiny config file started downloading right after the multi-MB
// weights file was mostly done.
//
// Byte totals are only reliable for files fetched with a Content-Length
// (the actual model weights) — small metadata files often report a bare
// percentage with no byte count at all. So: once any file has reported real
// byte counts, sum loaded/total bytes across every such file and use that
// — it's naturally weighted by actual size, so a finished 2KB tokenizer
// file barely moves the needle next to a 90MB weights file, instead of
// counting for an equal 50% share of the average the way a naive per-file
// average would. Only fall back to averaging bare percentages when no file
// has reported byte counts yet.
function makeAggregateProgress(onAggregate) {
  const byBytes = new Map(); // file -> { loaded, total }
  const byPercent = new Map(); // file -> 0..1, only used until byBytes has an entry
  return (p) => {
    if (!p || !p.file) return;
    if (p.status === 'done') {
      const existing = byBytes.get(p.file);
      if (existing) byBytes.set(p.file, { loaded: existing.total, total: existing.total });
      else byPercent.set(p.file, 1);
    } else if (p.status === 'progress') {
      const hasBytes = typeof p.loaded === 'number' && typeof p.total === 'number' && p.total > 0;
      if (hasBytes) {
        byBytes.set(p.file, { loaded: p.loaded, total: p.total });
      } else if (typeof p.progress === 'number') {
        byPercent.set(p.file, Math.max(0, Math.min(1, p.progress / 100)));
      } else {
        return;
      }
    } else {
      return; // 'initiate' etc — nothing measurable to report yet
    }

    let pct;
    if (byBytes.size > 0) {
      let loadedSum = 0;
      let totalSum = 0;
      for (const { loaded, total } of byBytes.values()) { loadedSum += loaded; totalSum += total; }
      pct = totalSum > 0 ? (loadedSum / totalSum) * 100 : 0;
    } else {
      const values = [...byPercent.values()];
      pct = values.length ? (values.reduce((sum, v) => sum + v, 0) / values.length) * 100 : 0;
    }
    onAggregate(pct);
  };
}

self.onmessage = async (event) => {
  const { id, type, src, tgt, text } = event.data;

  try {
    if (type === 'warmup') {
      const reportProgress = makeAggregateProgress((pct) => {
        self.postMessage({ id, type: 'progress', pct });
      });
      await getPipeline(src, tgt, reportProgress);
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
