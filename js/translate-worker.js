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

// Last resort for a pair with no dedicated bilingual model anywhere findable
// (confirmed: en-bg): NLLB-200, Meta's single model covering 200 languages
// including ones the small per-pair opus-mt catalog never got around to.
// Real tradeoff, not hidden from the UI: this is a much bigger download
// than the ~40-90MB bilingual models — a few hundred MB — since it's one
// general-purpose model instead of a small pair-specific one. It uses
// FLORES-200 codes (e.g. "eng_Latn", "bul_Cyrl") rather than plain ISO
// codes, passed at translate-call time rather than baked into the model
// id, so unlike the bilingual models above, ALL pairs share the same
// downloaded model — downloading it once for en→bg also covers, say,
// en→ro for free.
const NLLB_MODEL_ID = 'Xenova/nllb-200-distilled-600M';
const FLORES_CODES = {
  en: 'eng_Latn', bg: 'bul_Cyrl', es: 'spa_Latn', fr: 'fra_Latn', de: 'deu_Latn',
  it: 'ita_Latn', pt: 'por_Latn', ru: 'rus_Cyrl', uk: 'ukr_Cyrl', pl: 'pol_Latn',
  nl: 'nld_Latn', el: 'ell_Grek', tr: 'tur_Latn', ar: 'arb_Arab', he: 'heb_Hebr',
  hi: 'hin_Deva', ja: 'jpn_Jpan', ko: 'kor_Hang', zh: 'zho_Hans', vi: 'vie_Latn',
  th: 'tha_Thai', ro: 'ron_Latn', hu: 'hun_Latn', cs: 'ces_Latn', sk: 'slk_Latn',
  sv: 'swe_Latn', da: 'dan_Latn', fi: 'fin_Latn', id: 'ind_Latn', fa: 'pes_Arab',
  sq: 'als_Latn', ur: 'urd_Arab', bn: 'ben_Beng', sl: 'slv_Latn', hr: 'hrv_Latn',
  et: 'est_Latn', lv: 'lvs_Latn', lt: 'lit_Latn', ka: 'kat_Geor', az: 'azj_Latn',
  eu: 'eus_Latn', ca: 'cat_Latn', gl: 'glg_Latn', ga: 'gle_Latn', ms: 'zsm_Latn',
  tl: 'tgl_Latn', nb: 'nob_Latn',
};

// pairKey -> Promise<translator fn>, so concurrent requests for the same
// pair share one download/load instead of racing duplicate ones, and a
// pair already loaded this session is reused instantly. NLLB is cached
// under its own fixed key ('__nllb__') since it's one shared model serving
// every pair, not a per-pair one.
const pipelines = new Map();

function getNllbTranslator(onProgress) {
  const key = '__nllb__';
  if (!pipelines.has(key)) {
    pipelines.set(key, (async () => {
      try {
        const { pipeline, env } = await loadTransformers();
        env.allowLocalModels = false;
        return await pipeline('translation', NLLB_MODEL_ID, { progress_callback: onProgress });
      } catch (err) {
        pipelines.delete(key);
        throw err;
      }
    })());
  }
  return pipelines.get(key);
}

// Always resolves to a plain `(text) => Promise<output>` callable — the
// caller doesn't need to know whether it ended up backed by a small
// bilingual model or the shared NLLB one; that difference (NLLB needs
// src_lang/tgt_lang passed at call time) is wrapped away right here.
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

        const srcFlores = FLORES_CODES[src];
        const tgtFlores = FLORES_CODES[tgt];
        if (srcFlores && tgtFlores) {
          try {
            const fn = await getNllbTranslator(onProgress);
            return (text) => fn(text, { src_lang: srcFlores, tgt_lang: tgtFlores });
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
