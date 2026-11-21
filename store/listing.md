# Firefox Add-ons listing: Out Loud – Private Read Aloud

Copy each part into the matching box on addons.mozilla.org.

## Name
Out Loud – Private Read Aloud

## Summary (max 250 characters)
Reads any article or selected text aloud and highlights each sentence as it goes. Natural, human-sounding voices made on your own computer, or your computer's built-in voices. No account, no tracking: what you read never leaves your computer.

## Description

Out Loud reads web pages to you, sentence by sentence, and highlights each one so you can follow along.

**Listen to any article**
Click the speaker (or press Alt+Shift+R). Out Loud finds the article on its own, starts with the headline, and skips menus, sidebars and footers.

**Jump around easily**
While the reader is open, select any text and it jumps there and keeps reading. You can also Alt+click a sentence, or use the previous/next buttons.

**✨ Natural voices, made on your computer**
Nine natural, human-sounding voices (US and UK English) that are far nicer to listen to than the robotic built-in ones. Unlike other read-aloud tools, they're generated on your own computer, not in the cloud, so the text you read stays private. The first time, Out Loud downloads the voice model once (about 90 MB); after that it works offline.
You get 40 natural-voice sentences a day free. Out Loud Pro ($5 once, no subscription) removes the limit.

**Your speed, your voice**
Speeds from 0.75× to 3×. Or pick any voice installed on your computer: always free and unlimited. Out Loud remembers your choice.

**Private by design**
- No account, no sign-up.
- Nothing you read is sent anywhere. All speech, natural voices included, is made by your own computer.
- No tracking, no analytics, no ads.
- Out Loud can only see a page after you click it. That's why Firefox says "Can't read and change data on this site" until you do.
- Open source: every line of code is public on GitHub.

**Good to know**
- Firefox doesn't let any extension run inside Reader View. Use Out Loud on the normal page; it finds the article by itself.
- Built-in pages (settings, the add-ons store) can't be read either. The icon shows a red "!" there.

Right-click options: "Read selection aloud" and "Read this page aloud".

## Categories (pick up to 2 that the form offers)
Suggested: Language Support, Feeds, News & Blogging (or Other)

## Tags
text to speech, read aloud, tts, accessibility, dyslexia, reading, speech

## Support / homepage
- Homepage: https://github.com/Notesonoli/out-loud
- Support site: https://github.com/Notesonoli/out-loud/issues

## Licence
GNU General Public License v3.0 (GPL-3.0)

## Privacy policy
Out Loud does not collect or send any personal data or browsing data. The text you read is turned into speech on your own computer and is never sent anywhere.
Out Loud makes only two kinds of network request:
1. The first time you use a natural voice, it downloads the voice model (about 90 MB) from Hugging Face (huggingface.co). Nothing about you or your pages is sent; it's a plain file download, like any web page loading a file.
2. If you buy Out Loud Pro and enter your licence key, the key alone is sent to Gumroad (api.gumroad.com) to check it, then again about every two weeks. Nothing else is sent.
Your settings, licence key and daily natural-voice count are stored only in your own browser.

## Screenshots
(v2: also add test/reader-natural.png-style shot of the natural voice menu, and the settings page)
- screenshot-1-reading.png: "Highlights each sentence as it reads"
- screenshot-2-select-to-jump.png: "Select any text to jump there"

## Notes to reviewer (version 2.0.0)
Our own code (background.js, reader.js, pro.js, engine/, options/) has no build step and isn't minified: the files in the zip are the source. Source is also at https://github.com/Notesonoli/out-loud.

Third-party files in vendor/ are unmodified copies from npm (details in vendor/THIRD-PARTY-NOTICES.txt):
- vendor/kokoro.web.js = kokoro-js@1.2.1 dist/kokoro.web.js (https://unpkg.com/kokoro-js@1.2.1/dist/kokoro.web.js)
- vendor/ort/ort-wasm-simd-threaded.jsep.mjs and .wasm = onnxruntime-web@1.22.0-dev.20250409-89f8206ba4 dist/ files (https://unpkg.com/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/)

About the linter warnings in those files:
- "Function constructor is eval": the Emscripten global lookup `Function("return this")` only runs when `globalThis` doesn't exist, so never in Firefox 140+. The extension CSP doesn't allow 'unsafe-eval' anyway.
- "Unsafe call to import": loads ONNX Runtime's own glue file. The path is set to the bundled vendor/ort/ folder (engine.js: env.wasmPaths = runtime.getURL("vendor/ort/")), so no remote code is ever loaded.
- CSP adds only 'wasm-unsafe-eval', needed to run the bundled WebAssembly speech engine.

Network: the voice model (data, not code) is downloaded once from huggingface.co when the user first picks a natural voice. Licence keys are checked with api.gumroad.com only when the user enters one. Page text never leaves the browser.

Permissions: activeTab + scripting (inject the reader only when the user clicks), storage (settings, licence, daily count), contextMenus (right-click options). The background page hosts the speech engine, so natural voices play from there.
