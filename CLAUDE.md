# Project conventions

## Language defaults

- Source language always resets to English on load — never restored from
  a previous session. Target language is the one thing remembered
  (`lt_last_target` in `localStorage`).
- Translation fires on word boundaries (space/newline/punctuation) with a
  short debounce, and a longer one mid-word (`WORD_BOUNDARY_DEBOUNCE_MS` /
  `MID_WORD_DEBOUNCE_MS` in `js/main.js`) — the goal is visibly updating
  word-by-word, not waiting for the user to stop typing entirely.

## Versioning

- Single source of truth: `js/version.js` (`APP_VERSION`). Also duplicated
  as a plain constant at the top of `sw.js` (service workers can't import
  ES modules from a classic script scope) — **keep both in sync**.
- Bump the patch number on every push to GitHub (e.g. `1.0.1` → `1.0.2`).
  Bump minor/major only for deliberately larger changes, at your judgment.
- There's no Settings screen — the version is shown subtly at the bottom
  of the History view instead (`#versionTag` in `index.html`, below the
  history list/empty-state), not anywhere prominent in the main UI.
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
- There is no Settings screen, so no way to pin a custom server manually
  — the app only ever picks automatically between the providers above. If
  self-hosting support is ever needed again, that's a feature to
  reintroduce deliberately, not a removed-by-accident gap.
- Before falling all the way to the bundled dictionary, `runTranslate()`'s
  `catch` around the online call first tries `findHistoryMatch()` — an
  exact (trimmed, case-insensitive) lookup against this device's own
  saved history for the same source/target pair. This is what makes any
  language pair usable offline, not just ones with a bundled dictionary:
  once you've translated a phrase online once
  (through whichever provider — Google, LibreTranslate, MyMemory — was
  live at the time), retyping that exact phrase later with no network at
  all replays the real saved result, full quality, no `#translationNote`
  disclaimer. It's exact-match only, deliberately — no fuzzy/partial
  matching, since a near-miss could replay the wrong sentence's
  translation with no way for the user to tell. Only text that's never
  been translated before falls through further to the dictionary below.
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

## Bulgarian is shown romanized

- `js/transliterate.js`'s `transliterateBulgarian()` converts Bulgarian
  output from Cyrillic to Latin using the official government "Streamlined
  System" (what Bulgaria itself uses on road signs/passports) — a pure,
  offline, deterministic character map, not a network call, so it's fully
  tested and 100% reliable regardless of the translation source. Applied
  once, right after either translation path (`js/main.js`'s
  `runTranslate()`) returns, before both display and saving to history —
  so history stores the romanized form too, not Cyrillic. Only Bulgarian;
  don't assume the same character map applies to other Cyrillic-script
  languages (Russian, Ukrainian, Serbian have their own, different
  romanization conventions).

## UI layout

- No app header, no Settings screen — removed entirely to save vertical
  space and simplify the app down to two tabs (Translate, History). The
  version tag moved to the bottom of History (see Versioning above).
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
