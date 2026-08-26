# Project conventions

## Language defaults

- Source language always resets to English on load — never restored from
  a previous session. Target language is the one thing remembered
  (`lt_last_target` in `localStorage`).
- Translation fires on word boundaries (space/newline/punctuation) with a
  short debounce, and a longer one mid-word (`WORD_BOUNDARY_DEBOUNCE_MS` /
  `MID_WORD_DEBOUNCE_MS` in `js/main.js`) — the goal is visibly updating
  word-by-word, not waiting for the user to stop typing entirely.
- Dictation via the iOS keyboard's mic types straight into the focused
  `sourceText` field, so without help a whole day's worth of separate
  things you say would pile up into one ever-growing block instead of
  each pause-separated thing becoming its own translation. **Seven
  designs were tried here. The decisive finding, paid for with six real-
  device failures: ANY write to `sourceText.value` (or any call to
  `.select()` / `setSelectionRange()`) while the mic session may still
  be live disrupts iOS's dictation engine** — a stall of up to a minute,
  the app appearing to stop, or a ~10s lag before the next phrase
  catches up. That held for a synchronous write, a `setTimeout(0)` one,
  a 700ms-debounced one, a `.select()` instead of a write, and — this is
  the important one — even a write performed only after several seconds
  of *confirmed silence*. **A multi-second pause between sentences is
  not the same thing as the dictation session having ended**, so "wait
  until it's quiet, then write" is NOT a safe strategy; while the mic is
  on there is no safe moment to write at all. The one design that never
  disrupted dictation (confirmed by the user) was the one that never
  wrote to the field — but its flaw was cosmetic and unacceptable: the
  box visibly grew into a running transcript instead of ever looking
  like it reset for a new phrase.
  **The current design keeps the engine that works and fixes the
  appearance separately, which is why it satisfies both constraints at
  once.** `sourceText.value` is never rewritten while dictation may be
  live — the field accumulates the whole session freely. What makes the
  box *look* cleared is that the textarea's own text is rendered
  invisible (`color: transparent; caret-color: transparent` in
  `css/styles.css`) and `#sourceOverlay` — an absolutely-positioned div
  matching the textarea's box and text metrics exactly — paints only the
  current phrase over the top. `renderSourceOverlay()` in `js/main.js`
  draws that text plus its own blinking caret, mapping the real
  `selectionStart` into the visible slice so tapping mid-text still puts
  the drawn caret where typing will actually land. **If you change
  `.source-text`'s font, padding, or line-height, change
  `.source-overlay` identically or the visible text will drift out of
  alignment with the field it's standing in for.**
  Which text is "current" is `committedWordCount`, a plain JS number:
  **how many words at the start of the field belong to already-finished
  phrases** — deliberately a word count, not a character offset. When
  dictation is switched off, iOS commits its final transcript by
  clearing the field and refilling it with the whole session's text,
  re-punctuated. A character offset did not survive that: the empty
  value clamped it to 0, the refill arrived with no previous value to
  measure against, and every phrase said all session reappeared at once
  (a real reported bug). A word count does survive it — the same words
  are still there in the same order, whatever happened to the spacing
  and punctuation around them. For the same reason it is **never
  clamped when the value shrinks**: a transient empty value is exactly
  what iOS produces mid-commit. `getPhraseStart()` instead handles
  "fewer words present than committed" by treating the whole field as
  current, and skips any separator characters at the boundary so a new
  phrase never renders with a leading `" "` or `". "` left over.
  One guard goes with this: if new text arrives and the last committed
  word now runs to the very end of the field, those characters merged
  into it (backspacing into a committed word, then typing on), so the
  count hands that word back — otherwise typing goes invisible. That
  test uses `committedPrefixEnd()`, **not** `getPhraseStart()`: when a
  new phrase opens with a space the phrase really is empty for one
  keystroke, and skipping separators first misreads that as staleness
  and leaks the previous word back into every phrase.
  `getCurrentPhraseText()` is what the live-translate
  flow translates and saves to history, what `toggleClearButton()` and
  `updatePhraseLed()` read, and what `swapBtn` reverses — **not** the raw
  field value, which holds the whole hidden transcript.
  The count advances in the `input` handler at the moment the first
  chunk of a NEW phrase lands (a real pause elapsed AND the value grew)
  — deliberately **not** on the idle timer. That ordering is the whole
  point and was an explicit user requirement: during the pause the
  count is unchanged, so the phrase you just said stays on screen with
  its translation; the instant you start saying something new the count
  jumps and the box shows only the new words. Cleared first, then
  filled, with no write to the field to make it happen. An earlier
  version that advanced this on the idle poll wiped the English the
  moment the LED went green, which is wrong — "idle" is not "starting a
  new phrase".
  The boundary is recorded by COUNTING the previous value's words, never
  by matching the old phrase's characters, so iOS retroactively editing
  the old phrase's tail (e.g. swapping its trailing space for a period
  once a new sentence starts — a real bug in an earlier round) can't
  make this silently do nothing. There's no way to distinguish dictation from manual
  typing at the input-event level, so someone who manually pauses
  mid-thought past the threshold and keeps typing the same sentence will
  also see the earlier part drop out of view — a real, accepted
  tradeoff, not a bug to chase. `syncInputTracking()` re-syncs
  `lastInputAt`/`lastInputValue` and resets the count to 0 after every
  *programmatic* change to `sourceText.value` (clear button, restoring a
  history entry, swap) — those don't fire a real `input` event, and each
  replaces the whole field, so the new value is one fresh phrase. Those
  three are explicit user taps rather than dictation-time writes, which
  is why they're safe to do at all.
  **Regression guard:** `regression_no_writes.js` instruments
  `HTMLTextAreaElement.prototype.value`'s setter plus `select()` /
  `setSelectionRange()` and asserts **zero** calls across a simulated
  multi-phrase dictation session. If a future change reintroduces a
  dictation-time write, that test catches it. Keep it passing.
