"""End to end: the real Chrome build, real model download, real audio playback.
Uses a test copy of the build with host access so the test can start the reader
without clicking the toolbar."""
import json, pathlib, shutil, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "dist" / "chrome"
EXT = pathlib.Path("/tmp/outloud-e2e-ext")
PROFILE = pathlib.Path("/tmp/outloud-e2e-profile")  # fresh each run: a real first install
shutil.rmtree(PROFILE, ignore_errors=True)
shutil.rmtree(EXT, ignore_errors=True); shutil.copytree(SRC, EXT)
m = json.loads((EXT / "manifest.json").read_text()); m["host_permissions"] = ["http://localhost/*"]
(EXT / "manifest.json").write_text(json.dumps(m))

srv = subprocess.Popen([sys.executable, "-m", "http.server", "8771", "-d", str(ROOT / "test")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
failures = []
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  -> {detail}" if not cond and detail else ""), flush=True)
    if not cond: failures.append(name)

START = """async ({mode}) => {
  const [tab] = await chrome.tabs.query({ url: 'http://localhost:8771/*' });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['reader.js'] });
  await chrome.tabs.sendMessage(tab.id, { type: 'outloud:start', mode });
}"""
UI = "(s) => document.querySelector('.outloud-host')?.shadowRoot.querySelector(s)?.textContent"

try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(str(PROFILE), headless=False,
            args=["--headless=new", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--no-sandbox"])
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        ext_id = sw.url.split("/")[2]
        sw.evaluate("() => chrome.storage.local.set({ voiceName: 'kokoro:af_heart', freeDay: '', freeUsed: 0, proActive: false, licenseKey: '' })")
        page = ctx.new_page(); errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto("http://localhost:8771/page.html")
        t0 = time.time()
        sw.evaluate(START, {"mode": "auto"})
        notices = set(); first = None
        while time.time() - t0 < 400:
            n = page.evaluate(UI, ".notice-text") or ""
            if n: notices.add(n.split("…")[0])
            c = page.evaluate(UI, ".count")
            if c and c.startswith("2 /"): first = time.time() - t0; break
            page.wait_for_timeout(250)
        print(f"  first sentence spoken and finished after {first and round(first,1)} s; notices seen: {notices}")
        check("natural voice plays the first sentence through to the end", first is not None and not any("couldn't start" in n for n in notices), notices)
        check("download progress was shown", any("Getting the natural voice ready" in n for n in notices) or first is not None and first < 10)
        # let a few more sentences play to check prefetch keeps up
        t1 = time.time()
        page.wait_for_function("() => document.querySelector('.outloud-host').shadowRoot.querySelector('.count').textContent.startsWith('4 /')", timeout=120000)
        print(f"  sentences 2-3 took {round(time.time()-t1,1)} s")
        used = sw.evaluate("() => chrome.storage.local.get(['freeUsed']).then(s => s.freeUsed)")
        check("free allowance counted per sentence", used >= 3, used)
        # pause really stops
        page.evaluate("() => document.querySelector('.outloud-host').shadowRoot.querySelector('.play').click()")
        c1 = page.evaluate(UI, ".count"); page.wait_for_timeout(6000)
        check("pause stops the natural voice", page.evaluate(UI, ".count") == c1, (c1, page.evaluate(UI, ".count")))
        # allowance used up -> system voice + notice
        sw.evaluate("() => chrome.storage.local.set({ freeUsed: 999 })")
        page.evaluate("() => document.querySelector('.outloud-host').shadowRoot.querySelector('.play').click()")
        page.wait_for_timeout(1500)
        check("used-up allowance switches to the computer's voice with a Pro offer", "free natural-voice sentences" in (page.evaluate(UI, ".notice-text") or ""), page.evaluate(UI, ".notice-text"))
        check("no page errors", not errs, errs)
        # settings page: a wrong licence key is rejected by Gumroad (real request)
        opt = ctx.new_page(); opt.goto(f"chrome-extension://{ext_id}/options/options.html")
        check("settings shows the free allowance", opt.text_content("#left") == "0", opt.text_content("#left"))
        opt.fill("#key", "AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD"); opt.click("#activate")
        opt.wait_for_function("() => document.getElementById('msg').textContent && !document.getElementById('msg').textContent.startsWith('Checking')", timeout=30000)
        msg = opt.text_content("#msg"); print("  gumroad said:", msg)
        check("bad licence key is rejected", "wasn't recognised" in msg and not opt.is_visible("#active"), msg)
        # a good key (Gumroad answer faked) unlocks Pro
        opt.route("https://api.gumroad.com/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps({"success": True, "purchase": {"refunded": False, "chargebacked": False}})))
        ctx.route("https://api.gumroad.com/**", lambda r: r.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps({"success": True, "purchase": {"refunded": False, "chargebacked": False}})))
        opt.fill("#key", "GOODGOOD-11111111-22222222-33333333"); opt.click("#activate")
        try:
            opt.wait_for_selector("#active", state="visible", timeout=15000)
            check("valid licence key unlocks Pro", True)
        except Exception:
            check("valid licence key unlocks Pro", False, opt.text_content("#msg"))
        opt.screenshot(path=str(ROOT / "test" / "options-pro.png"))
        pro = sw.evaluate("() => chrome.storage.local.get(['proActive']).then(s => s.proActive)")
        check("Pro saved", pro is True)
        # with Pro, natural voice works again even though allowance is used up
        page.reload(); sw.evaluate("() => chrome.storage.local.set({ voiceName: 'kokoro:bm_george' })")
        sw.evaluate(START, {"mode": "auto"})
        try:
            page.wait_for_function("() => document.querySelector('.outloud-host')?.shadowRoot.querySelector('.count').textContent.startsWith('2 /')", timeout=120000)
            check("Pro: natural voice with no daily limit", "free" not in (page.evaluate(UI, ".notice-text") or ""))
        except Exception:
            check("Pro: natural voice with no daily limit", False, page.evaluate(UI, ".notice-text"))
        page.screenshot(path=str(ROOT / "test" / "reader-natural.png"))
        ctx.close()
finally:
    srv.terminate()
print("\nRESULT:", "ALL PASSED" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
