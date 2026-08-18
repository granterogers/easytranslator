import * as db from './db.js';
import * as api from './api.js';
import { transliterateFor } from './transliterate.js';
import { hasDictionary, translateWithDictionary } from './dictionary.js';
import { APP_VERSION } from './version.js';

// Translating fires on word boundaries (space/newline/punctuation) almost
// immediately, so results update word-by-word as you type. Mid-word we
// wait a bit longer — translating a half-typed word is low value and
// would just look jittery.
const WORD_BOUNDARY_DEBOUNCE_MS = 120;
const MID_WORD_DEBOUNCE_MS = 450;
const WORD_BOUNDARY_RE = /[\s.,!?;:\n]$/;

// How long a pause (mainly meant for dictation — see the sourceText
// 'input' listener) has to be before the next arriving text is treated as
// a new phrase rather than a continuation. Adjustable via #phraseGapInput
// in the Settings tab.
const PHRASE_GAP_KEY = 'lt_phrase_gap_ms';
const DEFAULT_PHRASE_GAP_MS = 4000;

const THEME_KEY = 'lt_theme';

function getPhraseGapMs() {
  const stored = Number(localStorage.getItem(PHRASE_GAP_KEY));
  return stored > 0 ? stored : DEFAULT_PHRASE_GAP_MS;
}

const $ = (id) => document.getElementById(id);

const el = {
  langToggleBtn: $('langToggleBtn'),
  langRow: $('langRow'),
  sourceLang: $('sourceLang'),
  targetLang: $('targetLang'),
  swapBtn: $('swapBtn'),
  sourceText: $('sourceText'),
  phraseLed: $('phraseLed'),
  statusLabel: $('statusLabel'),
  detectedLabel: $('detectedLabel'),
  clearInputBtn: $('clearInputBtn'),
  errorBanner: $('errorBanner'),
  resultBlock: $('resultBlock'),
  resultText: $('resultText'),
  copyResultBtn: $('copyResultBtn'),
  resultRomanized: $('resultRomanized'),
  translationNote: $('translationNote'),
  viewTranslate: $('view-translate'),
  viewHistory: $('view-history'),
  viewSettings: $('view-settings'),
  historyList: $('historyList'),
  historyEmpty: $('historyEmpty'),
  historyNoResults: $('historyNoResults'),
  searchInput: $('searchInput'),
  clearAllBtn: $('clearAllBtn'),
  phraseGapInput: $('phraseGapInput'),
  phraseGapValue: $('phraseGapValue'),
  themeDarkBtn: $('themeDarkBtn'),
  themeLightBtn: $('themeLightBtn'),
  tabBtns: Array.from(document.querySelectorAll('.tab-btn[data-target]')),
  toast: $('toast'),
  versionTag: $('versionTag'),
};

const LAST_TARGET_KEY = 'lt_last_target';
const RECENT_LANGUAGES_KEY = 'lt_recent_languages';
const MAX_RECENT_LANGUAGES = 8;

let languages = [];
let languageNames = new Map();
let allEntries = [];
let toastTimer = null;

// ---------- Toast ----------

function showToast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

// ---------- Tabs ----------

function activateTab(target) {
  el.tabBtns.forEach((btn) => {
    const active = btn.dataset.target === target;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  el.viewTranslate.hidden = target !== 'translate';
  el.viewHistory.hidden = target !== 'history';
  el.viewSettings.hidden = target !== 'settings';
  el.views.scrollTop = 0;
}

el.tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn.dataset.target));
});
el.views = document.querySelector('.views');

// ---------- Collapsible language row ----------

el.langToggleBtn.addEventListener('click', () => {
  const expanded = el.langToggleBtn.getAttribute('aria-expanded') !== 'false';
  el.langToggleBtn.setAttribute('aria-expanded', String(!expanded));
  el.langToggleBtn.setAttribute('aria-label', expanded ? 'Show language selectors' : 'Hide language selectors');
  el.langRow.hidden = expanded;
});

// ---------- Languages ----------

function computeFallbackTarget() {
  const lastTarget = localStorage.getItem(LAST_TARGET_KEY);
  if (lastTarget && languageNames.has(lastTarget)) return lastTarget;
  const browserLang = (navigator.language || 'en').slice(0, 2);
  if (browserLang !== 'en' && languages.some((l) => l.code === browserLang)) return browserLang;
  if (languages.some((l) => l.code === 'es')) return 'es';
  return languages[0] ? languages[0].code : 'en';
}

