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
// time regularly disappear. Setting an explicit server in Settings opts
// out of this and pins to exactly that server.

const CUSTOM_ENDPOINT_KEY = 'lt_endpoint_custom';
const RESOLVED_ENDPOINT_KEY = 'lt_endpoint_resolved';

const CANDIDATE_ENDPOINTS = [
  'https://translate.cutie.dating',
  'https://translate.fedilab.app',
];

export const DEFAULT_ENDPOINT = CANDIDATE_ENDPOINTS[0];

const REQUEST_TIMEOUT_MS = 8000;

const FALLBACK_LANGUAGES = [
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

function normalizeBase(url) {
  return url.trim().replace(/\/+$/, '');
}

function getCustomEndpoint() {
  const v = localStorage.getItem(CUSTOM_ENDPOINT_KEY);
  return v ? normalizeBase(v) : null;
}

function getResolvedEndpoint() {
  return localStorage.getItem(RESOLVED_ENDPOINT_KEY);
}

function rememberResolved(base) {
  localStorage.setItem(RESOLVED_ENDPOINT_KEY, base);
}

// The endpoint currently in effect — shown in Settings.
export function getEndpoint() {
  return getCustomEndpoint() || getResolvedEndpoint() || DEFAULT_ENDPOINT;
}

export function setEndpoint(url) {
  localStorage.setItem(CUSTOM_ENDPOINT_KEY, normalizeBase(url));
}

export function resetEndpoint() {
  localStorage.removeItem(CUSTOM_ENDPOINT_KEY);
  localStorage.removeItem(RESOLVED_ENDPOINT_KEY);
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
// Pinning a custom server in Settings skips all of this: that one server,
// no fallback, no fan-out.
async function raceEndpoints(path, options) {
  const custom = getCustomEndpoint();
  if (custom) {
    try {
      const { res } = await attempt(custom, path, options);
      return res;
    } catch (err) {
      console.error('[translate] custom server failed:', err.message);
      throw new Error(`Could not reach ${custom}. Check the server URL in Settings, or reset to the default.`);
    }
  }

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
    throw new Error(`Could not reach any translation server${detail}. Check your connection, or set a specific server in Settings.`);
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

export async function translateText({ text, source, target }) {
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
