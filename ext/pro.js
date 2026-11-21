// Out Loud Pro: licence key check (Gumroad) and the free daily allowance of
// natural-voice sentences. Shared by the engine and the settings page.

const api = globalThis.browser ?? globalThis.chrome;

// Chrome's offscreen engine page can't use extension storage directly, so it
// asks the background service worker instead.
const store = api.storage?.local ?? {
  get: (defaults) => api.runtime.sendMessage({ type: "outloud:storage-get", defaults }),
  set: (values) => api.runtime.sendMessage({ type: "outloud:storage-set", values }),
};

// Filled in once the Gumroad product exists.
export const GUMROAD_PRODUCT_ID = "REPLACE_WITH_GUMROAD_PRODUCT_ID";
export const BUY_URL = "https://notesonoli.gumroad.com/l/out-loud-pro";

export const FREE_PER_DAY = 40; // natural-voice sentences per day without Pro
const RECHECK_MS = 14 * 24 * 3600 * 1000; // re-check the key every two weeks

const today = () => new Date().toISOString().slice(0, 10);

export async function getPro() {
  const s = await store.get({ licenseKey: "", proActive: false, proCheckedAt: 0 });
  if (s.proActive && s.licenseKey && Date.now() - s.proCheckedAt > RECHECK_MS) {
    // Quietly re-check in the background. Being offline never removes Pro.
    verifyKey(s.licenseKey).then((r) => {
      if (r.ok) store.set({ proCheckedAt: Date.now() });
      else if (r.definite) store.set({ proActive: false });
    });
  }
  return { active: !!(s.proActive && s.licenseKey), key: s.licenseKey };
}

// -> { ok, definite, message }. definite=false means we couldn't reach Gumroad.
export async function verifyKey(key) {
  const body = new URLSearchParams({
    product_id: GUMROAD_PRODUCT_ID,
    license_key: key.trim(),
    increment_uses_count: "false",
  });
  let res, data;
  try {
    res = await fetch("https://api.gumroad.com/v2/licenses/verify", { method: "POST", body });
    data = await res.json();
  } catch {
    return { ok: false, definite: false, message: "Couldn't reach Gumroad. Check your internet connection and try again." };
  }
  if (!data?.success) {
    return { ok: false, definite: res.status === 404 || data?.success === false, message: "That licence key wasn't recognised. Copy it from your Gumroad receipt and try again." };
  }
  const p = data.purchase || {};
  if (p.refunded || p.chargebacked || p.disputed) {
    return { ok: false, definite: true, message: "This licence key belongs to a refunded purchase." };
  }
  return { ok: true, definite: true, message: "Pro is unlocked. Thank you!" };
}

export async function activate(key) {
  const r = await verifyKey(key);
  if (r.ok) await store.set({ licenseKey: key.trim(), proActive: true, proCheckedAt: Date.now() });
  return r;
}

export async function deactivate() {
  await store.set({ licenseKey: "", proActive: false, proCheckedAt: 0 });
}

export async function freeLeft() {
  const s = await store.get({ freeDay: "", freeUsed: 0 });
  return s.freeDay === today() ? Math.max(0, FREE_PER_DAY - s.freeUsed) : FREE_PER_DAY;
}

export async function useFree() {
  const s = await store.get({ freeDay: "", freeUsed: 0 });
  const used = s.freeDay === today() ? s.freeUsed + 1 : 1;
  await store.set({ freeDay: today(), freeUsed: used });
}
