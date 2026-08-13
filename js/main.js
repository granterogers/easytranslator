import * as db from './db.js';
import * as api from './api.js';

const $ = (id) => document.getElementById(id);

const el = {
  sourceLang: $('sourceLang'),
  targetLang: $('targetLang'),
  swapBtn: $('swapBtn'),
  sourceText: $('sourceText'),
  detectedLabel: $('detectedLabel'),
  clearInputBtn: $('clearInputBtn'),
  translateBtn: $('translateBtn'),
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

const LAST_SOURCE_KEY = 'lt_last_source';
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

  const lastSource = localStorage.getItem(LAST_SOURCE_KEY);
  const lastTarget = localStorage.getItem(LAST_TARGET_KEY);

  el.sourceLang.value = (lastSource && languageNames.has(lastSource)) ? lastSource : 'auto';

  const browserLang = (navigator.language || 'en').slice(0, 2);
  const fallbackTarget = languages.some((l) => l.code === browserLang) && browserLang !== 'en'
    ? browserLang
    : (languages.some((l) => l.code === 'es') ? 'es' : (languages[0] ? languages[0].code : 'en'));

  el.targetLang.value = (lastTarget && languageNames.has(lastTarget)) ? lastTarget : fallbackTarget;

  if (!el.sourceLang.value) el.sourceLang.value = 'auto';
  if (!el.targetLang.value) el.targetLang.value = fallbackTarget;
}

function persistLanguageChoice() {
  localStorage.setItem(LAST_SOURCE_KEY, el.sourceLang.value);
  localStorage.setItem(LAST_TARGET_KEY, el.targetLang.value);
}

el.sourceLang.addEventListener('change', persistLanguageChoice);
el.targetLang.addEventListener('change', persistLanguageChoice);

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
});

// ---------- Input handling ----------

function toggleClearButton() {
  el.clearInputBtn.hidden = el.sourceText.value.length === 0;
}

el.sourceText.addEventListener('input', toggleClearButton);

el.clearInputBtn.addEventListener('click', () => {
  el.sourceText.value = '';
  toggleClearButton();
  el.sourceText.focus();
});

// ---------- Translate ----------

function setBusy(busy) {
  el.translateBtn.disabled = busy;
  el.translateBtn.querySelector('.spinner').hidden = !busy;
  el.translateBtn.querySelector('.btn-label').textContent = busy ? 'Translating…' : 'Translate';
}

function showError(message) {
  el.errorBanner.textContent = message;
  el.errorBanner.hidden = false;
}

function hideError() {
  el.errorBanner.hidden = true;
}

async function handleTranslate() {
  const text = el.sourceText.value.trim();
  if (!text) {
    el.sourceText.focus();
    return;
  }

  hideError();
  setBusy(true);

  const source = el.sourceLang.value;
  const target = el.targetLang.value;

  try {
    const { translatedText, detectedLanguage } = await api.translateText({ text, source, target });

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
    showError(err.message || 'Translation failed. Please try again.');
  } finally {
    setBusy(false);
  }
}

el.translateBtn.addEventListener('click', handleTranslate);

el.sourceText.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    handleTranslate();
  }
});

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
  if (languageNames.has(entry.sourceLang)) el.sourceLang.value = entry.sourceLang;
  if (languageNames.has(entry.targetLang)) el.targetLang.value = entry.targetLang;
  persistLanguageChoice();

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

async function init() {
  if ('storage' in navigator && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  await loadLanguages();

  allEntries = await db.getAllEntries();
  renderHistory();

  toggleClearButton();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const registerSW = () => navigator.serviceWorker.register('./sw.js').catch(() => {});
    if (document.readyState === 'complete') {
      registerSW();
    } else {
      window.addEventListener('load', registerSW, { once: true });
    }
  }
}

init();
