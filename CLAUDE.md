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
- The version is shown subtly in the Settings sheet (`#versionTag` in
  `index.html`), not anywhere prominent in the main UI.
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
  `activate`.
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
- Setting a server explicitly in Settings pins to exactly that one (no
  fallback), for people self-hosting or on their own known-good mirror.

## Offline (on-device) translation

- `js/translate-worker.js` runs `@xenova/transformers` in a Worker, tried
  from two independent CDNs in turn (jsdelivr's `+esm` endpoint, then
  esm.sh — `TRANSFORMERS_CDN_URLS`), using `Xenova/opus-mt-{src}-{tgt}`
  ONNX models. `js/offline-models.js` is the main-thread Promise-wrapper
  plus a `localStorage` record (`lt_offline_pairs`) of which pairs the
  user explicitly opted to download — never trigger a download without
  that opt-in, it costs tens of MB of the user's data.
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
  check. If a pair is missing from both orgs, it genuinely has no
  published ONNX conversion anywhere either of us can find, not something
  more retrying fixes.

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