- **The `input` listener bails immediately if `el.sourceText.value`
  didn't actually change** (`value === lastInputValue`), before touching
  `lastInputAt` at all — iOS dictation has been observed firing `input`
  events with no real value change, which would otherwise reset the
  pause clock right as a real chunk arrives and make that chunk's own
  measured gap look too small.
- The pause threshold has an "Off" position, kept as a fallback for
  anyone who'd rather not have phrase-splitting at all: dragging
  `#phraseGapInput` to its minimum stores `0` in `lt_phrase_gap_ms`, and
  `getPhraseGapMs()` returns `Infinity` for that specific stored value,
  permanently short-circuiting the `gap >=` check so the boundary never
  advances — the whole session reads as one continuously-extending
  phrase, same as before this feature existed.
  `initPhraseGapControl()` reads the raw stored value directly (not
  through `getPhraseGapMs()`) when initializing the slider, specifically
  to avoid setting the slider's HTML `value` to the string `"Infinity"`.
  `formatPhraseGapLabel()` shows "Off" instead of "0.0s" at that
  position. Both `getPhraseGapMs()` and `initPhraseGapControl()` check
  `localStorage.getItem(PHRASE_GAP_KEY) === null` (never touched the
  slider) *before* calling `Number()` on it — `Number(null)` is `0`,
  which is indistinguishable from the explicit "Off" sentinel unless the
  `null` case is handled first. Getting this wrong silently defaulted
  every fresh install (or anyone who cleared storage) to Off instead of
  the intended 4s, a real bug caught after the fact — don't collapse
  these back into a single `Number(localStorage.getItem(...))` call.
- `#phraseLed` (below the source textarea, `updatePhraseLed()` in
  `js/main.js`) visualizes that same pause window: red while the box has
  text and less than `getPhraseGapMs()` has elapsed since the last
  keystroke/dictated chunk (more speech now would extend the current
  phrase), green once it's elapsed or whenever the box is empty. Hidden
  entirely (`hidden` attribute) when the feature is Off, since a
  permanently-green LED would just be visual noise. Polled on a
  `setInterval(250ms)` rather than only from the `input` handler, since
  the red→green transition happens passively as time passes with no DOM
  event of its own — an interval is the only way to notice it. Note it
  only READS state: unlike an earlier design, it must never advance the
  phrase boundary or touch the field, or the English disappears the
  instant the LED turns green.