// ---------- Most-recently-used language ordering ----------

function getRecentLanguages() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_LANGUAGES_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

// Bumps each given code to the front of the MRU list (most recent last
// argument wins the #1 spot), deduped, capped so the list doesn't grow
// forever. 'auto' is never a real language pick, so it's never recorded.
function recordRecentLanguages(...codes) {
  const recent = getRecentLanguages();
  for (const code of codes) {
    if (!code || code === 'auto') continue;
    const existingIndex = recent.indexOf(code);
    if (existingIndex !== -1) recent.splice(existingIndex, 1);
    recent.unshift(code);
  }
  localStorage.setItem(RECENT_LANGUAGES_KEY, JSON.stringify(recent.slice(0, MAX_RECENT_LANGUAGES)));
}

// Stable sort (ties keep their original relative order) — recently-used
// codes bubble to the top, in recency order; everything else stays in
// whatever order the source list already had (alphabetical by name).
function sortByRecentlyUsed(list) {
  const recent = getRecentLanguages();
  const rank = new Map(recent.map((code, i) => [code, i]));
  return [...list].sort((a, b) => {
    const ra = rank.has(a.code) ? rank.get(a.code) : Infinity;
    const rb = rank.has(b.code) ? rank.get(b.code) : Infinity;
    return ra - rb;
  });
}

function renderLanguageOptions(list) {
  languages = sortByRecentlyUsed(list);
  languageNames = new Map(list.map((l) => [l.code, l.name]));
  languageNames.set('auto', 'Detect language');

  const targetOptions = languages.map((l) => `<option value="${l.code}">${l.name}</option>`).join('');
  el.sourceLang.innerHTML = `<option value="auto">Detect language</option>` + targetOptions;
  el.targetLang.innerHTML = targetOptions;
}

// First-ever render on launch: source always starts on English, target
// restores the last-used one (or a sensible guess).
function applyLanguageDefaults() {
  el.sourceLang.value = languageNames.has('en') ? 'en' : 'auto';
  el.targetLang.value = computeFallbackTarget();
}

// Re-rendering the option list later (background upgrade from the live
// server list) shouldn't yank the language the user is already looking
// at out from under them.
function refreshLanguageOptions(list) {
  const prevSource = el.sourceLang.value;
  const prevTarget = el.targetLang.value;
  renderLanguageOptions(list);
  el.sourceLang.value = languageNames.has(prevSource) ? prevSource : (languageNames.has('en') ? 'en' : 'auto');
  el.targetLang.value = languageNames.has(prevTarget) ? prevTarget : computeFallbackTarget();
}

// Only the target language is remembered across launches — source always
// resets to English on load (see populateLanguageSelects).
function persistLanguageChoice() {
  localStorage.setItem(LAST_TARGET_KEY, el.targetLang.value);
}

// Split so changing the target doesn't also bump "English" to recent (it's
// the source almost all the time) — that would crowd out the far more
// useful "recently used target" signal with a language that's barely a
// meaningful signal at all.
function onLangChange(changedCode) {
  persistLanguageChoice();
  recordRecentLanguages(changedCode);
  refreshLanguageOptions(languages); // re-sort with the freshly-updated recency ranks
  clearTimeout(debounceTimer);
  runTranslate();
}

el.sourceLang.addEventListener('change', () => onLangChange(el.sourceLang.value));
el.targetLang.addEventListener('change', () => onLangChange(el.targetLang.value));

el.swapBtn.addEventListener('click', () => {
  if (el.sourceLang.value === 'auto') {
    showToast("Can't swap while using Detect language");
    return;
  }
  const s = el.sourceLang.value;
  const t = el.targetLang.value;
  el.sourceLang.value = t;
  el.targetLang.value = s;

  const hadResult = !el.resultBlock.hidden;
  const srcVal = el.sourceText.value;
  const resVal = el.resultText.textContent;
  if (hadResult) {
    el.sourceText.value = resVal;
    syncInputTracking();
    el.resultText.textContent = srcVal;
    fitResultFontSize(srcVal);
    el.resultRomanized.hidden = true;
    el.translationNote.hidden = true;
  }
  toggleClearButton();
  persistLanguageChoice();
  recordRecentLanguages(t, s);
  refreshLanguageOptions(languages);
});

