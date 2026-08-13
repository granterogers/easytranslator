# Translate History

A mobile-first Progressive Web App for translating text, with every
translation saved automatically to a searchable local history.

- Runs entirely in the browser — **no backend, no accounts, no login**.
- Translates live as you type (word by word), no button to press. Result
  text shrinks as the translation gets longer, so it stays visible above
  the keyboard.
- Push-to-talk speech input — hold the mic button and speak, like a
  walkie-talkie, using the browser's built-in speech recognition (no API
  key). Not available once installed to the iOS home screen (Apple
  restricts this specifically for standalone PWAs) — the app detects that
  and points to the iOS keyboard's own dictation mic instead, which works
  everywhere.
- Two translation paths: a public [LibreTranslate](https://libretranslate.com/)
  server (**no API key required**) by default, or an on-device model you
  download once per language pair for instant, fully offline translation.
- Bulgarian output is shown romanized (Latin script), not Cyrillic.
- Both language dropdowns always show your most recently used languages
  first, and mark any language that already has a downloaded offline
  pair with a ✓.
- Minimal chrome — no header, no Settings screen, and the language row
  can be collapsed to make more room for reading.
- History is stored locally in **IndexedDB** and persists forever on the
  device until you delete it.
- Installable as a PWA, optimized for iPhone Safari, dark mode only.

## Running it

Any static file server works — there's no build step.

```sh
python3 -m http.server 8080
# then open http://localhost:8080 in a browser
```

To install on iPhone: open the site in Safari, tap the Share icon, then
**Add to Home Screen**.

## Translation server

By default the app races a couple of public, key-free LibreTranslate
mirrors and remembers whichever answers; if both are down, it
automatically falls back to [MyMemory](https://mymemory.translated.net/),
a separate, independent public translation API with no key required.
Whichever one actually works is remembered so it's tried first next time.
There's no Settings screen to point this at a different server — it's
fully automatic.

## Offline (on-device) translation

Tap the pill below the language row ("Download {language} for offline")
to download a small neural translation model for the current language
pair. Once downloaded, that pair translates instantly with zero network
calls — works on a plane, works if every public mirror is down. Models
are cached by the browser (tens of MB per pair), so this is a one-time
download per pair, not per session. Tap the pill again once downloaded to
remove it.

Language pairs without a downloaded model keep using the server path
above automatically. For a pair with no dedicated model published anywhere
(Bulgarian, at least, as of writing), the app falls back to a single
much-larger multilingual model covering 200 languages — a real tradeoff
in download size, but the only way to get that language offline at all.

## Project layout

- `index.html` — app shell and markup
- `css/styles.css` — dark, mobile-first styling
- `js/api.js` — translation client: LibreTranslate mirrors, then MyMemory
- `js/db.js` — IndexedDB wrapper for history
- `js/offline-models.js` — main-thread manager for on-device models: which
  pairs are downloaded, and a Promise-based wrapper around the worker
- `js/translate-worker.js` — runs the on-device model in a Worker so
  downloading/inference never blocks the UI
- `js/transliterate.js` — Cyrillic→Latin romanization for Bulgarian
- `js/main.js` — UI wiring: tabs, translate flow, history,
  offline-download button, push-to-talk mic, recent-language ordering
- `sw.js` — service worker caching the app shell for offline use
- `manifest.webmanifest` — PWA install metadata
- `icons/` — app icons (source/regen instructions in `scripts/icon-source.html`)

## Privacy

No data ever leaves your device except the text you choose to translate,
which is sent directly from your browser to whichever translation service
answered last (see Translation server above) — or nowhere at all, for a
downloaded offline pair. There is no analytics, no accounts, and no
server of ours in the loop.
