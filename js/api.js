// LibreTranslate client. Talks directly to a LibreTranslate-compatible
// server from the browser — no backend of our own, no API key required.
//
// Public LibreTranslate mirrors are free but flaky (rate limits, downtime,
// CORS lockdowns) and the pool of them churns constantly. Rather than
// hard-failing on one dead mirror, we race a short list of known-good ones
// and remember whichever answers first. This list is the *official*
// no-API-key clearnet mirror list published at
// https://github.com/LibreTranslate/Documentation (docs/community/mirrors),
// not a guessed/hardcoded set — that page is the source of truth going
// forward, since third-party mirrors that seemed fine at any one point in
// time regularly disappear.

const RESOLVED_ENDPOINT_KEY = 'lt_endpoint_resolved';

const CANDIDATE_ENDPOINTS = [
  'https://translate.cutie.dating',
  'https://translate.fedilab.app',
];

const REQUEST_TIMEOUT_MS = 8000;

// Exported so the UI can render the language dropdowns instantly on
// launch instead of waiting on a network round trip first (see
// js/main.js init()) — this list is also the network-failure fallback
// used internally by fetchLanguages() below.
export const FALLBACK_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'sq', name: 'Albanian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'az', name: 'Azerbaijani' },
  { code: 'eu', name: 'Basque' },
  { code: 'bn', name: 'Bengali' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'ca', name: 'Catalan' },
  { code: 'zh', name: 'Chinese' },
  { code: 'zt', name: 'Chinese (traditional)' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'eo', name: 'Esperanto' },
  { code: 'et', name: 'Estonian' },
  { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' },
  { code: 'gl', name: 'Galician' },
  { code: 'ka', name: 'Georgian' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'id', name: 'Indonesian' },
  { code: 'ga', name: 'Irish' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'lv', name: 'Latvian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'ms', name: 'Malay' },
  { code: 'nb', name: 'Norwegian' },
  { code: 'fa', name: 'Persian' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' },
  { code: 'sk', name: 'Slovak' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'es', name: 'Spanish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'tl', name: 'Tagalog' },
  { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ur', name: 'Urdu' },
  { code: 'vi', name: 'Vietnamese' },
];

function getResolvedEndpoint() {
  return localStorage.getItem(RESOLVED_ENDPOINT_KEY);
}

function rememberResolved(base) {
  localStorage.setItem(RESOLVED_ENDPOINT_KEY, base);
}

async function parseErrorMessage(res) {
  try {
    const data = await res.json();
    if (data && data.error) return data.error;
  } catch (_) { /* not JSON */ }
  return `Server responded with ${res.status}`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return url;
  }
}

async function attempt(base, path, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(await parseErrorMessage(res));
    return { base, res };
  } catch (err) {
    // Tag with which mirror + why, so a total failure can report specifics
    // instead of a single opaque "unreachable" message.
    const reason = controller.signal.aborted ? 'timed out' : (err.message || 'network error');
    const tagged = new Error(`${hostOf(base)}: ${reason}`);
    tagged.base = base;
    throw tagged;
  } finally {
    clearTimeout(timer);
  }
}

// Steady state costs exactly one request: whichever mirror worked last time
// is tried alone first. Only when that fails (first ever call, or a mirror
// that just went down) do we fan out and race the rest concurrently, so a
// dead mirror never blocks a working one — and pay that extra cost only
// once, since the newly-resolved winner gets remembered for next time.
async function raceEndpoints(path, options) {
  const resolved = getResolvedEndpoint();
  let resolvedFailure = null;
  if (resolved) {
    try {
      const { res } = await attempt(resolved, path, options);
      return res;
    } catch (err) {
      resolvedFailure = err;
      console.warn('[translate] resolved mirror failed, falling back:', err.message);
    }
  }

  const remaining = CANDIDATE_ENDPOINTS.filter((b) => b !== resolved);
  try {
    const { base, res } = await Promise.any(remaining.map((b) => attempt(b, path, options)));
    rememberResolved(base);
    return res;
  } catch (aggregate) {
    const reasons = [
      ...(resolvedFailure ? [resolvedFailure.message] : []),
      ...(aggregate.errors || []).map((e) => e.message),
    ];
    console.error('[translate] all mirrors failed:', reasons);
    const detail = reasons.length ? ` (${reasons.join('; ')})` : '';
    throw new Error(`Could not reach any translation server${detail}. Check your connection and try again.`);
  }
}

export async function fetchLanguages() {
  try {
    const res = await raceEndpoints('/languages', { method: 'GET' });
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error('Empty language list');
    return data.map((l) => ({ code: l.code, name: l.name }));
  } catch (err) {
    return FALLBACK_LANGUAGES;
  }
}

async function translateViaLibreTranslate(text, source, target) {
  const res = await raceEndpoints('/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source, target, format: 'text' }),
  });
  const data = await res.json();
  return {
    translatedText: data.translatedText,
    detectedLanguage: data.detectedLanguage ? data.detectedLanguage.language : null,
  };
}

// MyMemory (https://mymemory.translated.net) is a long-running, genuinely
// independent public translation API — not a small community-run
// LibreTranslate mirror, so it doesn't share their reliability problems.
// No API key, CORS-open by design (it's built for exactly this — embedding
// in browser widgets with no backend). Doesn't support source === 'auto'.
async function translateViaMyMemory(text, source, target) {
  if (source === 'auto') throw new Error('MyMemory does not support language auto-detection');

  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${source}|${target}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`MyMemory responded with ${res.status}`);
    const data = await res.json();
    const translatedText = data && data.responseData && data.responseData.translatedText;
    if (typeof translatedText !== 'string') throw new Error('Unexpected MyMemory response shape');
    if (data.responseStatus && Number(data.responseStatus) >= 400) {
      throw new Error(data.responseDetails || `MyMemory error ${data.responseStatus}`);
    }
    return { translatedText, detectedLanguage: null };
  } finally {
    clearTimeout(timer);
  }
}

const PROVIDER_KEY = 'lt_provider_resolved';

// Two independent providers, tried in whichever order worked last time (so
// once one proves reliable for this user, we go straight to it instead of
// re-trying a known-dead one on every call).
export async function translateText({ text, source, target }) {
  const providers = [
    { id: 'libretranslate', supported: true, run: () => translateViaLibreTranslate(text, source, target) },
    { id: 'mymemory', supported: source !== 'auto', run: () => translateViaMyMemory(text, source, target) },
  ];
  const preferred = localStorage.getItem(PROVIDER_KEY);
  if (preferred) providers.sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0));

  // A provider that doesn't apply here (e.g. MyMemory + auto-detect) is
  // skipped silently — its "not supported" rejection must never overwrite
  // a real attempt's more useful error message below.
  let lastErr;
  for (const provider of providers) {
    if (!provider.supported) continue;
    try {
      const result = await provider.run();
      localStorage.setItem(PROVIDER_KEY, provider.id);
      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`[translate] ${provider.id} failed:`, err.message);
    }
  }
  throw lastErr || new Error('No translation provider available for this language selection.');
}
