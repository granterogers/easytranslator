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

// How long a pause (mainly meant for dictation — see updatePhraseLed()
// below) has to elapse before the box is cleared for a new phrase.
// Adjustable via #phraseGapInput in the Settings tab; 0 means "off"
// (`Infinity` so the ready check never fires) — a guaranteed way to fully
// disable the auto-reset if it ever causes trouble.
const PHRASE_GAP_KEY = 'lt_phrase_gap_ms';
const DEFAULT_PHRASE_GAP_MS = 4000;

const THEME_KEY = 'lt_theme';

function getPhraseGapMs() {
  const raw = localStorage.getItem(PHRASE_GAP_KEY);
  if (raw === null) return DEFAULT_PHRASE_GAP_MS; // never touched the slider — not the same as explicitly set to 0/Off
  const stored = Number(raw);
  if (stored === 0) return Infinity;
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
  sourceOverlay: $('sourceOverlay'),
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
  // The current phrase, not the whole hidden transcript — that's what
  // produced the shown result, and it's what the box appears to contain.
  const srcVal = getCurrentPhraseText();
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
  el.clearInputBtn.hidden = getCurrentPhraseText().length === 0;
}

// ---------- Dictation phrase splitting ----------
//
// Dictation via the iOS keyboard's mic types straight into the focused
// field, so without help a whole day's worth of separate things you say
// would pile up into one ever-growing block instead of each
// pause-separated thing becoming its own translation.
//
// SIX designs were tried before this one, and the single most important
// thing learned from them: **any** write to `sourceText.value` (or its
// selection) while the mic session may still be live disrupts iOS's
// dictation engine — a stall of up to a minute, the app appearing to
// stop, or a ~10s lag before the next phrase catches up. That held true
// for a synchronous write, a `setTimeout(0)` one, a 700ms-debounced one,
// a `.select()` instead of a write, and even a write performed only
// after several seconds of confirmed silence. A multi-second pause
// between sentences is NOT the same thing as the dictation session
// having ended, so "wait until it's quiet, then write" is not a safe
// strategy — there is no safe moment to write while the mic is on.
// The one design that did NOT disrupt dictation was the one that never
// wrote to the field at all. Its only flaw was cosmetic: the box grew
// into a visible running transcript instead of ever looking like it
// reset for a new phrase.
//
// So: keep the engine that works, and fix the appearance separately.
// `sourceText.value` is never rewritten here — dictation appends to it
// freely for the whole session. `committedWordCount` is a plain JS
// number marking where the current phrase starts inside that value, and
// `#sourceOverlay` (see renderSourceOverlay() below) paints ONLY the
// text from that point onward over the top of the field, whose own
// text is transparent. Visually the box holds exactly the current
// phrase; underneath, the field iOS is dictating into is never touched.
//
// The offset advances in the `input` handler at the moment the first
// chunk of a NEW phrase lands (a real pause elapsed AND the value grew)
// — deliberately NOT on the idle timer. That ordering is the whole
// point: during the pause the offset is unchanged, so the phrase you
// just said stays on screen; the instant you start saying something new
// the offset jumps and the box shows only the new words. Cleared first,
// then filled — with no write to the field to make it happen.
//
// The boundary is recorded as a LENGTH (`previousValue.length`), never by
// matching the old phrase's characters, so iOS retroactively editing the
// old phrase's tail (e.g. swapping its trailing space for a period once
// a new sentence starts) can't make this silently do nothing. Any
// leading separator left at the cut is skipped when slicing.
//
// There's no way to distinguish dictation from manual typing at the
// input-event level, so someone who manually pauses mid-thought past the
// threshold and keeps typing the same sentence will also have the
// earlier part drop out of view — a real, accepted tradeoff, not a bug.
let lastInputAt = Date.now();
let lastInputValue = '';
// How many words at the START of the field belong to phrases already
// finished — deliberately a WORD COUNT, not a character offset. When
// dictation is switched off, iOS commits its final transcript by
// clearing the field and refilling it with the whole session's text (and
// re-punctuating it on the way). A character offset does not survive
// that: the empty value clamps it to 0, the refill arrives with no
// previous value to measure against, and every phrase said all session
// reappears at once. A word count survives it — the same words are still
// there in the same order, whatever happened to the spacing and
// punctuation around them.
let committedWordCount = 0;
// Set when a pause elapsed but the event that crossed it carried only a
// separator; holds the text the finished phrase ended at until the new
// phrase's first real character arrives.
let pendingBoundaryValue = null;