// ---------- Copy translated text ----------

el.copyResultBtn.addEventListener('click', async () => {
  const text = el.resultText.textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied');
  } catch (err) {
    showToast('Could not copy');
  }
});

// ---------- Input handling ----------

function toggleClearButton() {
  el.clearInputBtn.hidden = el.sourceText.value.length === 0;
}

// Dictation via the iOS keyboard's mic types straight into the focused
// field, so without this a whole day's worth of separate things you say
// would just keep piling up into one ever-growing block instead of each
// becoming its own translation. If enough silence (adjustable via
// #phraseGapInput in Settings) passes between two keystrokes/dictated
// chunks, the next arriving text is treated as a brand-new phrase:
// whatever was already there (already translated by the live-as-you-type
// flow below, since MID_WORD_DEBOUNCE_MS is far shorter than any
// reasonable pause setting) gets cleared, keeping only the newly-arrived
// text. This can't distinguish dictation from manual typing — a manual
// typist who pauses to think for longer than the threshold and then
// continues the SAME sentence will also have the earlier part cleared,
// which is a real tradeoff of this feature, not an edge case to "fix".
let lastInputAt = Date.now();
let lastInputValue = '';

// Red while the box has text and the pause threshold above hasn't
// elapsed since the last keystroke/dictated chunk (more speech now would
// extend the current phrase); green once it has, or whenever the box is
// empty. Polled on an interval rather than only on 'input' because the
// red→green transition happens passively as time passes, with no event
// of its own to react to.
function updatePhraseLed() {
  const hasText = el.sourceText.value.trim().length > 0;
  const ready = !hasText || (Date.now() - lastInputAt) >= getPhraseGapMs();
  el.phraseLed.classList.toggle('is-ready', ready);
}
setInterval(updatePhraseLed, 250);

// Call after any PROGRAMMATIC change to sourceText.value (restoring a
// history entry, the clear button, swap) — those don't fire a real
// 'input' event, so without this the pause-tracking above would compare
// the next real keystroke/dictated chunk against a stale snapshot from
// before the change and could mis-fire the phrase-reset logic.
function syncInputTracking() {
  lastInputAt = Date.now();
  lastInputValue = el.sourceText.value;
  updatePhraseLed();
}

el.sourceText.addEventListener('input', () => {
  const now = Date.now();
  const gap = now - lastInputAt;
  const previousValue = lastInputValue;
  lastInputAt = now;

  const value = el.sourceText.value;
  lastInputValue = value;

  if (gap >= getPhraseGapMs() && previousValue && value.startsWith(previousValue) && value.length > previousValue.length) {
    // Deferred to a separate task rather than mutated synchronously right
    // here — rewriting a focused field's value in the same tick as the
    // OS's own text insertion into it has been observed to confuse iOS
    // dictation, stalling it for the better part of a minute before it
    // catches up and flushes whatever it was in the middle of inserting.
    // A 0ms timeout is enough to get outside that tick without any
    // perceptible delay for the user.
    setTimeout(() => {
      if (el.sourceText.value !== value) return; // something else changed it since
      el.sourceText.value = value.slice(previousValue.length).replace(/^\s+/, '');
      lastInputValue = el.sourceText.value;
      toggleClearButton();
      scheduleTranslate();
    }, 0);
  }

  updatePhraseLed();
  toggleClearButton();
  scheduleTranslate();
});

el.clearInputBtn.addEventListener('click', () => {
  el.sourceText.value = '';
  syncInputTracking();
  toggleClearButton();
  el.sourceText.focus();
  scheduleTranslate();
});

// ---------- Translate (live — fires automatically as you type) ----------

let debounceTimer = null;
let translateToken = 0;

function setBusy(busy) {
  el.statusLabel.hidden = !busy;
}

function showError(message) {
  el.errorBanner.textContent = message;
  el.errorBanner.hidden = false;
}

function hideError() {
  el.errorBanner.hidden = true;
}

