# Translate History

A mobile-first Progressive Web App for translating text, with every
translation saved automatically to a searchable local history.

- Runs entirely in the browser — **no backend, no accounts, no login**.
- Translates live as you type (word by word), no button to press. Result
  text shrinks as the translation gets longer, so it stays visible above
  the keyboard.
- Translates via a public [LibreTranslate](https://libretranslate.com/)
  server and other free providers (**no API key required** — see
  Translation server below). If every server is unreachable, it falls
  back to your own translation history and then a small bundled
  word-for-word dictionary as a last resort (see below).
- Translations into a non-Latin script (Bulgarian, Russian, Greek so far)
  show the real native-script result plus a smaller romanized line
  underneath, so you can read it aloud without needing that language's
  keyboard or font familiarity — same idea as the real Google Translate
  app, and it never replaces the actual translation with the romanized
  version the way an earlier build of this app did for Bulgarian.
- Dictating with the keyboard's mic types straight into the input box, so
  without help everything you say in one sitting would pile up into one
  ever-growing block. After a pause (adjustable in Settings, default 4s,
  or turn it Off to disable this and just let text pile up as before)
  the next thing you say starts a fresh phrase instead of tacking onto
  the last one — a small red/green dot under the input box shows whether
  you're still within that pause window (red) or a new phrase is ready
  to start (green, also shown whenever the box is empty; hidden entirely
  when the pause feature is Off).
- A small copy icon sits on the translated text — tap it to copy the
  result to your clipboard. The input box has a matching small clear
  (✕) icon in its corner instead of a separate "Clear" text link.
- Both language dropdowns always show your most recently used languages
  first.
- Minimal chrome — no header, and the language row can be collapsed to
  make more room for reading.
- History is stored locally in **IndexedDB** and persists forever on the
  device until you delete it. Deleting a single entry is immediate, no
  confirmation prompt — only "Clear all" (wiping everything at once)
  still asks first.
- Light and dark mode, switchable in Settings (defaults to dark).
- Installable as a PWA, optimized for iPhone Safari.

## Running it

Any static file server works — there's no build step.

```sh
python3 -m http.server 8080
# then open http://localhost:8080 in a browser
```

To install on iPhone: open the site in Safari, tap the Share icon, then
**Add to Home Screen**.

## Translation server

The app tries three independent, key-free providers and remembers
whichever one works: Google Translate's free, undocumented public
endpoint (the one browser extensions and "free Google Translate"
libraries use — not the official paid Cloud API, which would need a
billing-linked key this app has nowhere safe to hide); then a couple of
public LibreTranslate mirrors; then [MyMemory](https://mymemory.translated.net/),
a separate independent public translation API. Whichever one actually
answers is remembered so it's tried first next time — there's no way to
pin a specific one manually, it's fully automatic.

## Offline fallbacks (last resort)

There's no on-device/downloadable translation model — every translation
goes through the server providers above. If every server is unreachable,
the app doesn't just fail:

1. **Your own history first.** If you've translated this exact phrase
   before while online — through any of the providers above — retyping
   it later with no connection at all instantly replays that real,
   full-quality result. This works for *any* language pair, not just
   ones with a bundled dictionary, and it's built entirely from your own
   past usage, growing automatically the more you use the app.
2. **Bundled word dictionary**, only if the phrase has never been
   translated before. A small built-in word-for-word list (~500 entries
   for English → Bulgarian today, the one pair that needs it) — enough
   to get the gist of a few words across with zero network and zero
   download. It's word-by-word only (no grammar or word order), so
   results are labeled "approximate, not a full translation" rather
   than presented as a real translation.

## Settings

The Settings tab (gear icon) holds the few things that are actually
adjustable: light/dark appearance, the dictation pause-duration slider,
and the app version at the bottom. Kept deliberately small — this isn't
meant to grow into a catch-all preferences page.

## Project layout

- `index.html` — app shell and markup; also has a tiny inline script in
  `<head>` that applies the saved light/dark theme before first paint
- `css/styles.css` — mobile-first styling, light and dark themes via
  CSS variables (`:root[data-theme="light"]`)
- `js/api.js` — translation client: Google, LibreTranslate mirrors, MyMemory
- `js/db.js` — IndexedDB wrapper for history
- `js/transliterate.js` — romanization for non-Latin scripts (Bulgarian,
  Russian, Greek), shown as a second line under the real translation
- `js/dictionary.js` — bundled word-for-word dictionary, last resort when
  no server is reachable and there's no matching history entry to replay
- `js/main.js` — UI wiring: tabs, translate flow, history, recent-language
  ordering
- `sw.js` — service worker caching the app shell for offline use
- `manifest.webmanifest` — PWA install metadata
- `icons/` — app icons (source/regen instructions in `scripts/icon-source.html`)

## Privacy

No data ever leaves your device except the text you choose to translate,
which is sent directly from your browser to whichever translation service
answered last (see Translation server above). There is no analytics, no
accounts, and no server of ours in the loop.
