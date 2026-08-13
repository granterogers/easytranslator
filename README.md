# Translate History

A mobile-first Progressive Web App for translating text, with every
translation saved automatically to a searchable local history.

- Runs entirely in the browser — **no backend, no accounts, no login**.
- Translates live as you type (word by word), no button to press. Result
  text shrinks as the translation gets longer, so it stays visible above
  the keyboard.
- Two translation paths: a public [LibreTranslate](https://libretranslate.com/)
  server (**no API key required**) by default, or an on-device model you
  download once per language pair for instant, fully offline translation.
  If neither is available for a pair, a small bundled word-for-word
  dictionary kicks in as a last resort (see below).
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
download per pair, not per session. The pill disappears once a pair is
downloaded — a ✓ next to the language name in the dropdowns is the only
remaining indicator.

Language pairs without a downloaded model keep using the server path
above automatically. A pair with no dedicated model published anywhere
(Bulgarian, at least, as of writing) isn't offered a full neural download
at all — an earlier version fell back to a single much-larger multilingual
model, but that fallback was removed after it was confirmed to crash
mobile Safari mid-download.

## Offline word dictionary (last resort)

If every server is unreachable *and* there's no neural model for the
current pair, the app falls back to a small bundled word-for-word
dictionary rather than failing outright — enough to get the gist of a
few words across with zero network and zero download. It's word-by-word
only (no grammar or word order), so results are labeled "approximate,
not a full translation" rather than presented as a real translation.
Today this only covers English → Bulgarian, the one pair that needs it.

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
- `js/dictionary.js` — bundled word-for-word dictionary, last-resort
  fallback when both the servers and any neural model are unavailable
- `js/main.js` — UI wiring: tabs, translate flow, history,
  offline-download button, recent-language ordering
- `sw.js` — service worker caching the app shell for offline use
- `manifest.webmanifest` — PWA install metadata
- `icons/` — app icons (source/regen instructions in `scripts/icon-source.html`)

## Privacy

No data ever leaves your device except the text you choose to translate,
which is sent directly from your browser to whichever translation service
answered last (see Translation server above) — or nowhere at all, for a
downloaded offline pair. There is no analytics, no accounts, and no
server of ours in the loop.
