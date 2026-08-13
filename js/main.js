import * as db from './db.js';
import * as api from './api.js';
import * as offline from './offline-models.js';
import { transliterateBulgarian } from './transliterate.js';
import { hasDictionary, translateWithDictionary } from './dictionary.js';
import { APP_VERSION } from './version.js';

// Translating fires on word boundaries (space/newline/punctuation) almost
// immediately, so results update word-by-word as you type. Mid-word we
// wait a bit longer — translating a half-typed word is low value and
// would just look jittery.
const WORD_BOUNDARY_DEBOUNCE_MS = 120;
const MID_WORD_DEBOUNCE_MS = 450;
const WORD_BOUNDARY_RE = /[\s.,!?;:\n]$/;

const $ = (id) => document.getElementById(id);

const el = {
  langToggleBtn: $('langToggleBtn'),
  langRow: $('langRow'),
  sourceLang: $('sourceLang'),
  targetLang: $('targetLang'),
  swapBtn: $('swapBtn'),
  offlineBtn: $('offlineBtn'),
  offlineBtnLabel: $('offlineBtnLabel'),
  sourceText: $('sourceText'),
  statusLabel: $('statusLabel'),
  detectedLabel: $('detectedLabel'),
  clearInputBtn: $('clearInputBtn'),
  errorBanner: $('errorBanner'),
  resultBlock: $('resultBlock'),
  resultText: $('resultText'),
  dictNote: $('dictNote'),
  viewTranslate: $('view-translate'),
  viewHistory: $('view-history'),
  historyList: $('historyList'),
  historyEmpty: $('historyEmpty'),
  historyNoResults: $('historyNoResults'),
  searchInput: $('searchInput'),
  clearAllBtn: $('clearAllBtn'),
  historyCountBadge: $('historyCountBadge'),
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
  refreshOfflineUI();
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
    el.resultText.textContent = srcVal;
    fitResultFontSize(srcVal);
    el.dictNote.hidden = true;
  }
  toggleClearButton();
  persistLanguageChoice();
  recordRecentLanguages(t, s);
  refreshLanguageOptions(languages);
  refreshOfflineUI();
});

// ---------- Offline (on-device) model download ----------

let offlineDownloadInFlight = false;

function setOfflineButtonState(state, label) {
  el.offlineBtn.classList.toggle('is-error', state === 'error');
  el.offlineBtn.querySelector('.offline-icon-download').hidden = state !== 'idle' && state !== 'error';
  el.offlineBtn.querySelector('.offline-icon-spinner').hidden = state !== 'downloading';
  el.offlineBtnLabel.textContent = label;
}

// Once a pair is downloaded there's nothing left to tap — the ✓ in the
// dropdown options (see updateDownloadTicks) is the only indicator needed,
// so the button itself goes away rather than sticking around as a
// "downloaded" pill. It reappears automatically if the pack goes missing
// (see runTranslate's offline-path catch) so there's still a way back in.
function updateOfflineButton() {
  if (offlineDownloadInFlight) return; // don't clobber an in-progress download's UI
  const source = el.sourceLang.value;
  const target = el.targetLang.value;

  if (source === 'auto' || offline.isPairDownloaded(source, target)) {
    el.offlineBtn.hidden = true;
    return;
  }
  el.offlineBtn.hidden = false;

  const srcLabel = langLabel(source);
  const tgtLabel = langLabel(target);
  setOfflineButtonState('idle', `Download ${srcLabel} → ${tgtLabel} for offline`);
}

// Marks each dropdown option with a ✓ when downloading it (paired with
// whatever's currently selected in the *other* dropdown) would complete an
// already-downloaded offline pair. Rewrites option text in place rather
// than rebuilding the <select>, so it doesn't disturb scroll position or
// an open picker.
function updateDownloadTicks() {
  const source = el.sourceLang.value;
  const target = el.targetLang.value;

  Array.from(el.targetLang.options).forEach((opt) => {
    const downloaded = source !== 'auto' && offline.isPairDownloaded(source, opt.value);
    opt.textContent = (downloaded ? '✓ ' : '') + langLabel(opt.value);
  });

  Array.from(el.sourceLang.options).forEach((opt) => {
    if (opt.value === 'auto') return;
    const downloaded = Boolean(target) && offline.isPairDownloaded(opt.value, target);
    opt.textContent = (downloaded ? '✓ ' : '') + langLabel(opt.value);
  });
}

function refreshOfflineUI() {
  updateOfflineButton();
  updateDownloadTicks();
}

