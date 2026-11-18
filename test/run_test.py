"""Drives reader.js in a real Chrome page with the extension API and speech mocked."""
import pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
READER = (ROOT / "ext" / "reader.js").read_text()
PAGE = (ROOT / "test" / "page.html").as_uri()

MOCK = r"""
window.__spoken = [];
window.__store = {};
window.chrome = { runtime: { onMessage: { addListener(f){ window.__send = f; } } },
  storage: { local: { get: async (d) => ({...d, ...window.__store}), set: async (o) => Object.assign(window.__store, o) } } };
const fakeVoices = [{name:'Fake Alice', lang:'en-US', default:true}, {name:'Fake Bob', lang:'en-GB', default:false}];
const synth = { _cur:null, _timer:null, getVoices(){ return fakeVoices; },
  get speaking(){ return !!this._cur; }, pending: false,
  speak(u){ this._cur=u; window.__spoken.push({text:u.text, rate:u.rate, voice:u.voice && u.voice.name});
    this._timer = setTimeout(()=>{ const c=this._cur; this._cur=null; if (!window.__dropEnd) c && c.onend && c.onend({}); }, 40); },
  cancel(){ clearTimeout(this._timer); const c=this._cur; this._cur=null; c && c.onerror && c.onerror({error:'interrupted'}); },
  addEventListener(){}, removeEventListener(){} };
Object.defineProperty(window, 'speechSynthesis', {value: synth});
window.SpeechSynthesisUtterance = function(t){ this.text=t; };
"""

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -> {detail}" if not cond and detail else ""))
    if not cond: failures.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    page = b.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(PAGE)
    page.add_script_tag(content=MOCK)
    page.add_script_tag(content=READER)

    # ---- page mode ----
    page.evaluate("window.__send({type:'outloud:start', mode:'auto'})")
    page.wait_for_timeout(300)
    segs = page.evaluate("window.__outloudDebug.state.segments.map(s=>s.text)")
    print("\n".join(f"  [{i}] {t}" for i, t in enumerate(segs)))
    joined = " | ".join(segs)
    check("title read first", segs and segs[0] == "The Quiet River", segs[:1])
    check("nav skipped", "Subscribe" not in joined)
    check("aside skipped", "Trending" not in joined)
    check("footer skipped", "Copyright" not in joined)
    check("hidden skipped", "Hidden text" not in joined)
    check("inline link/em kept in one sentence", "Fishermen waited on the eastern bank for the first light!" in segs)
    check("abbreviation/decimal not split badly", any(s.startswith("Dr. Smith said") and "2.5 metres since May." in s for s in segs), segs)
    check("list items separate", "First item in the list." in segs and "Second item, which is longer." in segs)
    long_parts = [s for s in segs if "river, the trees" in s or "distant sea" in s or "stone bridge" in s]
    check("long sentence split into chunks <= 260", len(long_parts) >= 2 and all(len(s) <= 260 for s in segs), [len(s) for s in long_parts])
    check("last sentences present", segs[-2:] == ["The end came quickly.", "Then silence."], segs[-2:])

    # ranges cover the right words
    rtexts = page.evaluate("window.__outloudDebug.state.segments.map(s=>s.range.toString().replace(/\\s+/g,' ').trim())")
    check("ranges match spoken text", rtexts == segs, [ (a,b) for a,b in zip(rtexts,segs) if a!=b ][:3])

    # plays through
    page.wait_for_timeout(100 * len(segs) + 500)
    spoken = page.evaluate("window.__spoken.map(s=>s.text)")
    check("all sentences spoken in order", spoken[-len(segs):] == segs, spoken[:5])
    check("default voice used", page.evaluate("window.__spoken[0].voice") == "Fake Alice")
    st = page.evaluate("({playing: window.__outloudDebug.state.playing, idx: window.__outloudDebug.state.index})")
    check("stops at end", not st["playing"] and st["idx"] == len(segs), st)
    check("player shows", page.evaluate("!!document.querySelector('.outloud-host')"))

    # ---- controls ----
    root = "document.querySelector('.outloud-host').shadowRoot"
    page.evaluate(f"{root}.querySelector('.play').click()")
    page.wait_for_timeout(15)
    page.evaluate(f"{root}.querySelector('.play').click()")  # pause right away
    page.wait_for_timeout(200)
    st = page.evaluate("({playing: window.__outloudDebug.state.playing, idx: window.__outloudDebug.state.index})")
    check("pause stops", not st["playing"], st)
    page.evaluate(f"{root}.querySelector('.next').click(); {root}.querySelector('.next').click(); {root}.querySelector('.prev').click()")
    check("next/prev move index", page.evaluate("window.__outloudDebug.state.index") == st["idx"] + 1)
    hl = page.evaluate("CSS.highlights.has('outloud-sentence')")
    check("highlight set", hl)
    # speed + voice persist
    page.evaluate(f"const s={root}.querySelector('.speed'); s.value='2'; s.dispatchEvent(new Event('change'))")
    page.evaluate(f"const v={root}.querySelector('.voice'); v.value='Fake Bob'; v.dispatchEvent(new Event('change'))")
    page.evaluate("window.__spoken.length=0")
    page.evaluate(f"{root}.querySelector('.play').click()")
    page.wait_for_timeout(150)
    first = page.evaluate("window.__spoken[0]")
    check("speed applied", first and first["rate"] == 2, first)
    check("voice applied", first and first["voice"] == "Fake Bob", first)
    check("settings saved", page.evaluate("window.__store") == {"rate": 2, "voiceName": "Fake Bob", "readOnSelect": True}, page.evaluate("window.__store"))
    page.evaluate(f"{root}.querySelector('.play').click()")

    # ---- alt+click jump ----
    box = page.evaluate("(()=>{const r=document.querySelector('#last').getBoundingClientRect(); return {x:r.left+5,y:r.top+r.height/2};})()")
    page.keyboard.down("Alt")
    page.mouse.click(box["x"], box["y"])
    page.keyboard.up("Alt")
    page.wait_for_timeout(100)
    idx = page.evaluate("window.__outloudDebug.state.index")
    check("alt+click jumps to sentence", segs[idx] in ("The end came quickly.", "Then silence."), segs[idx] if idx < len(segs) else idx)
    page.evaluate(f"{root}.querySelector('.close').click()")
    page.wait_for_timeout(100)
    check("close removes player", page.evaluate("!document.querySelector('.outloud-host')"))
    check("close clears highlight", not page.evaluate("CSS.highlights.has('outloud-sentence')"))

    # ---- right-click "Read selection aloud": reads just that, then back to the article ----
    S = "window.__outloudDebug.state"
    def select_text(js_range):
        page.evaluate(f"(()=>{{const r=document.createRange(); {js_range}; const s=getSelection(); s.removeAllRanges(); s.addRange(r);}})()")
    select_text("const p=document.querySelectorAll('article p')[1]; r.setStart(p.firstChild,0); r.setEnd(p.lastChild,p.lastChild.length)")
    page.evaluate("window.__spoken.length=0; window.__send({type:'outloud:start', mode:'selection'})")
    page.wait_for_timeout(500)
    segs2 = page.evaluate("window.__spoken.map(s=>s.text)")
    check("right-click selection reads only selection", segs2 == ["Dr. Smith said the water level had risen by 2.5 metres since May.", "Nobody expected it."], segs2)
    st = page.evaluate(f"({{back: {S}.segments === {S}.article, playing: {S}.playing, sel: {S}.inSelection}})")
    check("after selection: back to the article, paused", st == {"back": True, "playing": False, "sel": False}, st)

    # ---- toolbar with a selection inside the article: jump there and keep reading ----
    select_text("const t=document.querySelector('#last').firstChild; r.setStart(t,4); r.setEnd(t,21)")
    page.evaluate("window.__spoken.length=0; window.__send({type:'outloud:start', mode:'auto'})")
    page.wait_for_timeout(500)
    spoken = page.evaluate("window.__spoken.map(s=>s.text)")
    check("selection in article jumps there and continues", spoken[:2] == ["The end came quickly.", "Then silence."], spoken)
    check("still on the whole article", page.evaluate(f"{S}.segments === {S}.article"))

    # ---- read on select (reader open) ----
    def drag_select(sel_id):
        r = page.evaluate(f"(()=>{{const r=document.querySelector('{sel_id}').getBoundingClientRect(); return {{x:r.left+2,y:r.top+8,w:r.width}};}})()")
        page.mouse.move(r["x"], r["y"]); page.mouse.down()
        page.mouse.move(r["x"] + min(300, r["w"] - 4), r["y"], steps=5); page.mouse.up()
    page.evaluate("window.__spoken.length=0")
    drag_select('#long')
    page.wait_for_timeout(450)
    spoken = page.evaluate("window.__spoken.map(s=>s.text)")
    check("selecting jumps to that sentence", spoken and spoken[0].startswith("This is an extremely long"), spoken[:2])
    page.wait_for_timeout(400)
    spoken = page.evaluate("window.__spoken.map(s=>s.text)")
    check("...and keeps reading the article after it", "The end came quickly." in spoken, spoken)
    check("selection kept for copying", page.evaluate("getSelection().toString().length > 0"))
    # select something earlier: goes back up the article
    page.evaluate("window.__spoken.length=0")
    drag_select('article li')
    page.wait_for_timeout(450)
    spoken = page.evaluate("window.__spoken.map(s=>s.text)")
    check("selecting earlier text jumps back", spoken[:1] == ["First item in the list."], spoken[:2])
    page.evaluate(f"{root}.querySelector('.play').click()")  # pause
    # text outside the article (sidebar): read it, then return to where we were
    pos = page.evaluate(f"{S}.index")
    page.evaluate("window.__spoken.length=0")
    drag_select('aside')
    page.wait_for_timeout(300)
    spoken = page.evaluate("window.__spoken.map(s=>s.text)")
    check("selection outside article is read", spoken and spoken[0].startswith("Trending"), spoken[:2])
    page.wait_for_timeout(500)
    st = page.evaluate(f"({{back: {S}.segments === {S}.article, idx: {S}.index, playing: {S}.playing}})")
    check("...then returns to the article position", st == {"back": True, "idx": pos, "playing": False}, (st, pos))
    page.evaluate("window.__spoken.length=0")
    page.evaluate(f"{root}.querySelector('.play').click()")
    page.wait_for_timeout(120)
    spoken = page.evaluate("window.__spoken.map(s=>s.text)")
    check("play resumes the article, not the old selection", spoken[:1] == [page.evaluate(f"{S}.article[{pos}].text")], spoken[:1])
    page.evaluate(f"{root}.querySelector('.play').click()")
    # click to deselect doesn't start reading
    page.evaluate("window.__spoken.length=0")
    page.mouse.move(5, 5); page.mouse.down(); page.mouse.up()
    page.wait_for_timeout(400)
    check("click to deselect doesn't start reading", page.evaluate("window.__spoken.length") == 0)
    # toggle off
    page.evaluate(f"{root}.querySelector('.select').click()")
    check("toggle shows off", page.evaluate(f"{root}.querySelector('.select').getAttribute('aria-pressed')") == "false")
    drag_select('#last')
    page.wait_for_timeout(500)
    check("toggle off: selecting doesn't read", page.evaluate("window.__spoken.length") == 0)
    check("toggle saved", page.evaluate("window.__store.readOnSelect") is False)

    # ---- BBC-style page: each paragraph wrapped in its own boxes ----
    page.goto((ROOT / "test" / "bbc-like.html").as_uri())
    page.add_script_tag(content=MOCK)
    page.add_script_tag(content=READER)
    page.evaluate("window.__send({type:'outloud:start', mode:'page'})")
    page.wait_for_timeout(200)
    bb = page.evaluate("window.__outloudDebug.state.article.map(s=>s.text)")
    check("bbc-like: starts with headline", bb[:1] == ["Big river floods town after week of rain"], bb[:3])
    check("bbc-like: reads all 20 paragraphs in order", [t for t in bb if t.startswith("Paragraph number")] == [f"Paragraph number {i} of the story has enough words in it to count as real article text for testing." for i in range(1, 21)], len(bb))
    check("bbc-like: skips top stories and footer", not any("Top story" in t or "Copyright" in t for t in bb), [t for t in bb if "Top" in t])

    # ---- browser forgets to report the end of sentences: watchdog keeps going ----
    page.evaluate("window.__outloudDebug.closeReader(); window.__dropEnd = true; window.__spoken.length=0")
    page.evaluate("window.__send({type:'outloud:start', mode:'page'})")
    page.wait_for_timeout(7000)
    n = page.evaluate("window.__spoken.length")
    check("watchdog: keeps reading when end events go missing", n >= 3, n)
    page.evaluate("window.__dropEnd = false; window.__outloudDebug.closeReader()")

    check("no page errors", not errors, errors)
    b.close()

print("\nRESULT:", "ALL PASSED" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