- `sourceText` is focused at the end of `init()` (synchronously, after
  the theme/phrase-gap setup but before the `await db.getAllEntries()`
  point) so the on-screen keyboard — and its dictation mic button — is
  ready with no tap needed first. Whether this actually pops the
  keyboard depends on iOS's user-gesture rules for the software keyboard
  and can vary by OS version and standalone-PWA vs. Safari-tab context —
  not verifiable from this sandbox. Harmless either way: worst case the
  field is just focused without the keyboard appearing yet.

## Versioning

- Single source of truth: `js/version.js` (`APP_VERSION`). Also duplicated
  as a plain constant at the top of `sw.js` (service workers can't import
  ES modules from a classic script scope) — **keep both in sync**.
- Bump the patch number on every push to GitHub (e.g. `1.0.1` → `1.0.2`).
  Bump minor/major only for deliberately larger changes, at your judgment.
- Shown subtly at the bottom of the Settings tab (`#versionTag`), not
  anywhere prominent in the main UI.
- After actually pushing, end the reply's very last line with
  `Pushed to GitHub vX.X.X` (nothing after it) so it's visible without
  scrolling up. Only write it once the push has actually succeeded.

## Cache-busting / auto-update

- `sw.js` uses network-first with `cache: 'no-store'` for every same-origin
  GET, falling back to the cache only when the network is unreachable. This
  means an online launch always pulls the current deployed files rather
  than a stale cached copy.
- `sw.js`'s cache name is versioned (`translate-history-v${APP_VERSION}`),
  so bumping the version also invalidates the old offline-fallback cache on
  `activate` — `activate`'s cleanup only ever deletes keys starting with
  `CACHE_PREFIX`, never anything outside it, in case something else on the
  origin ever uses Cache Storage too.
- `js/main.js` reloads the page once when a new service worker takes
  control (`controllerchange`), so a fresh deploy takes effect immediately
  instead of waiting for a manual refresh.

## Translation backend

- `js/api.js`'s `CANDIDATE_ENDPOINTS` is **not a guessed list** — it's kept
  in sync with the official mirror list at
  https://github.com/LibreTranslate/Documentation
  (`src/content/docs/community/mirrors.md`). A hardcoded list built from
  training-data knowledge instead of that source went stale almost
  immediately (most of a first attempt at this list were already dead).
  If translations start failing, re-check that page before guessing new
  URLs.
- Steady state costs exactly one request (whichever mirror is cached in
  `lt_endpoint_resolved` is tried alone); a dead mirror triggers a fan-out
  race across the rest, and the new winner gets remembered.
- `translateText()` in `js/api.js` has two more independent providers above
  the LibreTranslate-mirror layer: Google, via `translateViaGoogleUnofficial()`
  — the same undocumented no-key endpoint
  (`translate.googleapis.com/translate_a/single`) most "free Google
  Translate" libraries and browser extensions use, deliberately **not**
  the official Cloud Translation API (that needs a billing-linked API key,
  which would have to sit in this app's public JS with no backend to hide
  it behind — anyone could lift it and run up charges on our bill). And
  MyMemory (`translateViaMyMemory()`), a long-running public translation
  API that doesn't share small community LibreTranslate mirrors'
  reliability problems. Google is listed first as the default order for a
  user who's never resolved a provider yet (generally the best quality of
  the three), but whichever provider actually worked last is remembered
  (`lt_provider_resolved`) and tried first next time regardless, same
  memory pattern as the mirror-level one above — so the real steady-state
  order is just whatever's proven reliable for that specific user.
  MyMemory doesn't support `source === 'auto'` — that combination is
  skipped, not attempted-then-failed, specifically so its "unsupported"
  rejection can never overwrite a real provider's more useful error
  message when everything is exhausted. The Google endpoint's response
  shape was verified against public documentation of this well-known
  endpoint, not a live call (this dev sandbox's egress is restricted to
  GitHub only) — if it starts failing, check whether Google changed the
  response shape before assuming it's just rate-limited.
- Once a non-Google provider is remembered as reliable (`lt_provider_resolved`),
  the translation itself never waits on Google again — but
  `checkGoogleInBackground()` in `js/api.js` still fires one real,
  un-awaited Google attempt per page load to find out if it's come back
  (and why, if not), without ever adding latency to the translation
  actually shown to the user. Its outcome (success reclaims
  `lt_provider_resolved`; failure is saved to `lt_google_last_error`)
  only affects the *next* call, not the one that triggered it — a
  synchronous "wait for Google once per session" version of this was
  tried first and caused a real, reported slowdown whenever Google's
  failure was slow rather than instant. Bounded to once per page load
  (`googleCheckedThisSession`) so it doesn't turn into a background
  request on every keystroke.
