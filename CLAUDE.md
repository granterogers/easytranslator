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
  `activate` — but `activate`'s cleanup filters on `CACHE_PREFIX` and only
  ever deletes keys starting with it. It used to delete *any* key that
  didn't match the current `CACHE_NAME`, which also destroyed the separate
  Cache Storage entry `@xenova/transformers` uses to persist downloaded
  offline models — wiping every downloaded language pack on every single
  deploy, since this project bumps the version on every push. Don't widen
  that filter back to "everything except CACHE_NAME."
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
  `googleCheckedThisSession` (module-level, resets on page load) forces one
  real Google attempt per app launch even when a different provider is
  remembered as preferred — without it, a single early Google failure
  would permanently skip Google for the rest of that session (the
  steady-state optimization means only the remembered provider gets
  tried), which both stops Google from ever being noticed as recovered
  and stops `failures` below from ever containing a fresh reason why it's
  down. Bounded to once per launch, not once per keystroke, so it doesn't
  reintroduce the per-call cost the memory optimization exists to avoid.
  MyMemory doesn't support `source === 'auto'` — that combination is
  skipped, not
  attempted-then-failed, specifically so its "unsupported" rejection can
  never overwrite a real provider's more useful error message when
  everything is exhausted. The Google endpoint's response shape was
  verified against public documentation of this well-known endpoint, not a
  live call (this dev sandbox's egress is restricted to GitHub only) — if
  it starts failing, check whether Google changed the response shape
  before assuming it's just rate-limited.
- `api.translateText()` returns which provider actually answered
  (`provider` field). `js/main.js`'s `describeTranslationSource()` shows
  `#translationNote` for anything OTHER than Google or the on-device
  model ("Translated via LibreTranslate/MyMemory (Google unavailable)")
  — nothing is shown when Google succeeds, since that's the expected/
  default-quality path and showing a note every time would just be
  noise. This exists specifically so a wording difference from the real
  Google Translate app has a visible, honest explanation (a fallback
  provider answered instead) rather than looking like an unexplained
  quality bug. The note is saved with the history entry (`provider`,
  `usedDictionary` fields) so replaying that exact entry later (see
  `findHistoryMatch()` below) shows the same attribution, not a blank one.
- `translateText()`'s returned `failures` array carries the `{ id, message }`
  of every provider that failed before the one that finally answered — this
  is what lets `describeTranslationSource()` append the *real* underlying
  reason ("Google error: Failed to fetch" / "...is not valid JSON" / "Google
  responded with 429") to the note instead of a vague "Google unavailable"
  with no way to diagnose it. This matters a lot for the unofficial Google
  endpoint specifically, since a persistent failure there is otherwise
  undiagnosable without attaching devtools to the device — a JSON-parse
  error in that message means Google served an HTML block/CAPTCHA page
  instead of a translation (200 OK, so `res.ok` doesn't catch it); "Failed
  to fetch" means the request never got a response at all (network-level —
  CORS is the prime suspect, though unconfirmed without a live device
  test). Saved on the history entry as `googleError` so a replayed result
  keeps showing the same diagnostic instead of losing it.
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
  language pair usable offline, not just ones with a bundled dictionary or
  downloaded neural model: once you've translated a phrase online once
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
  throws (every server exhausted), there's no downloaded neural pack for
  the pair, AND `findHistoryMatch()` comes up empty. Pure word-for-word
  substitution, no grammar or word order, so a translated result always
  shows `#translationNote` ("approximate, not a full translation") — never
  silently pass this off as equivalent to a real translation. Entries are
  stored in the target's native script (Cyrillic for Bulgarian);
  romanization is applied afterward by the same `transliterateBulgarian()`
  call every other Bulgarian result goes through, so `dictionary.js`
  doesn't need to know about romanization at all. Only `en:bg` exists
  today (~500 entries) — the one pair this project has actually needed it
  for, since Bulgarian has no small dedicated offline model (see below)
  and the crash-prone multilingual fallback that used to cover it was
  removed. Adding another pair means adding another `"src:tgt"` entry to
  `DICTIONARIES`, nothing else.

## Offline (on-device) translation

- `js/translate-worker.js` runs `@xenova/transformers` in a Worker, tried
  from two independent CDNs in turn (jsdelivr's `+esm` endpoint, then
  esm.sh — `TRANSFORMERS_CDN_URLS`), using `Xenova/opus-mt-{src}-{tgt}`
  ONNX models. `js/offline-models.js` is the main-thread Promise-wrapper
  plus a `localStorage` record (`lt_offline_pairs`) of which pairs the
  user explicitly opted to download — never trigger a download without
  that opt-in, it costs tens of MB of the user's data.
- `#offlineBtn` (`updateOfflineButton()` in `js/main.js`) only ever shows
  when the current pair is **not** downloaded — once
  `offline.isPairDownloaded()` is true the button hides entirely rather
  than sticking around as a "downloaded"/checkmark pill; the ✓ prefix on
  the language dropdown options (`updateDownloadTicks()`) is the only
  downloaded-state indicator left. There is deliberately no remaining UI
  to manually forget/remove a downloaded pair.
- Because hiding the button removes the user's only way back to a fresh
  download, `runTranslate()` treats an offline-path failure as
  self-healing rather than a dead end: if `translateOffline()` throws for
  a pair recorded as downloaded (most likely because the browser evicted
  the underlying Cache Storage entry under storage pressure), it calls
  `offline.forgetPair()` and `refreshOfflineUI()` before
  surfacing the error, so the button reappears immediately instead of
  failing the same way on every future keystroke with no way to recover
  short of clearing site data.
- **This CDN + model-naming scheme cannot be verified from the sandbox
  this was built in** — its egress is restricted to GitHub only by
  explicit organization policy (confirmed via `/root/.ccr/README.md`'s
  "403/407: destination host is not allowed... do not retry or route
  around it"), so huggingface.co and jsdelivr.net are permanently
  unreachable there, not just flaky. This is a hard environment
  constraint, not something more testing effort resolves — real
  verification has to happen on an actual device. If offline downloads
  fail: the error surfaced in the offline button's label **is the real
  underlying error message**, not a generic one (see `getPipeline()`'s
  error handling in `translate-worker.js`) — read that first rather than
  guessing. A failed CDN load correctly clears the cached promise so a
  retry actually re-attempts the network rather than replaying a stale
  rejection (easy bug to reintroduce if this is refactored — the
  try/catch has to wrap the CDN import itself, not just the `pipeline()`
  call after it).
- `js/main.js`'s `runTranslate()` uses the offline path automatically
  whenever `offline.isPairDownloaded(source, target)` is true; everything
  else (including `source === 'auto'`, which the offline button hides
  itself for) falls through to the server path unchanged.
- **Not every language pair has a published offline model** — Xenova
  converted a subset of Helsinki-NLP's opus-mt pairs to ONNX, not all of
  them (confirmed live: `en-bg` 404s under `Xenova/`; `en-es`, `en-fr`,
  `ar-en`, `ru-en`, and others are confirmed to exist there). Hugging Face
  returns the exact string `"Unauthorized access to file"` both for
  private/gated repos and for ones that don't exist at all — `main.js`'s
  offline-download catch block matches that string and shows "isn't
  available for offline use yet" instead of a raw error, specifically
  because this is the expected, common case for a less-widely-spoken
  language, not a bug to chase.
  `translate-worker.js`'s `modelIdsFor()` tries `onnx-community/opus-mt-*`
  as a second attempt when `Xenova/*` comes back missing — verified only
  against a mocked module (same sandbox network restriction as above), not
  against the real `onnx-community/opus-mt-en-bg` repo, so whether this
  specific fallback actually resolves `en-bg` still needs a real-device
  check. If both bilingual orgs come back missing, the pair simply isn't
  offered offline — **there used to be a further fallback here** to
  `Xenova/nllb-200-distilled-600M` (Meta's 200-language model, using
  FLORES-200 codes so one shared download covered every pair it supports),
  but it was removed after being confirmed on a real device to crash
  mobile Safari mid-download: a several-hundred-MB general-purpose model
  is more than the WebView's memory budget can absorb, and that isn't
  fixable from page code. Don't reintroduce a giant-multilingual-model
  fallback without a real-device story for the memory ceiling — a pair
  with no compact dedicated model stays server-only, and that's the
  correct behavior now, not a gap to fill back in.
- A model download is several files (tokenizer, config, weights, ...)
  fetched concurrently, each with its own independent 0-100 progress
  event — reporting whichever file's event arrived last made the download
  percentage look "all over the place," dropping back toward 0 every time
  a new file started while another was already mostly done.
  `translate-worker.js`'s `makeAggregateProgress()` tracks every file's own
  completion fraction (bytes loaded/total when the event has them, its own
  reported percentage otherwise) and reports the average across all files
  seen so far — this only trends upward, since each file's tracked fraction
  never decreases. Don't go back to forwarding a single file's raw
  progress value as the download percentage.

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
  the floating icon. `#offlineBtn` is the same idea at a smaller size
  (30px, sitting in `.lang-row` immediately after the target-language
  dropdown instead of as its own full-width pill below the language row)
  — living inside `#langRow` specifically means collapsing the language
  row (`#langToggleBtn`) hides it along with the dropdowns, leaving just
  the collapse chevron and the text box, rather than it sticking around
  as a separate always-visible row. Its descriptive text moved from a
  visible label into `title`/`aria-label`
  (screen readers and desktop hover still get it), and since a hover-only
  title is invisible on a touch device, `setOfflineButtonState()`'s error
  case additionally fires a toast so the message is still actually seen.
  The live download percentage during a download shows in a small badge
  (`#offlineBtnBadge`, same visual pattern as the History tab's count
  badge, but a separate self-contained CSS rule — it does NOT share the
  `.badge` class, because that class is defined later in the stylesheet
  and its position rules would win the cascade over an identically-specific
  earlier rule).

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
- Downloaded offline pairs get a ✓ prefix on the relevant option's text
  (`updateDownloadTicks()`) — checked against the *other* dropdown's
  current value (target options check `isPairDownloaded(source, code)`
  and vice versa), so the tick reflects "would picking this complete an
  already-downloaded pair," not some standalone per-language state.
  Rewrites existing `<option>` text nodes in place rather than rebuilding
  the `<select>`, so it doesn't disturb scroll position or a picker that's
  mid-interaction. `refreshOfflineUI()` bundles this with
  `updateOfflineButton()` so both stay in sync — call that, not
  `updateOfflineButton()` alone, from any new code path that changes
  languages or download state.

## Startup performance

- The language dropdowns render synchronously from `api.FALLBACK_LANGUAGES`
  on load (`renderLanguageOptions` + `applyLanguageDefaults` in
  `js/main.js` `init()`) — they must **never** wait on
  `api.fetchLanguages()` first. That network call races translation
  mirrors with an 8s-per-attempt timeout; blocking initial render on it
  was the actual cause of the app appearing to hang for ~16s on launch
  whenever both mirrors were unreachable. The live list is fetched
  afterward in the background and swapped in via `refreshLanguageOptions`,
  which preserves whatever the user already has selected.