function scheduleTranslate() {
  clearTimeout(debounceTimer);
  const value = el.sourceText.value;
  if (!value.trim()) {
    runTranslate(); // nothing to debounce — clear state right away
    return;
  }
  const atWordBoundary = WORD_BOUNDARY_RE.test(value);
  debounceTimer = setTimeout(runTranslate, atWordBoundary ? WORD_BOUNDARY_DEBOUNCE_MS : MID_WORD_DEBOUNCE_MS);
}

// Reuses a prior real translation from this device's own history when
// nothing else can reach the network — works for ANY language pair (not
// just ones with a bundled dictionary or downloaded neural model), since
// it's built from whatever you've actually translated online before,
// through whichever provider (Google, LibreTranslate, MyMemory) answered
// at the time. Exact match only (trimmed, case-insensitive) — this is a
// replay of a real translation, not a rephrasing, so partial/fuzzy
// matches would risk returning something for the wrong sentence. Searches
// newest-first so a since-corrected re-translation of the same text wins
// over an older one.
function findHistoryMatch(source, target, text) {
  const norm = text.trim().toLowerCase();
  return allEntries.find((e) =>
    e.sourceLang === source && e.targetLang === target && e.sourceText.trim().toLowerCase() === norm
  ) || null;
}

// Google is the expected/default-quality provider (see js/api.js), so no
// note is shown when it's the one that answered — only when a lesser
// fallback provider actually produced the result, so a wording difference
// from the real Google Translate app has a visible, honest explanation
// right on the result instead of silently looking like a quality bug.
const PROVIDER_LABELS = { libretranslate: 'LibreTranslate', mymemory: 'MyMemory' };

function describeTranslationSource(usedDictionary, provider, googleError) {
  if (usedDictionary) return 'Offline word dictionary — approximate, not a full translation';
  if (provider && provider !== 'google') {
    const reason = googleError ? ` — Google error: ${googleError}` : '';
    return `Translated via ${PROVIDER_LABELS[provider] || provider} (Google unavailable${reason})`;
  }
  return null;
}

async function runTranslate() {
  const text = el.sourceText.value.trim();
  const source = el.sourceLang.value;
  const target = el.targetLang.value;

  if (!text) {
    translateToken += 1; // invalidate any in-flight request
    setBusy(false);
    hideError();
    el.resultBlock.hidden = true;
    el.detectedLabel.hidden = true;
    el.resultRomanized.hidden = true;
    el.translationNote.hidden = true;
    return;
  }

  const token = (translateToken += 1);
  hideError();
  setBusy(true);

  try {
    let translatedText;
    let detectedLanguage;
    let usedDictionary = false;
    let provider = null;
    let googleError = null;
    try {
      const result = await api.translateText({ text, source, target });
      translatedText = result.translatedText;
      detectedLanguage = result.detectedLanguage;
      provider = result.provider;
      googleError = result.googleError || null;
    } catch (apiErr) {
      // Every server is unreachable. First choice: have we translated
      // this exact text for this exact pair before? If so, replay that
      // real result — no quality loss, works for any language pair, and
      // only gets more useful the more the app is used. Only if that
      // misses do we fall back further to the small bundled word-for-word
      // dictionary, which IS a quality loss (no grammar or word order),
      // so that path stays clearly labeled as approximate.
      const historyMatch = source !== 'auto' ? findHistoryMatch(source, target, text) : null;
      if (historyMatch) {
        translatedText = historyMatch.translatedText;
        detectedLanguage = historyMatch.detectedLanguage || null;
        usedDictionary = Boolean(historyMatch.usedDictionary);
        provider = historyMatch.provider || null;
        googleError = historyMatch.googleError || null;
      } else if (source !== 'auto' && hasDictionary(source, target)) {
        const result = translateWithDictionary(text, source, target);
        translatedText = result.text;
        detectedLanguage = null;
        usedDictionary = true;
      } else {
        throw apiErr;
      }
    }
    if (token !== translateToken) return; // superseded by newer input/language change

    el.resultText.textContent = translatedText;
    fitResultFontSize(translatedText);
    el.resultBlock.hidden = false;
    // Non-Latin scripts (Bulgarian, Russian, Greek, ...) show a second,
    // smaller romanized line underneath rather than replacing the native
    // script — readable without a matching keyboard/font familiarity,
    // without hiding what the translation actually says.
    const romanized = transliterateFor(target, translatedText);
    el.resultRomanized.textContent = romanized || '';
    el.resultRomanized.hidden = !romanized;
    const note = describeTranslationSource(usedDictionary, provider, googleError);
    el.translationNote.textContent = note || '';
    el.translationNote.hidden = !note;

    if (source === 'auto' && detectedLanguage) {
      const name = languageNames.get(detectedLanguage) || detectedLanguage;
      el.detectedLabel.textContent = `Detected: ${name}`;
      el.detectedLabel.hidden = false;
    } else {
      el.detectedLabel.hidden = true;
    }

    const entry = {
      sourceText: text,
      translatedText,
      sourceLang: source,
      targetLang: target,
      detectedLanguage: detectedLanguage || null,
      provider: provider || null,
      usedDictionary,
      googleError: googleError || null,
      timestamp: Date.now(),
    };
    const id = await db.addEntry(entry);
    entry.id = id;
    allEntries.unshift(entry);
    renderHistory();
  } catch (err) {
    if (token !== translateToken) return;
    showError(err.message || 'Translation failed. Please try again.');
  } finally {
    if (token === translateToken) setBusy(false);
  }
}

