# Out Loud – Private Read Aloud

A browser extension that reads web pages (or the text you select) aloud and highlights each sentence. It uses natural voices generated on your own computer (Kokoro, via kokoro-js) or your computer's built-in voices. Nothing you read leaves your computer.

Natural voices: 40 sentences a day free; Out Loud Pro ($5, Gumroad licence key) removes the limit. Enter the key on the extension's settings page.

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

- `ext/`: the extension source: `background.js` (toolbar, menus), `reader.js` (the player in the page), `engine/` (natural voice engine; Firefox background page, Chrome offscreen page), `pro.js` (licence + daily allowance), `options/` (settings page), `vendor/` (unmodified kokoro-js and ONNX Runtime files, see THIRD-PARTY-NOTICES.txt).
- `manifest.base.json`: shared manifest; `build.mjs` makes the Firefox and Chrome versions.
- `dist/`: ready-to-load zips (made by `node build.mjs`; not stored in the repo).
- `store/`: Firefox listing text and screenshots.
- `test/`: automated tests (need Playwright + Chrome):
  - `python3 test/run_test.py`: reader, article finding, selection (mocked speech).
  - `python3 test/run_natural_test.py`: natural-voice flow in the reader (mocked engine).
  - `python3 test/run_extension_e2e.py`: the real Chrome build, real model download and playback, allowance, licence check.
  - `test/firefox/run.sh`: the real Firefox build via web-ext (needs a sound device).

Before publishing Pro: set `GUMROAD_PRODUCT_ID` and `BUY_URL` in `ext/pro.js`.

## Build

```
node build.mjs
```
