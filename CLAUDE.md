# Project conventions

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

- `js/api.js` races several public LibreTranslate mirrors concurrently and
  remembers whichever answered first (`CANDIDATE_ENDPOINTS`). Free public
  instances are flaky — if translations start failing, that list is the
  first thing to check/update.
- Setting a server explicitly in Settings pins to exactly that one (no
  fallback), for people self-hosting or on their own known-good mirror.
