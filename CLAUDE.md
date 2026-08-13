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

- `js/translate-worker.js` runs `@xenova/transformers` (loaded from the
  jsdelivr CDN, no bundler needed) in a Worker, using
  `Xenova/opus-mt-{src}-{tgt}` ONNX models. `js/offline-models.js` is the
  main-thread Promise-wrapper plus a `localStorage` record
  (`lt_offline_pairs`) of which pairs the user explicitly opted to
  download — never trigger a download without that opt-in, it costs tens
  of MB of the user's data.
- **This CDN + model-naming scheme could not be verified from the sandbox
  this was built in** (huggingface.co and jsdelivr.net were both
  unreachable from that environment — same class of problem as the
  LibreTranslate mirror list above, just impossible to catch before
  shipping this time). If offline downloads fail in the wild, check the
  browser console for the actual error before assuming the plumbing is
  broken — the CDN URL or model repo naming may have moved on, in which
  case update `TRANSFORMERS_CDN_URL` / `modelIdFor()` in
  `js/translate-worker.js`.
- `js/main.js`'s `runTranslate()` uses the offline path automatically
  whenever `offline.isPairDownloaded(source, target)` is true; everything
  else (including `source === 'auto'`, which the offline button hides
  itself for) falls through to the server path unchanged.
