import * as db from './db.js';
import * as api from './api.js';
import * as offline from './offline-models.js';
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
  copyBtn: $('copyBtn'),
  shareBtn: $('shareBtn'),
  viewTranslate: $('view-translate'),
  viewHistory: $('view-history'),
  historyList: $('historyList'),
  historyEmpty: $('historyEmpty'),
  historyNoResults: $('historyNoResults'),
  searchInput: $('searchInput'),
  clearAllBtn: $('clearAllBtn'),
  historyCountBadge: $('historyCountBadge'),
  tabBtns: Array.from(document.querySelectorAll('.tab-btn')),
  settingsBtn: $('settingsBtn'),
  settingsSheet: $('settingsSheet'),
  endpointInput: $('endpointInput'),
  saveEndpointBtn: $('saveEndpointBtn'),
  resetEndpointBtn: $('resetEndpointBtn'),
  closeSettingsBtn: $('closeSettingsBtn'),
  toast: $('toast'),
};

const LAST_TARGET_KEY = 'lt_last_target';

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

// ---------- Languages ----------

function populateLanguageSelects() {
  languageNames = new Map(languages.map((l) => [l.code, l.name]));
  languageNames.set('auto', 'Detect language');

  const targetOptions = languages
    .map((l) => `<option value="${l.code}">${l.name}</option>`)
    .join('');
  const sourceOptions = `<option value="auto">Detect language</option>` + targetOptions;

  el.sourceLang.innerHTML = sourceOptions;
  el.targetLang.innerHTML = targetOptions;

  // Source always starts on English — no need to pick it every time.
  el.sourceLang.value = languageNames.has('en') ? 'en' : 'auto';

  const lastTarget = localStorage.getItem(LAST_TARGET_KEY);
  const browserLang = (navigator.language || 'en').slice(0, 2);
  const fallbackTarget = languages.some((l) => l.code === browserLang) && browserLang !== 'en'
    ? browserLang
    : (languages.some((l) => l.code === 'es') ? 'es' : (languages[0] ? languages[0].code : 'en'));

  el.targetLang.value = (lastTarget && languageNames.has(lastTarget)) ? lastTarget : fallbackTarget;

  if (!el.sourceLang.value) el.sourceLang.value = 'auto';
  if (!el.targetLang.value) el.targetLang.value = fallbackTarget;
}

// Only the target language is remembered across launches — source always
// resets to English on load (see populateLanguageSelects).
function persistLanguageChoice() {
  localStorage.setItem(LAST_TARGET_KEY, el.targetLang.value);
}

function onLangChange() {
  persistLanguageChoice();
  updateOfflineButton();
  clearTimeout(debounceTimer);
  runTranslate();
}

el.sourceLang.addEventListener('change', onLangChange);
el.targetLang.addEventListener('change', onLangChange);

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
  }
  toggleClearButton();
  persistLanguageChoice();
  updateOfflineButton();
});

// ---------- Offline (on-device) model download ----------

let offlineDownloadInFlight = false;

function setOfflineButtonState(state, label) {
  el.offlineBtn.classList.toggle('is-downloaded', state === 'downloaded');
  el.offlineBtn.classList.toggle('is-error', state === 'error');
  el.offlineBtn.querySelector('.offline-icon-download').hidden = state !== 'idle' && state !== 'error';
  el.offlineBtn.querySelector('.offline-icon-check').hidden = state !== 'downloaded';
  el.offlineBtn.querySelector('.offline-icon-spinner').hidden = state !== 'downloading';
  el.offlineBtnLabel.textContent = label;
}

function updateOfflineButton() {
  if (offlineDownloadInFlight) return; // don't clobber an in-progress download's UI
  const source = el.sourceLang.value;
  const target = el.targetLang.value;

  if (source === 'auto') {
    el.offlineBtn.hidden = true;
    return;
  }
  el.offlineBtn.hidden = false;

  const srcLabel = langLabel(source);
  const tgtLabel = langLabel(target);

  if (offline.isPairDownloaded(source, target)) {
    setOfflineButtonState('downloaded', `${srcLabel} → ${tgtLabel} works offline`);
  } else {
    setOfflineButtonState('idle', `Download ${srcLabel} → ${tgtLabel} for offline`);
  }
}

