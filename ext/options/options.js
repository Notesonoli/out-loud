import { BUY_URL, FREE_PER_DAY, getPro, activate, deactivate, freeLeft } from "../pro.js";

const $ = (id) => document.getElementById(id);
$("buy").href = BUY_URL;
$("perday").textContent = String(FREE_PER_DAY);

async function render() {
  const pro = await getPro();
  $("badge").hidden = !pro.active;
  $("free").hidden = pro.active;
  $("active").hidden = !pro.active;
  $("shown").textContent = pro.key ? `${pro.key.slice(0, 8)}…` : "";
  $("left").textContent = String(await freeLeft());
}

function say(text, kind) {
  $("msg").textContent = text;
  $("msg").className = kind || "";
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("key").value.trim();
  if (!key) return;
  $("activate").disabled = true;
  say("Checking your key…");
  try {
    const r = await activate(key);
    say(r.message, r.ok ? "good" : "bad");
    if (r.ok) $("key").value = "";
  } finally {
    $("activate").disabled = false;
    render();
  }
});

$("remove").addEventListener("click", async () => {
  await deactivate();
  say("Licence key removed from this browser.");
  render();
});

render();