const PHRASE_SEPARATOR_RE = /[\s.,!?;:]/;

function countWords(text) {
  const words = text.match(/\S+/g);
  return words ? words.length : 0;
}

// Where the visible phrase actually begins: the recorded boundary, plus
// any separator characters sitting right at it (so a new phrase never
// renders with a leading " " or ". " left over from the previous one).
// Index just past the last committed word, or -1 if the field no longer
// holds that many words at all.
function committedPrefixEnd() {
  const full = el.sourceText.value;
  if (committedWordCount <= 0) return 0;

  const wordRe = /\S+/g;
  let seen = 0;
  let match;
  while ((match = wordRe.exec(full)) !== null) {
    if (++seen === committedWordCount) return match.index + match[0].length;
  }
  return -1;
}

function getPhraseStart() {
  const full = el.sourceText.value;
  // end < 0 means fewer words are present than we'd committed — the
  // field was replaced or deleted down past the boundary, so there's no
  // committed prefix left to skip and whatever remains is the current
  // phrase. (Without this, typing a fresh short phrase after clearing by
  // hand would render as an empty box.)
  const end = committedPrefixEnd();
  if (end <= 0) return 0;

  let i = end;
  while (i < full.length && PHRASE_SEPARATOR_RE.test(full[i])) i++;
  return i;
}

// The only text this app treats as "what the user is asking to
// translate" — everything before it is a previous phrase that's already
// been translated and saved to history.
function getCurrentPhraseText() {
  return el.sourceText.value.slice(getPhraseStart());
}

// Paints the current phrase (and a caret) over the transparent-text
// textarea, so the box looks like it contains only that phrase.
function renderSourceOverlay() {
  const overlay = el.sourceOverlay;
  const start = getPhraseStart();
  const phrase = el.sourceText.value.slice(start);
  const focused = document.activeElement === el.sourceText;

  overlay.textContent = '';

  if (!phrase) {
    if (focused) overlay.appendChild(makeCaret());
    const placeholder = document.createElement('span');
    placeholder.className = 'source-overlay-placeholder';
    placeholder.textContent = el.sourceText.placeholder;
    overlay.appendChild(placeholder);
    return;
  }

  // Map the real caret into the visible phrase so tapping mid-text still
  // puts the drawn caret where typing will actually land.
  const caretAt = Math.max(0, Math.min(el.sourceText.selectionStart - start, phrase.length));
  overlay.appendChild(document.createTextNode(phrase.slice(0, caretAt)));
  const caret = focused ? overlay.appendChild(makeCaret()) : null;
  overlay.appendChild(document.createTextNode(phrase.slice(caretAt)));

  // The overlay scrolls independently of the textarea (whose own scroll
  // tracks the full hidden transcript, not what's drawn here) — keep the
  // caret in view the way a real field would.
  if (!caret) {
    overlay.scrollTop = 0;
    return;
  }
  const top = caret.offsetTop;
  const bottom = top + caret.offsetHeight;
  if (bottom > overlay.scrollTop + overlay.clientHeight) {
    overlay.scrollTop = bottom - overlay.clientHeight;
  } else if (top < overlay.scrollTop) {
    overlay.scrollTop = top;
  }
}

function makeCaret() {
  const caret = document.createElement('span');
  caret.className = 'source-overlay-caret';
  return caret;
}