el.offlineBtn.addEventListener('click', async () => {
  const source = el.sourceLang.value;
  const target = el.targetLang.value;
  const tgtLabel = langLabel(target);

  if (offlineDownloadInFlight) return;
  offlineDownloadInFlight = true;
  setOfflineButtonState('downloading', `Downloading ${tgtLabel}… 0%`);

  try {
    await offline.downloadPair(source, target, (p) => {
      const pct = Math.round((p.pct || 0));
      setOfflineButtonState('downloading', `Downloading ${tgtLabel}… ${pct}%`);
    });
    offlineDownloadInFlight = false;
    refreshOfflineUI();
    showToast(`${tgtLabel} is ready to use offline`);
    scheduleTranslate(); // if there's text sitting there, retranslate using the model that just finished
  } catch (err) {
    offlineDownloadInFlight = false;
    const message = (err && err.message) || '';
    // Hugging Face returns this exact wording both for private/gated repos
    // and for ones that simply don't exist — in practice here it means no
    // one has published an offline model for this specific language pair,
    // not a connection problem retrying would fix.
    const label = /unauthorized access to file/i.test(message)
      ? `${tgtLabel} isn't available for offline use yet — translation keeps working online`
      : `Couldn't download ${tgtLabel}: ${message.slice(0, 120) || 'unknown error'} — tap to retry`;
    setOfflineButtonState('error', label);
    console.error('[offline]', err);
  }
});

// ---------- Input handling ----------

function toggleClearButton() {
  el.clearInputBtn.hidden = el.sourceText.value.length === 0;
}

el.sourceText.addEventListener('input', () => {
  toggleClearButton();
  scheduleTranslate();
});

el.clearInputBtn.addEventListener('click', () => {
  el.sourceText.value = '';
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
    el.dictNote.hidden = true;
    return;
  }

  const token = (translateToken += 1);
  hideError();
  setBusy(true);

  try {
    const useOffline = source !== 'auto' && offline.isPairDownloaded(source, target);
    let translatedText;
    let detectedLanguage;
    let usedDictionary = false;
    if (useOffline) {
      try {
        translatedText = await offline.translateOffline(source, target, text);
        detectedLanguage = null;
      } catch (offlineErr) {
        // The pack was recorded as downloaded, but the underlying model
        // files are gone (e.g. evicted by the browser under storage
        // pressure — the Bulgarian fallback model alone is a few hundred
        // MB). Forget it and let the button reappear instead of failing
        // the same way on every future keystroke with no way back in.
        offline.forgetPair(source, target);
        refreshOfflineUI();
        throw new Error(`The offline pack for ${langLabel(target)} is no longer available — tap "Download for offline" to get it again.`);
      }
    } else {
      try {
        ({ translatedText, detectedLanguage } = await api.translateText({ text, source, target }));
      } catch (apiErr) {
        // Last resort when there's no network model AND no server reachable
        // (offline with no downloaded pack, or every server down): fall
        // back to a small bundled word-for-word dictionary rather than a
        // hard failure. Word-for-word only — no grammar or word order — so
        // it's clearly labeled as approximate, never silently swapped in
        // for a real translation.
        if (source !== 'auto' && hasDictionary(source, target)) {
          const result = translateWithDictionary(text, source, target);
          translatedText = result.text;
          detectedLanguage = null;
          usedDictionary = true;
        } else {
          throw apiErr;
        }
      }
    }
    if (token !== translateToken) return; // superseded by newer input/language change

    // Bulgarian is shown romanized, not in Cyrillic — readable without
    // needing a Bulgarian keyboard/font familiarity.
    if (target === 'bg') translatedText = transliterateBulgarian(translatedText);

    el.resultText.textContent = translatedText;
    fitResultFontSize(translatedText);
    el.resultBlock.hidden = false;
    el.dictNote.hidden = !usedDictionary;

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

  if (allEntries.length > 0) {
    el.historyCountBadge.hidden = false;
    el.historyCountBadge.textContent = allEntries.length > 99 ? '99+' : String(allEntries.length);
  } else {
    el.historyCountBadge.hidden = true;
  }
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
  refreshOfflineUI();

  el.sourceText.value = entry.sourceText;
  toggleClearButton();
  el.resultText.textContent = entry.translatedText;
  fitResultFontSize(entry.translatedText);
  el.resultBlock.hidden = false;
  el.dictNote.hidden = true;
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
  if (!window.confirm('Delete this translation?')) return;
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

  if ('storage' in navigator && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // Render instantly from the built-in language list — no network wait
  // before the dropdowns (or anything else) are usable. The live/richer
  // server list is fetched quietly afterward and swapped in without
  // disturbing whatever the user has already selected.
  renderLanguageOptions(api.FALLBACK_LANGUAGES);
  applyLanguageDefaults();
  refreshOfflineUI();
  api.fetchLanguages().then(refreshLanguageOptions).then(refreshOfflineUI).catch(() => {});

  allEntries = await db.getAllEntries();
  renderHistory();

  toggleClearButton();

  registerServiceWorker();
}

init();
