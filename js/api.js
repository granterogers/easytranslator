// LibreTranslate client. Talks directly to a LibreTranslate-compatible
// server from the browser — no backend of our own, no API key required.

const ENDPOINT_KEY = 'lt_endpoint';
export const DEFAULT_ENDPOINT = 'https://translate.astian.org';

const FALLBACK_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ar', name: 'Arabic' },
  { code: 'zh', name: 'Chinese' },
  { code: 'cs', name: 'Czech' },
  { code: 'da', name: 'Danish' },
  { code: 'nl', name: 'Dutch' },
  { code: 'fi', name: 'Finnish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'hi', name: 'Hindi' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'id', name: 'Indonesian' },
  { code: 'it', name: 'Italian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'fa', name: 'Persian' },
  { code: 'pl', name: 'Polish' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ro', name: 'Romanian' },
  { code: 'ru', name: 'Russian' },
  { code: 'sk', name: 'Slovak' },
  { code: 'es', name: 'Spanish' },
  { code: 'sv', name: 'Swedish' },
  { code: 'th', name: 'Thai' },
  { code: 'tr', name: 'Turkish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ur', name: 'Urdu' },
  { code: 'vi', name: 'Vietnamese' },
];

function normalizeBase(url) {
  return url.trim().replace(/\/+$/, '');
}

export function getEndpoint() {
  return normalizeBase(localStorage.getItem(ENDPOINT_KEY) || DEFAULT_ENDPOINT);
}

export function setEndpoint(url) {
  localStorage.setItem(ENDPOINT_KEY, normalizeBase(url));
}

export function resetEndpoint() {
  localStorage.removeItem(ENDPOINT_KEY);
}

async function parseErrorMessage(res) {
  try {
    const data = await res.json();
    if (data && data.error) return data.error;
  } catch (_) { /* not JSON */ }
  return `Server responded with ${res.status}`;
}

export async function fetchLanguages() {
  try {
    const res = await fetch(`${getEndpoint()}/languages`);
    if (!res.ok) throw new Error(await parseErrorMessage(res));
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error('Empty language list');
    return data.map((l) => ({ code: l.code, name: l.name }));
  } catch (err) {
    return FALLBACK_LANGUAGES;
  }
}

export async function translateText({ text, source, target }) {
  let res;
  try {
    res = await fetch(`${getEndpoint()}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source, target, format: 'text' }),
    });
  } catch (err) {
    throw new Error('Could not reach the translation server. Check your connection or server URL in Settings.');
  }

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }

  const data = await res.json();
  return {
    translatedText: data.translatedText,
    detectedLanguage: data.detectedLanguage ? data.detectedLanguage.language : null,
  };
}