// Red while the current phrase has text and the pause threshold hasn't
// elapsed since the last keystroke/dictated chunk (more speech now would
// extend it); green once it has, or whenever the box looks empty. Hidden
// entirely when the feature is off (see getPhraseGapMs()). Polled on an
// interval rather than only on 'input' because the red→green transition
// happens passively as time passes, with no event of its own to react
// to. Note this only READS state — unlike an earlier design, it never
// touches the field or advances the boundary.
function updatePhraseLed() {
  const disabled = !Number.isFinite(getPhraseGapMs());
  el.phraseLed.hidden = disabled;
  if (disabled) return;
  const hasText = getCurrentPhraseText().trim().length > 0;
  const ready = !hasText || (Date.now() - lastInputAt) >= getPhraseGapMs();
  el.phraseLed.classList.toggle('is-ready', ready);
}
setInterval(updatePhraseLed, 250);

// Call after any PROGRAMMATIC change to sourceText.value (the clear
// button, restoring a history entry, swap) — those don't fire a real
// 'input' event, so without this the pause-tracking would compare the
// next real keystroke/dictated chunk against a stale snapshot. Each of
// them also replaces the field's whole content, so the boundary resets
// to 0: the new value counts as one fresh phrase. These are all explicit
// user taps, not dictation-time writes, so they're safe.
function syncInputTracking() {
  lastInputAt = Date.now();
  lastInputValue = el.sourceText.value;
  committedWordCount = 0;
  pendingBoundaryValue = null;
  renderSourceOverlay();
}

el.sourceText.addEventListener('input', () => {
  const value = el.sourceText.value;

  // iOS dictation has been observed firing 'input' events that don't
  // actually change the value (cursor/selection housekeeping, duplicate
  // interim commits). Treating those as real activity would reset
  // lastInputAt a moment before the *real* next dictated chunk arrived,
  // making the pause look shorter than it really was. Only a genuine
  // value change counts as activity.
  if (value === lastInputValue) return;

  const now = Date.now();
  const gap = now - lastInputAt;
  const previousValue = lastInputValue;
  lastInputAt = now;
  lastInputValue = value;

  // Live dictation and typing only ever APPEND to the end of the field.
  // Switching dictation off is different in kind: iOS throws away what
  // was there and re-commits the whole session, re-punctuated and
  // recapitalised (sometimes as a clear followed by a refill, sometimes
  // as one replacement). Those rewrites must never be read as "a new
  // phrase started" — nothing new was said — so they're handled
  // separately below and can only ever RE-ANCHOR the phrase already on
  // screen, never create a boundary.
  const isAppend = previousValue !== '' && value.startsWith(previousValue);

  if (isAppend) {
    // Require real content in what arrived, not just punctuation: iOS
    // tacking a final "." or "?" onto the last phrase is not the start
    // of a new one, and treating it as one would blank the box at
    // exactly the moment dictation stops.
    const added = value.slice(previousValue.length);
    const addedRealContent = /[^\s.,!?;:]/.test(added);

    if (gap >= getPhraseGapMs()) {
      // A real pause just elapsed. Everything already in the field
      // belongs to the finished phrase — but only actually cut once
      // real content shows up. If the pause-crossing event carried
      // nothing but a separator (dictation and typing both routinely
      // deliver the leading space of a new phrase on its own), hold the
      // cut as pending: by the time the first real word lands the gap
      // is milliseconds and would no longer look like a boundary at all.
      if (addedRealContent) committedWordCount = countWords(previousValue);
      else pendingBoundaryValue = previousValue;
    } else if (pendingBoundaryValue !== null && addedRealContent) {
      // The real content the pause was waiting for.
      committedWordCount = countWords(pendingBoundaryValue);
      pendingBoundaryValue = null;
    }
    if (addedRealContent) pendingBoundaryValue = null;

    // New text arrived, yet the last committed word now runs to the very
    // end of the field: the boundary is stale because those characters
    // merged into it (backspacing into a committed word, then typing
    // on). Hand that word back to the current phrase — otherwise typing
    // would go invisible, since the overlay would have nothing left to
    // draw. Tested against committedPrefixEnd() rather than
    // getPhraseStart() on purpose: when a new phrase opens with a space
    // the phrase really is empty for that one keystroke, and skipping
    // separators first would misread that as staleness and leak the
    // previous word back in.
    if (committedPrefixEnd() === value.length) {
      committedWordCount = Math.max(0, countWords(value) - 1);
    }
  }
  // A REWRITE (not an append) deliberately leaves committedWordCount
  // completely untouched — no attempt to guess or re-anchor anything.
  // This is what "switching dictation off shouldn't change what's on
  // screen" actually means in code: the word count still points at the
  // same words it did before, and since a rewrite only ever changes
  // surrounding punctuation/capitalization (never the words themselves
  // or their order), getPhraseStart() finds the exact same phrase in the
  // freshly-corrected text and the overlay just re-renders it, cleaned
  // up. Trying to be clever here — re-anchoring from the end, comparing
  // word counts before/after — was tried and caused its own visible
  // glitches on a real device; doing nothing is both simpler and correct.

  updatePhraseLed();
  toggleClearButton();
  renderSourceOverlay();
  scheduleTranslate();
});