- `api.translateText()` returns which provider actually answered
  (`provider` field) plus `googleError` (Google's last known failure
  reason, from this call's own attempt or the background check above).
  `js/main.js`'s `describeTranslationSource()` shows `#translationNote`
  for anything other than Google ("Translated via LibreTranslate/MyMemory
  (Google unavailable — Google error: ...)") — nothing is shown when
  Google succeeds, since that's the expected/default-quality path and
  showing a note every time would just be noise. This exists specifically
  so a wording difference from the real Google Translate app has a
  visible, honest explanation instead of looking like an unexplained
  quality bug — a JSON-parse error in `googleError` means Google served
  an HTML block/CAPTCHA page instead of a translation (200 OK, so
  `res.ok` doesn't catch it); "Failed to fetch" means the request never
  got a response at all (network-level — CORS is the prime suspect,
  though unconfirmed without a live device test). Saved on the history
  entry (`provider`, `usedDictionary`, `googleError` fields) so replaying
  that exact entry later (see `findHistoryMatch()` below) shows the same
  attribution, not a blank one.
- `REQUEST_TIMEOUT_MS` (5s) bounds how long a single dead provider can
  stall the fallback chain — every provider here is a plain text-
  translation call that should answer in well under a second when
  actually up, so a generous multi-second "API timeout" default would
  just make a dead provider feel like a hung app.
- `MYMEMORY_MAX_CHARS` (500) guards against MyMemory's documented
  free/anonymous-tier limit — a request over that length doesn't error,
  it comes back HTTP 200 with a **silently truncated** translation, which
  looks exactly like "the app didn't translate everything I typed" with
  no error to explain why. Guarded the same way as `source === 'auto'`:
  MyMemory is marked `unsupported` for long text and skipped, not
  attempted-then-failed, so a longer message falls through to Google or
  LibreTranslate (neither of which shares this specific limit) instead of
  quietly losing its tail end.
- Google's response for multi-sentence (or multi-line) input comes back as
  multiple segments, one per sentence — `reassembleSegments()` locates
  each segment's original-language chunk (`segment[1]`) in the real source
  text and copies the *actual* gap between chunks (spaces, newlines,
  whatever was really there) into the output, rather than the naive
  `segments.map(s => s[0]).join('')` this replaced, which silently
  dropped whatever whitespace sat between sentences — sentences would run
  together or line breaks would vanish compared to the real Google
  Translate app. Falls back to inserting a single space between chunks
  only if a chunk's original text can't be located verbatim in the
  source (not expected in practice, but better than jamming words
  together with zero boundary).
- The Settings tab has no control to pin a custom server manually — the
  app only ever picks automatically between the providers above. If
  self-hosting support is ever needed, that's a feature to add
  deliberately (a server-URL field in Settings), not something implied
  by Settings existing now.
- **`runTranslate()` checks the local index BEFORE it touches the
  network at all**, not only as an offline fallback. `findHistoryMatch()`
  is an exact (trimmed, case-insensitive) lookup against this device's
  own saved history for the same source/target pair; a hit is rendered
  immediately with no request, no spinner, and no history row written
  (it's already in there — don't duplicate it). This is the main reason
  the app feels faster the more it's used, and it's a real answer to
  "make it work offline": once a phrase has been translated online once
  (through whichever provider — Google, LibreTranslate, MyMemory — was
  live at the time), saying it again with no network at all replays the
  real saved result, full quality, no `#translationNote` disclaimer.
  This used to run only *after* the network had already failed, so a
  phrase said a hundred times still cost a full round trip every time.
  It's exact-match only, deliberately — no fuzzy/partial matching, since
  a near-miss could replay the wrong sentence's translation with no way
  for the user to tell. Only text that's never been translated before
  goes to the network, and only then to the dictionary below.
- The lookup is backed by `translationIndex`, a `Map` keyed by
  `` `${source}|${target}|${normalizedText}` ``, **not** a scan of
  `allEntries` — it's consulted before every translation now (so, in
  effect, on every word boundary while typing or dictating), and a linear
  scan over thousands of entries at that rate would itself become the
  slowdown. Keep it in sync with `allEntries`: `rebuildTranslationIndex()`
  on load (oldest-first, so a newer re-translation wins),
  `indexTranslation()` on each new entry, `unindexTranslation()` on single
  delete, `.clear()` on clear-all. Forgetting the delete paths means a
  deleted translation keeps coming back from memory for the rest of the
  session.
- `index.html` preconnects to `https://translate.googleapis.com` so the
  first translation of a session doesn't pay DNS + TLS setup on top of
  the request. Harmless if that provider goes unused (a different one is
  remembered, or everything comes from the index above).
- `js/dictionary.js` is the true last resort, below even the servers and
  the history-reuse lookup above: a bundled word/phrase list
  (`DICTIONARIES`, keyed by `"src:tgt"`) used only when `api.translateText()`
  throws (every server exhausted) AND `findHistoryMatch()` comes up empty.
  Pure word-for-word substitution, no grammar or word order, so a
  translated result always shows `#translationNote` ("approximate, not a
  full translation") — never silently pass this off as equivalent to a
  real translation. Entries are stored in the target's native script
  (Cyrillic for Bulgarian); romanization is applied afterward by the same
  `transliterateBulgarian()` call every other Bulgarian result goes
  through, so `dictionary.js` doesn't need to know about romanization at
  all. Only `en:bg` exists today (~500 entries) — the one pair this
  project has actually needed it for, since Bulgarian has no offline
  on-device model (that feature was removed entirely — see git history —
  and isn't coming back without a deliberate re-add). Adding another pair
  means adding another `"src:tgt"` entry to `DICTIONARIES`, nothing else.
- There is no on-device/downloadable translation model anymore — it was
  removed by request (large per-pair downloads, plus a crash-prone
  fallback for pairs like Bulgarian with no small dedicated model). Every
  translation now goes through the server providers above, falling back
  to history reuse and the bundled dictionary when they're all
  unreachable. Don't reintroduce a model-download feature without that
  being an explicit, deliberate ask — it's gone on purpose, not a gap.

## Non-Latin scripts show a romanized second line

- `js/transliterate.js` exports `transliterateFor(targetLang, text)`,
  looked up against a small per-language registry (`bg`, `ru`, `el` today)
  built on a shared `makeTransliterator(map, digraphs)` helper — pure
  character substitution, no network call, so it's fully deterministic and
  testable regardless of the translation source. Returns `null` when the
  language has no scheme (already Latin-script, or just not added yet),
  which `js/main.js` treats as "don't show a second line" rather than
  displaying a redundant identical copy.
- **The native script is never replaced** — `#resultText` always shows the
  real translation as the provider returned it; `#resultRomanized` is a
  second, smaller line underneath purely as a reading aid, matching how
  the real Google Translate app shows both. This used to work differently
  for Bulgarian specifically (the Cyrillic was converted away entirely
  before display and before saving to history) — don't reintroduce that;
  history now stores the native-script `translatedText`, and the romanized
  form is recomputed on demand every time (live translate and
  restore-from-history both call `transliterateFor()` fresh) rather than
  being persisted, so there's one source of truth instead of two fields to
  keep in sync. Pre-existing history entries saved under the old Bulgarian-
  only behavior already have Latin text as `translatedText` — restoring
  one of those calls `transliterateFor('bg', <already-Latin text>)`, which
  correctly finds nothing to convert and returns `null` (no second line),
  a harmless one-time quirk for old data, not something to migrate.
- Bulgarian's map is the official government "Streamlined System" (what
  Bulgaria itself uses on road signs/passports). Russian and Greek use
  common simplified phonetic schemes, not an official standard — good
  enough as a reading aid, not meant to be authoritative. Greek's map
  needs `digraphs` (μπ→b, ντ→d, γκ→g, τσ→ts, τζ→dz, αυ→av, ευ→ev) checked
  before falling back to per-character mapping, since those two-letter
  sequences represent one sound each, not the sum of their parts — a
  naive per-letter pass would render "μπάλα" as "mpála" instead of the
  actual "bála". Don't assume Bulgarian's map applies to other Cyrillic
  languages (Ukrainian, Serbian have their own different conventions) —
  add a new map (plus digraphs if needed) and a registry entry rather than
  reusing an existing one for a language it wasn't built for.

## UI layout

- No app header — removed to save vertical space. There IS a Settings
  tab (three tabs total: Translate, History, Settings, gear icon,
  `#view-settings`) — this was deliberately re-added by request after a
  long stretch of this project explicitly avoiding one; don't read old
  history/commit messages about "no Settings screen" as still current.
  It holds the theme toggle, the dictation pause-threshold slider
  (`#phraseGapInput` — see Language defaults above), and the version tag
  (see Versioning above). Keep it minimal — this isn't an invitation to
  start accumulating every future preference into a sprawling
  Settings page just because the destination now exists.
- Light/dark theme (`applyTheme()`/`initTheme()` in `js/main.js`,
  `lt_theme` in `localStorage`, default dark) is applied via
  `data-theme="light"|"dark"` on `<html>`, with the light palette defined
  under `:root[data-theme="light"]` in `css/styles.css` — every color in
  the base `:root` needs a real value there too (or the light override
  needs its own), since anything left as a hardcoded hex/rgba outside the
  variable system (as several colors used to be — `.clear-btn`'s overlay,
  the error banner, the tab bar backdrop, the toast) silently stays
  dark-only regardless of the toggle. index.html's inline `<script>` in
  `<head>` (before the stylesheet/body) sets the same attribute from
  `localStorage` synchronously on load — without it there'd be a flash of
  the wrong theme on every launch while `js/main.js` (a module script,
  deferred) loads and runs.
- The language row is collapsible (`#langToggleBtn` / `#langRow`) for the
  same space reason; state isn't persisted across launches, always starts
  expanded.
- `js/main.js`'s `fitResultFontSize()` shrinks the result text as it gets
  longer (stepped, not a formula) so a full sentence stays visible above
  the keyboard instead of scrolling off; called everywhere `resultText` is
  set (translate, restore-from-history, swap).
- Icon-only controls, deliberately not text buttons/pills: `#clearInputBtn`
  (an X-in-circle absolutely positioned inside `.source-text-wrap`, top-right
  corner of the textarea — same pattern as native iOS text fields) and
  `#copyResultBtn` (same positioning, inside `.result-text-wrap`, copies
  `resultText.textContent` via `navigator.clipboard.writeText()` with a
  toast for success/failure). Both `.source-text` and `.result-text` carry
  extra right padding (`44px`) so real text content never renders under
  the floating icon.
- No history-count badge on the History tab, and deleting a single history
  entry (the trash icon on a row) has no confirmation dialog — it deletes
  immediately on tap. "Clear all" (wiping the entire history at once) is
  the one exception that still confirms, since it's a much bigger,
  harder-to-undo action than removing one entry.

## Language dropdown ordering

- Both dropdowns always show recently-used languages first. `js/main.js`
  keeps an MRU list (`lt_recent_languages` in `localStorage`, capped at
  `MAX_RECENT_LANGUAGES`) and `sortByRecentlyUsed()` stable-sorts the
  option list against it on every render — ties (anything not recently
  used) keep their original alphabetical order.
- **Recording is deliberately asymmetric between source and target** —
  `onLangChange()` only records whichever one the user actually just
  changed, not both. Recording both on every change was tried first and
  was a real bug: since source is "English" almost permanently, it kept
  getting bumped to the #2 recent slot on every single target switch,
  crowding out the far more useful "recently used target" signal
  entirely. `restoreEntry()` applies the same restraint (records target
  unconditionally, source only if it isn't `'en'`); `swapBtn`'s handler
  is the one deliberate exception — a swap makes both languages equally
  "just used," so it records both.

## Startup performance

- The language dropdowns render synchronously from `api.FALLBACK_LANGUAGES`
  on load (`renderLanguageOptions` + `applyLanguageDefaults` in
  `js/main.js` `init()`) — they must **never** wait on
  `api.fetchLanguages()` first. That network call races translation
  mirrors with a 5s-per-attempt timeout (`REQUEST_TIMEOUT_MS` in
  `js/api.js`); blocking initial render on it was the actual cause of the
  app appearing to hang on launch whenever both mirrors were unreachable.
  The live list is fetched afterward in the background and swapped in via
  `refreshLanguageOptions`, which preserves whatever the user already has
  selected.
