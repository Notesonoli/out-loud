"""Natural-voice flow in reader.js, with the engine port mocked."""
import pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
READER = (ROOT / "ext" / "reader.js").read_text()
PAGE = (ROOT / "test" / "page.html").as_uri()

MOCK = r"""
window.__spoken = []; window.__store = { voiceName: 'kokoro:af_heart' }; window.__engine = []; window.__sent = [];
window.__engineMode = 'ok';
function makePort() {
  const msgL = [], discL = [];
  const port = {
    onMessage: { addListener(f){ msgL.push(f); } },
    onDisconnect: { addListener(f){ discL.push(f); } },
    postMessage(m) {
      window.__engine.push(m);
      if (m.type !== 'speak') return;
      const reply = (r) => setTimeout(() => msgL.forEach(f => f(r)), 30);
      if (window.__engineMode === 'limit') return reply({ type: 'limit', id: m.id });
      if (window.__engineMode === 'error') return reply({ type: 'error', id: m.id, message: 'offline' });
      reply({ type: 'loading', pct: 50 });
      reply({ type: 'started', id: m.id, slow: false, left: window.__left ?? null });
      if (window.__engineMode !== 'hold' && (window.__autoEnd === undefined || window.__autoEnd-- > 0)) setTimeout(() => msgL.forEach(f => f({ type: 'ended', id: m.id })), 60);
    },
    disconnect() {}, _kill() { discL.forEach(f => f()); },
  };
  window.__port = port; return port;
}
window.chrome = {
  runtime: { onMessage: { addListener(f){ window.__send = f; } },
    sendMessage: async (m) => { window.__sent.push(m); return { ok: true }; },
    connect: (o) => { window.__connects = (window.__connects||0) + 1; return makePort(); } },
  storage: { local: { get: async (d) => ({...d, ...window.__store}), set: async (o) => Object.assign(window.__store, o) } } };
const fakeVoices = [{name:'Fake Alice', lang:'en-US', default:true}, {name:'Fake Bob', lang:'en-GB', default:false}];
const synth = { _cur:null, _timer:null, getVoices(){ return fakeVoices; },
  get speaking(){ return !!this._cur; }, pending: false,
  speak(u){ this._cur=u; window.__spoken.push({text:u.text, voice:u.voice && u.voice.name});
    this._timer = setTimeout(()=>{ const c=this._cur; this._cur=null; c && c.onend && c.onend({}); }, 40); },
  cancel(){ clearTimeout(this._timer); const c=this._cur; this._cur=null; c && c.onerror && c.onerror({error:'interrupted'}); },
  addEventListener(){}, removeEventListener(){} };
Object.defineProperty(window, 'speechSynthesis', {value: synth});
window.SpeechSynthesisUtterance = function(t){ this.text=t; };
"""

failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -> {detail}" if not cond and detail else ""))
    if not cond: failures.append(name)

def fresh(b, mode="ok", left=None):
    page = b.new_page(); errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(PAGE)
    page.add_script_tag(content=MOCK)
    page.evaluate(f"window.__engineMode = '{mode}'; window.__left = {json(left)}")
    page.add_script_tag(content=READER)
    return page, errs

