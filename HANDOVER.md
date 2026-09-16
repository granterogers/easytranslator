# Handover — Translate History

Status as of **v1.11.4** (2026-09-16). This is a project handover for
whoever picks this up next — a human developer, not an AI agent. If
you're an AI agent working in this repo, read `CLAUDE.md` instead;
it's the detailed, code-level reference this document deliberately
does not duplicate.

## What this is

A mobile-first Progressive Web App for translating text, optimized for
iPhone Safari. No backend, no accounts, no login — it runs entirely in
the browser and calls free public translation providers directly from
the client. Every translation is saved automatically to a local,
on-device, searchable history.

Live repo: https://github.com/granterogers/easytranslator
Deployed via GitHub Pages from the `main` branch (no build step — it's
plain static HTML/CSS/JS, `python3 -m http.server` works fine locally
too). There is no CI/CD pipeline and no GitHub Actions workflow —
pushing to `main` is the deploy.

Two branches are kept in sync and pushed together on every change:
`main` and `claude/translate-history-pwa-3kuwaj` (the working branch
this project has been developed on). Push both, always — see
`CLAUDE.md`'s Versioning section for the exact push commands used
throughout this project's history.

## Quick orientation

- `index.html` — app shell, three tabs (Translate / History / Settings)
- `js/main.js` (~1100 lines) — all UI wiring: translate flow, the
  dictation phrase-splitting system, history, settings, tabs
- `js/api.js` — translation client (Google unofficial endpoint,
  LibreTranslate mirrors, MyMemory), with provider/mirror fallback and
  memory of what worked last
- `js/db.js` — IndexedDB wrapper for history
- `js/dictionary.js` — bundled word-for-word fallback (English→Bulgarian
  only), last resort when every server and history-replay miss
- `js/transliterate.js` — romanization for Bulgarian/Russian/Greek results
- `sw.js` — service worker, app-shell caching for offline use
- `README.md` — user-facing feature description
- `CLAUDE.md` — **the real documentation**. Every non-obvious design
  decision in this codebase is explained there, usually with the
  specific bug report that caused it. Read it before changing anything
  in the dictation/phrase-splitting area especially.

## The one thing to understand before touching anything

The dictation "start a new phrase after a pause" feature
(`js/main.js`, search `committedWordCount`) went through **seven
design iterations**, each one breaking on a real iOS device in a
different way (dictation stalling for up to a minute, the app
"stopping," phrases gluing together permanently, the wrong phrase
reappearing when the mic was switched off). The current design is the
one that survived all of them. `CLAUDE.md`'s Language Defaults section
documents every failed attempt and exactly why it failed, in detail —
that history exists specifically so nobody (human or AI) re-discovers
the same dead ends by trial and error. If you're about to change how
phrase-boundary detection works, read that section first, in full.

The short version of the constraint that shaped all of it: **the app
must never call `.value =`, `.select()`, or `.setSelectionRange()` on
the source textarea while dictation might still be active** — any of
those disrupts iOS's dictation engine. The current design achieves the
"looks like it cleared" effect purely visually (an overlay div painted
on top of an invisible textarea) without ever touching the real field.
`regression_no_writes.js` (see below) is a standing regression guard
for this specific invariant.

## Testing

There is no committed automated test suite — testing throughout this
project has been ad hoc Playwright scripts, written and run from a
scratch directory outside the repo (not checked in), against a local
`python3 -m http.server 8080` with translation APIs mocked via
`page.route()`. If you want to verify a change to the dictation system,
the pattern that's worked well:

1. Serve the app locally and mock the translate endpoints.
2. Simulate dictation via direct `el.value += chunk` +
   `dispatchEvent(new Event('input', { bubbles: true }))` calls with
   realistic delays between chunks — **not** `page.keyboard.type()`
   alone, which doesn't reproduce how iOS dictation actually delivers
   text (bursts, sometimes with no separating space between phrases,
   sometimes as a full-session rewrite when the mic is switched off).
3. For anything touching the phrase-boundary logic, specifically test:
   a normal multi-phrase session, a phrase transition with **no**
   separating space between phrases (this was a real, 100%-reproducible
   bug — see `CLAUDE.md`), and the mic-off rewrite (clear-then-refill
   and single-replacement forms).
4. Instrument `HTMLTextAreaElement.prototype.value`'s setter to assert
   zero writes during a simulated dictation session, if you're touching
   anything near the phrase-splitting code — this is the single most
   important invariant in the app.

None of this has been verified on an actual iOS device from this
environment (sandboxed, GitHub-only network egress) — every fix in this
project's history has been informed by the user's real-device reports,
then verified by simulation, never by direct device testing on my end.
Real-device confirmation from an actual user remains the only way to
be fully sure a dictation-related change works.

## Translation backend

Three independent, key-free public providers, raced/fallen-back-through
in whichever order last worked for this browser
(`lt_provider_resolved` in localStorage), with a `Set`-based
same-session demotion for anything that's already failed once this
session (`failedThisSession` in `js/api.js`) so a rate-limited provider
doesn't cost a full timeout on every subsequent call. Local history is
checked *before* the network on every translation — an exact repeat of
something already translated returns instantly with zero requests.
Full detail (timeouts, MyMemory's length limit, Google's response
shape, the LibreTranslate mirror list) is in `CLAUDE.md`'s Translation
Backend section.

There is intentionally no on-device/downloadable translation model —
it was removed earlier in this project's life (large downloads, crash-
prone for language pairs with no small model) and isn't coming back
without a deliberate, explicit re-ask.

## Known limitations / things that are deliberate, not bugs

- The keyboard cannot be made to open automatically on launch — this is
  an iOS/WebKit restriction (software keyboard only opens on a genuine
  user gesture), not something achievable by any focus trick. Don't
  spend time trying to work around it again.
- No server-URL field in Settings to pin a custom translation server —
  provider selection is fully automatic. Add this deliberately if
  self-hosting support is ever actually needed.
- Settings is deliberately minimal (theme, dictation pause slider,
  version tag) — this project spent a long time with no Settings screen
  at all before one was explicitly requested; don't let it grow into a
  general preferences page by default.
- A manual pause mid-sentence longer than the dictation threshold will
  also start a "new phrase" for a person typing normally, not just
  during dictation — accepted tradeoff, not a bug to chase (there's no
  way to distinguish dictation from typing at the input-event level).

## Suggested next steps for whoever picks this up

- Get this in front of the user for a real multi-day iOS usage test —
  the phrase-splitting system has had a lot of iteration but no
  extended real-world soak test since the last fix (v1.11.4, the
  word-gluing/permanent-corruption fix).
- Consider adding a couple of the ad hoc Playwright regression scripts
  into the repo properly (a `tests/` folder + a documented `npm test`
  or shell script) so `regression_no_writes.js`'s invariant in
  particular survives across sessions/agents instead of living only in
  scratch directories.
- No outstanding bug reports as of this handover.