// The drawn caret has to follow taps/arrow keys, not just typing.
document.addEventListener('selectionchange', () => {
  if (document.activeElement === el.sourceText) renderSourceOverlay();
});
el.sourceText.addEventListener('focus', renderSourceOverlay);
el.sourceText.addEventListener('blur', renderSourceOverlay);

// ---------- Keeping the input ready to type/dictate into ----------

// Focused on launch (and again whenever the app is brought back to the
// foreground, which for an installed PWA is the common "launch") so the
// keyboard and its mic button are one tap away rather than needing a tap
// on the field first. iOS only *opens* the software keyboard off a real
// user gesture, so this can't force it up by itself — but a focused
// field means the single tap that follows goes straight to the keyboard.
function focusSourceText() {
  if (!el.viewTranslate.hidden) el.sourceText.focus();
}

window.addEventListener('pageshow', focusSourceText);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) focusSourceText();
});

// ...and a tap on any dead space in the translate view counts as "I want
// to type here", so the keyboard comes up without having to hit the box
// itself. Anything actually interactive is left alone. Bound to 'click'
// rather than 'pointerdown' for two reasons: pointerdown runs before the
// browser settles focus, so it just gets overridden a moment later; and
// focusing inside a click handler is a genuine user gesture, which is
// the one thing iOS will actually open the software keyboard for.
document.addEventListener('click', (event) => {
  if (el.viewTranslate.hidden) return;
  if (event.target.closest('button, select, input, textarea, a, [tabindex], .tabbar')) return;
  // If the field is already focused (it is on launch — see `autofocus`
  // above), calling focus() again is a no-op: no focus CHANGE happens,
  // so iOS has nothing to raise the keyboard for, and the tap does
  // nothing visible. Bounce focus instead, so this gesture carries a
  // real blur→focus transition, which is what actually opens it.
  if (document.activeElement === el.sourceText) el.sourceText.blur();
  el.sourceText.focus();
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
  const value = getCurrentPhraseText();
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
// Indexed for O(1) lookup rather than scanning allEntries: this is now
// consulted before every single translation (see runTranslate), not just
// on the offline fallback path, and a linear scan of a few thousand
// entries on every keystroke would itself become the slowdown.
const translationIndex = new Map();

function translationKey(source, target, text) {
  return `${source}|${target}|${text.trim().toLowerCase()}`;
}

function indexTranslation(entry) {
  translationIndex.set(translationKey(entry.sourceLang, entry.targetLang, entry.sourceText), entry);
}

function unindexTranslation(entry) {
  translationIndex.delete(translationKey(entry.sourceLang, entry.targetLang, entry.sourceText));
}

// Oldest first, so a newer re-translation of the same text overwrites an
// older one (allEntries is newest-first).
function rebuildTranslationIndex() {
  translationIndex.clear();
  for (let i = allEntries.length - 1; i >= 0; i--) indexTranslation(allEntries[i]);
}

function findHistoryMatch(source, target, text) {
  return translationIndex.get(translationKey(source, target, text)) || null;
}

// Only the dictionary fallback gets a note — that one is a real quality
// caveat the user needs (word-for-word, no grammar). Which server
// actually answered (Google vs. a fallback provider) used to be shown
// too, but that's plumbing, not something the user needs surfaced next
// to a translation that's already right there on screen — by request,
// removed. `provider`/`googleError` are still saved on history entries
// (see runTranslate()) in case that attribution is ever wanted again.
function describeTranslationSource(usedDictionary, provider, googleError) {
  if (usedDictionary) return 'Offline word dictionary — approximate, not a full translation';
  return null;
}

async function runTranslate() {
  const text = getCurrentPhraseText().trim();
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

  // Instant local replay, BEFORE any network call. Anything this device
  // has already translated for this exact pair comes back with no
  // request at all — no round trip, no spinner, works with the network
  // off entirely. This is what makes the app get faster the more it's
  // used, and it covers the realistic dictation case well: re-saying the
  // same phrase, and every intermediate prefix of a phrase you're part
  // way through re-saying, is already indexed from last time.
  // (This used to run only as an offline fallback after the network had
  // already failed, which meant a phrase you'd said a hundred times
  // still cost a full round trip every time.)
  const cached = source !== 'auto' ? findHistoryMatch(source, target, text) : null;
  if (!cached) setBusy(true);

  try {
    let translatedText;
    let detectedLanguage;
    let usedDictionary = false;
    let provider = null;
    let googleError = null;
    if (cached) {
      translatedText = cached.translatedText;
      detectedLanguage = cached.detectedLanguage || null;
      usedDictionary = Boolean(cached.usedDictionary);
      provider = cached.provider || null;
      googleError = cached.googleError || null;
    } else try {
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

    // Served from the local index — it's already in history, so don't
    // write a duplicate entry every time an old phrase is repeated.
    if (cached) return;

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
    indexTranslation(entry);
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
  const removed = allEntries.find((e) => e.id === id);
  allEntries = allEntries.filter((e) => e.id !== id);
  // Drop it from the instant-replay index too, or a deleted translation
  // would keep coming back from memory for the rest of the session.
  if (removed) unindexTranslation(removed);
  renderHistory();
}

el.clearAllBtn.addEventListener('click', async () => {
  if (allEntries.length === 0) return;
  if (!window.confirm('Delete all history? This cannot be undone.')) return;
  await db.clearAllEntries();
  allEntries = [];
  translationIndex.clear();
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

function formatPhraseGapLabel(seconds) {
  return seconds <= 0 ? 'Off' : `${seconds.toFixed(1)}s`;
}

function initPhraseGapControl() {
  const raw = localStorage.getItem(PHRASE_GAP_KEY);
  const storedMs = raw === null ? null : Number(raw);
  const seconds = storedMs === null ? DEFAULT_PHRASE_GAP_MS / 1000 : (storedMs > 0 ? storedMs / 1000 : 0);
  el.phraseGapInput.value = String(seconds);
  el.phraseGapValue.textContent = formatPhraseGapLabel(seconds);
  el.phraseGapInput.addEventListener('input', () => {
    const value = Number(el.phraseGapInput.value);
    el.phraseGapValue.textContent = formatPhraseGapLabel(value);
    localStorage.setItem(PHRASE_GAP_KEY, String(Math.round(value * 1000)));
    updatePhraseLed();
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

  // Focused on launch so the on-screen keyboard (and its dictation mic
  // button) is ready with no tap needed first. iOS Safari generally only
  // opens the software keyboard following an actual user gesture, so
  // this may or may not actually pop the keyboard depending on OS
  // version and standalone-PWA vs. browser-tab context — not something
  // verifiable from this sandbox. Harmless either way: at worst the
  // field is just focused without the keyboard showing yet.
  el.sourceText.focus();

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
  rebuildTranslationIndex();
  renderHistory();

  toggleClearButton();
  updatePhraseLed();
  renderSourceOverlay();

  registerServiceWorker();
}

init();
