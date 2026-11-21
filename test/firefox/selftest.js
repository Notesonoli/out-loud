
const report = (o) => fetch('http://localhost:8773/report', { method: 'POST', body: JSON.stringify(o) }).catch(() => {});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const out = {};
  try {
    await browser.storage.local.set({ voiceName: 'kokoro:bm_george', freeDay: '', freeUsed: 0 });
    const tab = await browser.tabs.create({ url: 'http://localhost:8774/page.html' });
    await sleep(3000);
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['reader.js'] });
    await browser.tabs.sendMessage(tab.id, { type: 'outloud:start', mode: 'auto' });
    const t0 = Date.now(); const seen = [];
    while (Date.now() - t0 < 300000) {
      const rs = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        const sr = document.querySelector('.outloud-host')?.shadowRoot;
        return { count: sr?.querySelector('.count')?.textContent, notice: sr?.querySelector('.notice-text')?.textContent };
      } }).catch((e) => [{ error: e.message }]);
      const r = rs[0];
      const v = (r && r.result) || { count: 'no-result', err: String(r && r.error) }; const key = v.count + ' | ' + v.notice;
      if (!seen.includes(key)) { seen.push(key); await report({ step: 'ui', at: Math.round((Date.now() - t0) / 1000), ...v }); }
      if (v.count && v.count.startsWith('4 /')) break;
      await sleep(500);
    }
    out.freeUsed = (await browser.storage.local.get('freeUsed')).freeUsed;
    out.ok = true;
  } catch (e) { out.error = String(e && (e.stack || e.message || e)); }
  await report({ step: 'done', ...out });
})();
