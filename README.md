# Out Loud – Private Read Aloud

A browser extension that reads web pages (or the text you select) aloud and highlights each sentence. It uses your computer's own voices. Nothing you read leaves your computer.

Licence: GPL-3.0 (see `ext/LICENSE.txt`).

## Try it in Firefox

1. Type `about:debugging` in the address bar, then choose **This Firefox**.
2. Click **Load Temporary Add-on…** and pick `dist/out-loud-<version>-firefox.zip`.
3. Open an article, click the puzzle piece, then click **Out Loud** (or press Alt+Shift+R).

Temporary add-ons are removed when Firefox closes; load it again next time.

## Using it

- **Speaker icon / Alt+Shift+R:** read the article (or your selection). Press again to pause or resume.
- **While the bar is open:** select any text in the article to jump there and keep reading from that point (toggle on the bar). Text outside the article (a caption, a sidebar) is read on its own, then it goes back to where you were.
- **Alt+click** a sentence to read from there.
- **Right-click:** "Read selection aloud" / "Read this page aloud".
- It can't run in Firefox Reader View or on built-in browser pages (browser rule). The icon shows a red "!" there.

## Files

- `ext/`: the extension source (`background.js`, `reader.js`, icons).
- `manifest.base.json`: shared manifest; `build.mjs` makes the Firefox and Chrome versions.
- `dist/`: ready-to-load zips.
- `test/`: automated tests (`python3 test/run_test.py`, needs Playwright + Chrome).

## Build

```
node build.mjs
```
