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
- Above the LibreTranslate-mirror layer, `translateText()` in `js/api.js`
  has a second, independent provider: MyMemory
  (`translateViaMyMemory()`), a long-running public translation API that
  doesn't share small community LibreTranslate mirrors' reliability
  problems. Whichever provider actually worked last is remembered
  (`lt_provider_resolved`) and tried first next time, same pattern as the
  mirror memory above. MyMemory doesn't support `source === 'auto'` —
  that combination is skipped, not attempted-then-failed, specifically so
  its "unsupported" rejection can never overwrite LibreTranslate's more
  useful error message when both are exhausted.
- There is no Settings screen, so no way to pin a custom server manually
  — the app only ever picks automatically between the mirrors above and
  MyMemory. If self-hosting support is ever needed again, that's a
  feature to reintroduce deliberately, not a removed-by-accident gap.

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