el.offlineBtn.addEventListener('click', async () => {
  const source = el.sourceLang.value;
  const target = el.targetLang.value;
  const srcLabel = langLabel(source);
  const tgtLabel = langLabel(target);

  if (offline.isPairDownloaded(source, target)) {
    if (!window.confirm(`Remove the offline ${srcLabel} → ${tgtLabel} model? Translation will use the online server again.`)) return;
    offline.forgetPair(source, target);
    updateOfflineButton();
    return;
  }

  if (offlineDownloadInFlight) return;
  offlineDownloadInFlight = true;
  setOfflineButtonState('downloading', `Downloading ${tgtLabel}… 0%`);

  try {
    await offline.downloadPair(source, target, (p) => {
      const pct = Math.round((p.pct || 0));
      setOfflineButtonState('downloading', `Downloading ${tgtLabel}… ${pct}%`);
    });
    offlineDownloadInFlight = false;
    updateOfflineButton();
    showToast(`${tgtLabel} is ready to use offline`);
    scheduleTranslate(); // if there's text sitting there, retranslate using the model that just finished
  } catch (err) {
    offlineDownloadInFlight = false;
    setOfflineButtonState('error', `Couldn't download ${tgtLabel} — tap to retry`);
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
    return;
  }

  const token = (translateToken += 1);
  hideError();
  setBusy(true);

  try {
    const useOffline = source !== 'auto' && offline.isPairDownloaded(source, target);
    const { translatedText, detectedLanguage } = useOffline
      ? { translatedText: await offline.translateOffline(source, target, text), detectedLanguage: null }
      : await api.translateText({ text, source, target });
    if (token !== translateToken) return; // superseded by newer input/language change

    el.resultText.textContent = translatedText;
    el.resultBlock.hidden = false;

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

// ---------- Copy / Share ----------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch (__) {
      return false;
    }
  }
}

el.copyBtn.addEventListener('click', async () => {
  const ok = await copyText(el.resultText.textContent);
  showToast(ok ? 'Copied to clipboard' : 'Could not copy');
});

el.shareBtn.addEventListener('click', async () => {
  const text = el.resultText.textContent;
  if (navigator.share) {
    try {
      await navigator.share({ text });
    } catch (err) {
      if (err && err.name !== 'AbortError') showToast('Could not share');
    }
  } else {
    const ok = await copyText(text);
    showToast(ok ? 'Sharing not supported — copied instead' : 'Could not share');
  }
});

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
  updateOfflineButton();

  el.sourceText.value = entry.sourceText;
  toggleClearButton();
  el.resultText.textContent = entry.translatedText;
  el.resultBlock.hidden = false;
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

// ---------- Settings ----------

function openSettings() {
  el.endpointInput.value = api.getEndpoint();
  el.settingsSheet.hidden = false;
}

function closeSettings() {
  el.settingsSheet.hidden = true;
}

el.settingsBtn.addEventListener('click', openSettings);
el.closeSettingsBtn.addEventListener('click', closeSettings);
el.settingsSheet.addEventListener('click', (e) => {
  if (e.target === el.settingsSheet) closeSettings();
});

el.saveEndpointBtn.addEventListener('click', async () => {
  const value = el.endpointInput.value.trim();
  try {
    // eslint-disable-next-line no-new
    new URL(value);
  } catch (_) {
    showToast('Enter a valid URL');
    return;
  }
  api.setEndpoint(value);
  closeSettings();
  showToast('Server updated');
  await loadLanguages();
});

el.resetEndpointBtn.addEventListener('click', async () => {
  api.resetEndpoint();
  el.endpointInput.value = api.DEFAULT_ENDPOINT;
  showToast('Reset to default server');
  await loadLanguages();
});

// ---------- Init ----------

async function loadLanguages() {
  languages = await api.fetchLanguages();
  populateLanguageSelects();
}

function initVersionTag() {
  el.versionTag = $('versionTag');
  if (el.versionTag) el.versionTag.textContent = `Translate History v${APP_VERSION}`;
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

  await loadLanguages();
  updateOfflineButton();

  allEntries = await db.getAllEntries();
  renderHistory();

  toggleClearButton();

  registerServiceWorker();
}

init();
