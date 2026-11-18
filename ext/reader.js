// Out Loud: the reader. Runs in the page only after you ask it to.
// Finds the article (or your selection), splits it into sentences, reads them
// with your computer's own voices and highlights each sentence as it's read.
// Nothing leaves your computer.

(() => {
  if (window.__outloudLoaded) return;
  window.__outloudLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const synth = window.speechSynthesis;

  const BLOCK_DISPLAYS = new Set(["block", "list-item", "table-cell", "table-caption", "flex", "grid", "table", "flow-root"]);
  const SKIP = "script,style,noscript,template,svg,math,textarea,input,select,button,nav,aside,footer,form,[aria-hidden='true'],[role='navigation'],[role='complementary'],[role='banner'],[hidden],.outloud-host";
  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const MAX_CHUNK = 260; // long sentences are split so voices don't cut out

  const state = {
    segments: [], // what's playing now: the article, or a selection outside it
    article: [], // { text, range } for the whole article
    inSelection: false, // playing a selection that isn't part of the article
    resume: 0, // article position to return to after such a selection
    index: 0,
    playing: false,
    token: 0,
    rate: 1,
    voiceName: "",
    readOnSelect: true,
    utterance: null, // kept alive so the browser doesn't drop it mid-sentence
    spokeAt: 0,
    lastSelText: "",
    ui: null,
  };

  // ---------- settings ----------

  async function loadSettings() {
    try {
      const s = await api.storage.local.get({ rate: 1, voiceName: "", readOnSelect: true });
      state.rate = SPEEDS.includes(s.rate) ? s.rate : 1;
      state.voiceName = s.voiceName || "";
      state.readOnSelect = s.readOnSelect !== false;
    } catch { /* storage unavailable: use defaults */ }
  }

  function saveSettings() {
    try { api.storage.local.set({ rate: state.rate, voiceName: state.voiceName, readOnSelect: state.readOnSelect }); } catch { /* ignore */ }
  }

  // ---------- finding the text ----------

  const styleCache = new WeakMap();
  function style(el) {
    let s = styleCache.get(el);
    if (!s) { s = getComputedStyle(el); styleCache.set(el, s); }
    return s;
  }

  function isHidden(el) {
    const s = style(el);
    return s.display === "none" || s.visibility === "hidden";
  }

  function skipped(el, strict) {
    if (!el) return true;
    if (el.closest(".outloud-host")) return true;
    if (strict && el.closest(SKIP)) return true;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      if (isHidden(e)) return true;
    }
    return false;
  }

  // Find the article: add up the paragraph text inside every container, then
  // take the deepest container holding most (70%) of it. This copes with sites
  // that wrap each paragraph in its own boxes (BBC, many news sites).
  function findArticleRoot() {
    const totals = new Map();
    let all = 0;
    for (const p of document.querySelectorAll("p, pre, blockquote")) {
      const len = (p.textContent || "").trim().length;
      if (len < 40 || skipped(p, true)) continue;
      all += len;
      for (let el = p.parentElement; el && el !== document.documentElement; el = el.parentElement) {
        totals.set(el, (totals.get(el) || 0) + len);
      }
    }
    if (!all) return document.body;
    let best = document.body, bestDepth = -1;
    for (const [el, total] of totals) {
      if (total < all * 0.7) continue;
      let depth = 0;
      for (let e = el; e; e = e.parentElement) depth++;
      if (depth > bestDepth) { best = el; bestDepth = depth; }
    }
    return best;
  }

  function blockOf(node, root) {
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (el === root) return el;
      if (BLOCK_DISPLAYS.has(style(el).display)) return el;
    }
    return root;
  }

  // Collect the text nodes to read, grouped into blocks (paragraphs, list
  // items, headings...). `limit` is an optional Range (the selection).
  function collectBlocks(root, limit, strict) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !/\S/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        if (limit && !limit.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
        if (skipped(n.parentElement, strict)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const blocks = [];
    let current = null, currentBlock = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let start = 0, end = n.nodeValue.length;
      if (limit) {
        if (n === limit.startContainer) start = limit.startOffset;
        if (n === limit.endContainer) end = limit.endOffset;
        if (end <= start) continue;
      }
      const b = blockOf(n, root);
      if (b !== currentBlock) {
        current = { pieces: [] };
        blocks.push(current);
        currentBlock = b;
      }
      current.pieces.push({ node: n, start, end });
    }
    return blocks;
  }

  // The article's title often sits outside the main container: read it first.
  function titleBlock(root) {
    const h1 = document.querySelector("h1");
    if (!h1 || root.contains(h1) || skipped(h1, true)) return null;
    if (!(h1.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;
    return collectBlocks(h1, null, false)[0] || null;
  }

  const segmenter = typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter(document.documentElement.lang || undefined, { granularity: "sentence" })
    : null;

  // Titles and short forms that end in a full stop but don't end a sentence.
  const ABBREV = /(?:^|[\s(])(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Mt|Ft|Gen|Col|Capt|Lt|Sgt|Rev|Hon|Gov|Sen|Rep|Pres|Inc|Ltd|Co|Corp|vs|etc|e\.g|i\.e|cf|al|approx|No|Nos|Vol|Fig|pp|p|ch|ed|eds|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|[A-Z])\.\s*$/;

  function sentenceBounds(text) {
    let out;
    if (segmenter) out = [...segmenter.segment(text)].map((s) => [s.index, s.index + s.segment.length]);
    else {
      out = [];
      const re = /[^.!?。]+[.!?。]*["')\]]*\s*/g;
      let m;
      while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
      if (!out.length) out = [[0, text.length]];
    }
    // Rejoin pieces split after an abbreviation ("Dr." + "Smith said...").
    const merged = [];
    for (const b of out) {
      const prev = merged[merged.length - 1];
      if (prev && ABBREV.test(text.slice(prev[0], prev[1]))) prev[1] = b[1];
      else merged.push([...b]);
    }
    return merged;
  }

  // Break very long sentences at commas, semicolons or spaces.
  function splitLong(text, s, e) {
    const parts = [];
    while (e - s > MAX_CHUNK) {
      const window_ = text.slice(s, s + MAX_CHUNK);
      let cut = Math.max(window_.lastIndexOf(", "), window_.lastIndexOf("; "), window_.lastIndexOf(": "));
      if (cut < MAX_CHUNK / 3) cut = window_.lastIndexOf(" ");
      if (cut < MAX_CHUNK / 3) cut = MAX_CHUNK - 1;
      parts.push([s, s + cut + 1]);
      s += cut + 1;
    }
    parts.push([s, e]);
    return parts;
  }

  function blockSegments(block) {
    let text = "";
    const map = []; // { at, piece }
    for (const p of block.pieces) {
      map.push({ at: text.length, piece: p });
      text += p.node.nodeValue.slice(p.start, p.end);
    }
    const locate = (pos, isEnd) => {
      let i = map.length - 1;
      while (i > 0 && (map[i].at > pos || (isEnd && map[i].at === pos))) i--;
      const { at, piece } = map[i];
      return [piece.node, Math.min(piece.start + (pos - at), piece.end)];
    };
    const segs = [];
    for (const [s0, e0] of sentenceBounds(text)) {
      for (const [s, e] of splitLong(text, s0, e0)) {
        const sentence = text.slice(s, e).replace(/\s+/g, " ").trim();
        if (!/[\p{L}\p{N}]/u.test(sentence)) continue;
        // trim the range to the visible words
        const lead = text.slice(s, e).search(/\S/);
        const trail = text.slice(s, e).length - text.slice(s, e).trimEnd().length;
        const range = document.createRange();
        try {
          range.setStart(...locate(s + lead, false));
          range.setEnd(...locate(e - trail, true));
        } catch { continue; }
        segs.push({ text: sentence, range });
      }
    }
    return segs;
  }

  function articleSegments() {
    const root = findArticleRoot();
    const blocks = collectBlocks(root, null, true);
    const t = titleBlock(root);
    if (t) blocks.unshift(t);
    return blocks.flatMap(blockSegments);
  }

  function selectionSegments(range) {
    let root = range.commonAncestorContainer;
    if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentElement;
    return collectBlocks(root, range, false).flatMap(blockSegments);
  }

  function currentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    return text ? { text, range: sel.getRangeAt(0) } : null;
  }

  // First article sentence that overlaps the range (-1 if none).
  function articleIndexFor(range) {
    return state.article.findIndex((seg) => {
      try {
        // overlap: selection starts before the sentence ends, and ends after it starts
        return range.compareBoundaryPoints(Range.END_TO_START, seg.range) < 0
          && range.compareBoundaryPoints(Range.START_TO_END, seg.range) > 0;
      } catch { return false; }
    });
  }

  // ---------- highlighting ----------

  const supportsHighlight = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";
  let pageStyle = null;

  function ensurePageStyle() {
    if (pageStyle || !supportsHighlight) return;
    pageStyle = document.createElement("style");
    pageStyle.textContent = "::highlight(outloud-sentence){background-color:rgba(255,213,79,.55);color:inherit;}";
    (document.head || document.documentElement).appendChild(pageStyle);
  }

  function highlight(seg) {
    if (supportsHighlight) {
      ensurePageStyle();
      CSS.highlights.set("outloud-sentence", new Highlight(seg.range));
    }
    const r = seg.range.getBoundingClientRect();
    const bottomLimit = window.innerHeight - 90; // keep clear of the player
    if (r.height && (r.top < 0 || r.bottom > bottomLimit)) {
      window.scrollBy({ top: r.top - window.innerHeight / 3, behavior: "smooth" });
    }
  }

  function clearHighlight() {
    if (supportsHighlight) CSS.highlights.delete("outloud-sentence");
  }

  // ---------- speech ----------

  function voices() {
    return synth.getVoices();
  }

  function pickVoice() {
    const all = voices();
    if (!all.length) return null;
    if (state.voiceName) {
      const v = all.find((x) => x.name === state.voiceName);
      if (v) return v;
    }
    const lang = (document.documentElement.lang || navigator.language || "en").toLowerCase().split("-")[0];
    return all.find((v) => v.lang?.toLowerCase().startsWith(lang) && v.default)
      || all.find((v) => v.lang?.toLowerCase().startsWith(lang))
      || all.find((v) => v.default)
      || all[0];
  }

  function speakCurrent() {
    const token = ++state.token;
    synth.cancel();
    const seg = state.segments[state.index];
    if (!seg) { finished(); return; }
    highlight(seg);
    updateUI();
    const u = new SpeechSynthesisUtterance(seg.text);
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = state.rate;
    state.utterance = u;
    u.onend = () => {
      if (token !== state.token || !state.playing) return;
      state.index++;
      speakCurrent();
    };
    u.onerror = (e) => {
      if (token !== state.token || !state.playing) return;
      if (e.error === "interrupted" || e.error === "canceled") return;
      state.index++;
      speakCurrent();
    };
    // Some browsers drop an utterance spoken in the same tick as cancel().
    setTimeout(() => {
      if (token !== state.token || !state.playing) return;
      state.spokeAt = Date.now();
      synth.speak(u);
    }, 30);
  }

  // Watchdog: some browsers occasionally never report that a sentence ended.
  // If the voice has gone quiet for a while, move on to the next sentence.
  let watchdog = null;
  function startWatchdog() {
    clearInterval(watchdog);
    watchdog = setInterval(() => {
      if (!state.playing || !state.spokeAt) return;
      if (synth.speaking || synth.pending) return;
      if (Date.now() - state.spokeAt < 1500) return;
      state.spokeAt = 0;
      state.index++;
      speakCurrent();
    }, 700);
  }
  function stopWatchdog() { clearInterval(watchdog); watchdog = null; }

  function play() {
    if (!state.segments.length) return;
    if (state.index >= state.segments.length) state.index = 0;
    state.playing = true;
    startWatchdog();
    speakCurrent();
  }

  function pause() {
    state.playing = false;
    stopWatchdog();
    state.token++;
    synth.cancel();
    updateUI();
  }

  function finished() {
    if (state.inSelection) {
      backToArticle(state.resume);
      return;
    }
    state.playing = false;
    stopWatchdog();
    state.index = state.segments.length;
    clearHighlight();
    updateUI();
  }

  function backToArticle(index) {
    state.inSelection = false;
    state.segments = state.article;
    state.index = Math.max(0, Math.min(index, state.article.length - 1));
    state.playing = false;
    stopWatchdog();
    clearHighlight();
    updateUI();
  }

  // Start reading the article at sentence i.
  function readArticleFrom(i) {
    state.inSelection = false;
    state.segments = state.article;
    state.index = i;
    play();
  }

  // Selected text: jump there in the article and keep going. If the text isn't
  // part of the article (a caption, a sidebar...), read just that, then come
  // back to where the article was. `only` = read just the selection anyway.
  function readSelection(sel, only) {
    state.lastSelText = sel.text;
    if (!only) {
      const i = articleIndexFor(sel.range);
      if (i >= 0) { readArticleFrom(i); return; }
    }
    const segs = selectionSegments(sel.range);
    if (!segs.length) return;
    if (!state.inSelection) state.resume = state.index;
    pause();
    state.inSelection = true;
    state.segments = segs;
    state.index = 0;
    play();
  }

  function jump(delta) {
    state.index = Math.max(0, Math.min(state.segments.length - 1, state.index + delta));
    if (state.playing) speakCurrent();
    else { highlight(state.segments[state.index]); updateUI(); }
  }

  // Alt+click a sentence to read from there.
  function onPageClick(e) {
    if (!e.altKey || !state.segments.length) return;
    let node, offset;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node) return;
    const i = state.article.findIndex((s) => {
      try { return s.range.isPointInRange(node, offset); } catch { return false; }
    });
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    readArticleFrom(i);
  }

  // ---------- player ----------

  const ICONS = {
    play: "M8 5v14l11-7z",
    pause: "M7 5h4v14H7zM13 5h4v14h-4z",
    prev: "M6 5h2v14H6zM20 5v14L9 12z",
    next: "M16 5h2v14h-2zM4 5v14l11-7z",
    select: "M9 3v2h2v14H9v2h6v-2h-2V5h2V3zM3 8h4v2H5v4h2v2H3zm14 0h4v8h-4v-2h2v-4h-2z",
    close: "M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z",
  };

  function icon(name) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    for (const c of children) e.append(c);
    return e;
  }

  const CSS_TEXT = `
    :host { all: initial; }
    .bar { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      background: #1f2328; color: #f5f5f5; border-radius: 14px;
      box-shadow: 0 6px 24px rgba(0,0,0,.35);
      font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; }
    button { all: unset; cursor: pointer; width: 32px; height: 32px; border-radius: 8px;
      display: grid; place-items: center; color: inherit; }
    button:hover { background: rgba(255,255,255,.12); }
    button.select[aria-pressed="true"] { color: #ffd54f; background: rgba(255,213,79,.15); }
    button:focus-visible, select:focus-visible { outline: 2px solid #ffd54f; outline-offset: 1px; }
    button.main { background: #ffd54f; color: #1f2328; width: 38px; height: 38px; border-radius: 50%; }
    button.main:hover { background: #ffe082; }
    svg { width: 20px; height: 20px; fill: currentColor; }
    select { background: #2d333b; color: inherit; border: 1px solid #444c56; border-radius: 8px;
      padding: 5px 6px; font: inherit; max-width: 170px; }
    .count { min-width: 64px; text-align: center; opacity: .8; font-variant-numeric: tabular-nums; }
    .sep { width: 1px; height: 24px; background: #444c56; margin: 0 2px; }
  `;

  function buildUI() {
    const host = document.createElement("div");
    host.className = "outloud-host";
    const root = host.attachShadow({ mode: "open" });
    const button = (cls, label, ic) => el("button", { class: cls, title: label, "aria-label": label }, [icon(ic)]);
    const speedSel = el("select", { class: "speed", title: "Speed", "aria-label": "Speed" },
      SPEEDS.map((s) => el("option", { value: String(s) }, [`${s}×`])));
    root.append(
      el("style", {}, [CSS_TEXT]),
      el("div", { class: "bar", role: "region", "aria-label": "Out Loud reader" }, [
        button("prev", "Previous sentence", "prev"),
        button("main play", "Play", "play"),
        button("next", "Next sentence", "next"),
        el("span", { class: "count", "aria-live": "off" }),
        el("span", { class: "sep" }),
        speedSel,
        el("select", { class: "voice", title: "Voice", "aria-label": "Voice" }),
        button("select", "Read text when I select it", "select"),
        button("close", "Close reader", "close"),
      ]),
    );
    const $ = (s) => root.querySelector(s);
    $(".prev").addEventListener("click", () => jump(-1));
    $(".next").addEventListener("click", () => jump(1));
    $(".play").addEventListener("click", () => (state.playing ? pause() : play()));
    $(".close").addEventListener("click", closeReader);
    const speed = $(".speed");
    speed.value = String(state.rate);
    speed.addEventListener("change", () => {
      state.rate = Number(speed.value);
      saveSettings();
      if (state.playing) speakCurrent();
    });
    const voiceSel = $(".voice");
    voiceSel.addEventListener("change", () => {
      state.voiceName = voiceSel.value;
      saveSettings();
      if (state.playing) speakCurrent();
    });
    document.documentElement.appendChild(host);
    state.ui = { host, root, $ };
    fillVoices();
    synth.addEventListener?.("voiceschanged", fillVoices);
    $(".select").addEventListener("click", () => {
      state.readOnSelect = !state.readOnSelect;
      saveSettings();
      updateUI();
    });
    document.addEventListener("click", onPageClick, true);
    document.addEventListener("mouseup", onSelectEnd, true);
    document.addEventListener("keyup", onSelectEnd, true);
  }

  // While the reader is open, selecting text reads it straight away.
  let selectTimer = null;
  function onSelectEnd(e) {
    if (!state.readOnSelect || !state.ui) return;
    if (e.composedPath?.().includes(state.ui.host)) return;
    if (e.type === "keyup" && !e.shiftKey) return; // only Shift+arrow selections
    clearTimeout(selectTimer);
    selectTimer = setTimeout(() => {
      const sel = window.getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
      if (!text) { state.lastSelText = ""; return; }
      if (text === state.lastSelText) return;
      const cur = currentSelection();
      if (cur) readSelection(cur, false);
    }, 250);
  }

  function fillVoices() {
    if (!state.ui) return;
    const sel = state.ui.$(".voice");
    const current = pickVoice();
    const all = voices().slice().sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
    sel.textContent = "";
    for (const v of all) {
      const o = document.createElement("option");
      o.value = v.name;
      o.textContent = `${v.name.replace(/^Microsoft |^Google /, "")} (${v.lang})`;
      if (current && v.name === current.name) o.selected = true;
      sel.appendChild(o);
    }
    sel.disabled = all.length === 0;
  }

  function updateUI() {
    if (!state.ui) return;
    const { $ } = state.ui;
    const btn = $(".play");
    btn.replaceChildren(icon(state.playing ? "pause" : "play"));
    btn.title = state.playing ? "Pause" : "Play";
    btn.setAttribute("aria-label", btn.title);
    const selBtn = $(".select");
    selBtn.setAttribute("aria-pressed", String(state.readOnSelect));
    selBtn.title = state.readOnSelect ? "Reading text when you select it (click to turn off)" : "Read text when I select it";
    const total = state.segments.length;
    $(".count").textContent = total ? `${Math.min(state.index + 1, total)} / ${total}` : "Nothing to read";
  }

  function closeReader() {
    pause();
    clearHighlight();
    document.removeEventListener("click", onPageClick, true);
    document.removeEventListener("mouseup", onSelectEnd, true);
    document.removeEventListener("keyup", onSelectEnd, true);
    clearTimeout(selectTimer);
    state.lastSelText = "";
    synth.removeEventListener?.("voiceschanged", fillVoices);
    state.ui?.host.remove();
    state.ui = null;
    state.segments = [];
    state.article = [];
    state.inSelection = false;
  }

  // ---------- entry point ----------

  // mode: "auto" (toolbar/shortcut), "page" or "selection" (right-click menu).
  async function startReader(mode) {
    const sel = currentSelection();
    const freshSel = sel && sel.text !== state.lastSelText ? sel : null;
    if (!state.ui) {
      await loadSettings();
      buildUI();
      state.article = articleSegments();
      state.segments = state.article;
      state.index = 0;
      updateUI();
      if (sel && mode !== "page") readSelection(sel, mode === "selection");
      else play();
      return;
    }
    if (mode === "page") { pause(); readArticleFrom(0); return; }
    if (mode === "selection" && sel) { readSelection(sel, true); return; }
    if (freshSel) { readSelection(freshSel, false); return; }
    // Toolbar button with nothing new selected: play/pause.
    if (state.playing) pause(); else play();
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "outloud:start") startReader(msg.mode);
  });

  // Test hook (used by the automated tests; harmless otherwise).
  window.__outloudDebug = { state, startReader, closeReader };
})();