// ---------- Adaptive result text size ----------

// Shrinks as the translation gets longer, so a full sentence still fits
// on screen alongside the keyboard instead of scrolling out of view.
function fitResultFontSize(text) {
  const len = text.length;
  let size = 22;
  if (len > 30) size = 20;
  if (len > 60) size = 18;
  if (len > 100) size = 16;
  if (len > 160) size = 14;
  if (len > 240) size = 12;
  el.resultText.style.fontSize = `${size}px`;
}

// ---------- History ----------

function formatTime(ts) {
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isYesterday) return 'Yesterday';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString([], sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

function langLabel(code) {
  return (languageNames.get(code) || code || '').toString();
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function buildHistoryItem(entry) {
  const li = document.createElement('li');
  li.className = 'history-item';
  li.dataset.id = String(entry.id);

  const srcLabel = entry.sourceLang === 'auto'
    ? (entry.detectedLanguage ? langLabel(entry.detectedLanguage) : 'Auto')
    : langLabel(entry.sourceLang);
  const tgtLabel = langLabel(entry.targetLang);

  li.innerHTML = `
    <div class="history-item-head">
      <span class="history-langs">${escapeHtml(srcLabel)} → ${escapeHtml(tgtLabel)}</span>
      <span class="history-time">${formatTime(entry.timestamp)}</span>
      <button class="history-delete" type="button" aria-label="Delete this translation">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12l-1 14H7L6 7zm3-4h6l1 2h4v2H4V5h4l1-2zm1 6v9h1v-9h-1zm3 0v9h1v-9h-1z"/></svg>
      </button>
    </div>
    <p class="history-source">${escapeHtml(entry.sourceText)}</p>
    <p class="history-result">${escapeHtml(entry.translatedText)}</p>
  `;

  li.querySelector('.history-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    handleDelete(entry.id);
  });

  li.addEventListener('click', () => restoreEntry(entry));

  return li;
}

function renderHistory() {
  const query = el.searchInput.value.trim().toLowerCase();
  const filtered = query
    ? allEntries.filter((e) =>
        e.sourceText.toLowerCase().includes(query) ||
        e.translatedText.toLowerCase().includes(query))
    : allEntries;

  el.historyList.innerHTML = '';
  filtered.forEach((entry) => el.historyList.appendChild(buildHistoryItem(entry)));

  el.historyEmpty.hidden = allEntries.length !== 0;
  el.historyNoResults.hidden = !(allEntries.length > 0 && query && filtered.length === 0);
}

function restoreEntry(entry) {
  clearTimeout(debounceTimer);
  translateToken += 1; // invalidate any in-flight/pending translate

  if (languageNames.has(entry.sourceLang)) el.sourceLang.value = entry.sourceLang;
  if (languageNames.has(entry.targetLang)) el.targetLang.value = entry.targetLang;
  persistLanguageChoice();
  // Record target unconditionally, but only record source when it's
  // something other than English — otherwise restoring history (which is
  // almost always en->something) would repeatedly crowd English into the
  // recent-target ranking the same way routine language switching would.
  recordRecentLanguages(entry.targetLang);
  if (entry.sourceLang !== 'en') recordRecentLanguages(entry.sourceLang);
  refreshLanguageOptions(languages);

  el.sourceText.value = entry.sourceText;
  syncInputTracking();
  toggleClearButton();
  el.resultText.textContent = entry.translatedText;
  fitResultFontSize(entry.translatedText);
  el.resultBlock.hidden = false;
  const romanized = transliterateFor(entry.targetLang, entry.translatedText);
  el.resultRomanized.textContent = romanized || '';
  el.resultRomanized.hidden = !romanized;
  const note = describeTranslationSource(Boolean(entry.usedDictionary), entry.provider || null, entry.googleError || null);
  el.translationNote.textContent = note || '';
  el.translationNote.hidden = !note;
  hideError();

  if (entry.sourceLang === 'auto' && entry.detectedLanguage) {
    el.detectedLabel.textContent = `Detected: ${langLabel(entry.detectedLanguage)}`;
    el.detectedLabel.hidden = false;
  } else {
    el.detectedLabel.hidden = true;
  }

  activateTab('translate');
}

async function handleDelete(id) {
  await db.deleteEntry(id);
  allEntries = allEntries.filter((e) => e.id !== id);
  renderHistory();
}

el.clearAllBtn.addEventListener('click', async () => {
  if (allEntries.length === 0) return;
  if (!window.confirm('Delete all history? This cannot be undone.')) return;
  await db.clearAllEntries();
  allEntries = [];
  renderHistory();
});

let searchDebounce = null;
el.searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(renderHistory, 120);
});