def json(v): return "null" if v is None else str(v)
def shadow(page, sel): return page.evaluate(f"document.querySelector('.outloud-host').shadowRoot.querySelector('{sel}')?.{ 'textContent' }")
def hidden(page, sel): return page.evaluate(f"document.querySelector('.outloud-host').shadowRoot.querySelector('{sel}').hidden")

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])

    page, errs = fresh(b)
    page.evaluate("window.__autoEnd = 3")
    page.evaluate("window.__send({type:'outloud:start', mode:'auto'})")
    page.wait_for_timeout(700)
    eng = page.evaluate("window.__engine")
    speaks = [m for m in eng if m["type"] == "speak"]
    segs = page.evaluate("window.__outloudDebug.state.article.map(s=>s.text)")
    check("natural voice goes to the engine, not system speech", speaks and not page.evaluate("window.__spoken.length"), (len(speaks), page.evaluate("window.__spoken")))
    check("engine asked to start first (Chrome offscreen)", page.evaluate("window.__sent[0] && window.__sent[0].type") == "outloud:engine")
    check("speak carries voice id and rate", speaks and speaks[0]["voice"] == "af_heart" and speaks[0]["rate"] == 1, speaks[:1])
    check("first sentence is the title", speaks and speaks[0]["text"] == segs[0])
    check("next two sentences sent for prefetch", speaks and speaks[0]["ahead"] == segs[1:3], speaks[:1])
    check("ended advances to next sentence", len(speaks) >= 3 and [s["text"] for s in speaks[:3]] == segs[:3], [s["text"] for s in speaks[:3]])
    check("one connection reused", page.evaluate("window.__connects") == 1)
    opts = page.evaluate("[...document.querySelector('.outloud-host').shadowRoot.querySelectorAll('.voice optgroup')].map(g=>g.label+':'+g.children.length)")
    check("voice menu has natural and system groups", opts == ["✨ Natural voices:9", "Your computer's voices:2"], opts)
    check("menu shows chosen natural voice", page.evaluate("document.querySelector('.outloud-host').shadowRoot.querySelector('.voice').value") == "kokoro:af_heart")
    check("loading notice cleared once speech starts", hidden(page, ".notice"))
    # pause sends stop
    page.evaluate("document.querySelector('.outloud-host').shadowRoot.querySelector('.play').click()")
    page.wait_for_timeout(100)
    eng = page.evaluate("window.__engine")
    check("pause sends stop to engine", eng[-1]["type"] == "stop", eng[-2:])
    idx = page.evaluate("window.__outloudDebug.state.index")
    page.wait_for_timeout(300)
    check("paused stays paused", page.evaluate("window.__outloudDebug.state.index") == idx and not page.evaluate("window.__outloudDebug.state.playing"))
    # resume and the engine page goes away -> reconnect, same sentence
    page.evaluate("document.querySelector('.outloud-host').shadowRoot.querySelector('.play').click()")
    page.wait_for_timeout(150)
    page.evaluate("window.__port._kill()")
    page.wait_for_timeout(300)
    eng = page.evaluate("window.__engine"); sp = [m for m in eng if m["type"]=="speak"]
    check("reconnects after engine closes, same sentence", page.evaluate("window.__connects") == 2 and sp[-1]["text"] == sp[-2]["text"], (page.evaluate("window.__connects"), [s['text'] for s in sp[-2:]]))
    # switching to system voice stops engine and uses speechSynthesis
    page.evaluate("""(()=>{const s=document.querySelector('.outloud-host').shadowRoot.querySelector('.voice'); s.value='Fake Bob'; s.dispatchEvent(new Event('change'));})()""")
    page.wait_for_timeout(300)
    check("switch to system voice uses speech synthesis", page.evaluate("window.__spoken.length") > 0 and page.evaluate("window.__spoken[0].voice") == "Fake Bob")
    check("system voice choice saved", page.evaluate("window.__store.voiceName") == "Fake Bob")
    page.evaluate("window.__outloudDebug.closeReader()")
    check("no page errors (main)", not errs, errs)
    page.close()

    # free allowance used up -> falls back to system voice, offers Pro
    page, errs = fresh(b, "limit")
    page.evaluate("window.__send({type:'outloud:start', mode:'auto'})")
    page.wait_for_timeout(500)
    check("limit: falls back to system voice and keeps reading", page.evaluate("window.__spoken.length") > 0)
    check("limit: notice shown with Get Pro", not hidden(page, ".notice") and shadow(page, ".notice-action") == "Get Pro" and "free" in shadow(page, ".notice-text"), shadow(page, ".notice-text"))
    check("limit: natural choice still saved for tomorrow", page.evaluate("window.__store.voiceName") == "kokoro:af_heart")
    page.evaluate("document.querySelector('.outloud-host').shadowRoot.querySelector('.notice-action').click()")
    page.wait_for_timeout(50)
    check("Get Pro opens settings", any(m["type"] == "outloud:options" for m in page.evaluate("window.__sent")))
    page.evaluate("document.querySelector('.outloud-host').shadowRoot.querySelector('.notice-close').click()")
    check("notice can be dismissed", hidden(page, ".notice"))
    check("no page errors (limit)", not errs, errs)
    page.close()

    # engine error -> fall back
    page, errs = fresh(b, "error")
    page.evaluate("window.__send({type:'outloud:start', mode:'auto'})")
    page.wait_for_timeout(500)
    check("error: falls back to system voice", page.evaluate("window.__spoken.length") > 0)
    check("error: explains", "couldn't start" in (shadow(page, ".notice-text") or ""), shadow(page, ".notice-text"))
    page.close()

    # few left -> warning
    page, errs = fresh(b, "hold", left=3)
    page.evaluate("window.__send({type:'outloud:start', mode:'auto'})")
    page.wait_for_timeout(300)
    check("low allowance warning", "3 free natural sentences left" in (shadow(page, ".notice-text") or ""), shadow(page, ".notice-text"))
    page.close()
    b.close()

print("\nRESULT:", "ALL PASSED" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