// ---------- Init ----------

function initVersionTag() {
  if (el.versionTag) el.versionTag.textContent = `v${APP_VERSION}`;
}

function initPhraseGapControl() {
  const seconds = getPhraseGapMs() / 1000;
  el.phraseGapInput.value = String(seconds);
  el.phraseGapValue.textContent = seconds.toFixed(1);
  el.phraseGapInput.addEventListener('input', () => {
    const value = Number(el.phraseGapInput.value);
    el.phraseGapValue.textContent = value.toFixed(1);
    localStorage.setItem(PHRASE_GAP_KEY, String(Math.round(value * 1000)));
  });
}

// Applied as early as possible (see the inline <script> in index.html's
// <head>, which sets the same attribute before first paint to avoid a
// flash of the wrong theme) — this just keeps it in sync afterward and
// handles the toggle buttons.
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f8fafc' : '#0f172a');
  el.themeDarkBtn.classList.toggle('active', theme === 'dark');
  el.themeLightBtn.classList.toggle('active', theme === 'light');
}

function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  applyTheme(stored === 'light' ? 'light' : 'dark');
  el.themeDarkBtn.addEventListener('click', () => applyTheme('dark'));
  el.themeLightBtn.addEventListener('click', () => applyTheme('light'));
}

// Keeps the installed app in step with whatever is on GitHub: any time a
// new service worker takes over (because sw.js or a cached asset changed),
// reload once so the tab is running the latest deployed code instead of a
// stale cached copy.
//
// `clients.claim()` in sw.js fires `controllerchange` even the very first
// time this client is ever controlled (install, not update) — reloading
// on that would loop the very first visit. Only arm the reload-on-update
// behavior when a controller already existed at load time, i.e. this is a
// real redeploy, not first install. `reloaded` guards against a repeat.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

  const hadController = !!navigator.serviceWorker.controller;

  const register = () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.update().catch(() => {});
    }).catch(() => {});
  };

  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }

  if (!hadController) return;

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

async function init() {
  initVersionTag();
  initPhraseGapControl();
  initTheme();

  if ('storage' in navigator && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // Render instantly from the built-in language list — no network wait
  // before the dropdowns (or anything else) are usable. The live/richer
  // server list is fetched quietly afterward and swapped in without
  // disturbing whatever the user has already selected.
  renderLanguageOptions(api.FALLBACK_LANGUAGES);
  applyLanguageDefaults();
  api.fetchLanguages().then(refreshLanguageOptions).catch(() => {});

  allEntries = await db.getAllEntries();
  renderHistory();

  toggleClearButton();
  updatePhraseLed();

  registerServiceWorker();
}

init();
