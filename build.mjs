// Builds browser-specific packages from ext/ into dist/<browser>/ and dist/*.zip
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const base = JSON.parse(fs.readFileSync("manifest.base.json", "utf8"));

const variants = {
  firefox: {
    manifest: {
      ...base,
      // The background page also hosts the natural voice engine.
      background: { page: "background.html" },
      browser_specific_settings: {
        gecko: {
          id: "outloud@notesonoli",
          strict_min_version: "140.0",
          data_collection_permissions: { required: ["none"] },
        },
        gecko_android: {
          strict_min_version: "142.0",
        },
      },
    },
    drop: ["engine/offscreen.html"],
  },
  chrome: {
    manifest: {
      ...base,
      permissions: [...base.permissions, "offscreen"],
      background: { service_worker: "background.js" },
      // Lets the voice engine use several CPU cores.
      cross_origin_embedder_policy: { value: "require-corp" },
      cross_origin_opener_policy: { value: "same-origin" },
    },
    drop: ["background.html"],
  },
};

fs.rmSync("dist", { recursive: true, force: true });
for (const [name, { manifest, drop }] of Object.entries(variants)) {
  const out = path.join("dist", name);
  fs.cpSync("ext", out, { recursive: true });
  for (const f of drop) fs.rmSync(path.join(out, f));
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const zip = path.resolve("dist", `out-loud-${base.version}-${name}.zip`);
  execSync(`cd ${out} && zip -qr -X -9 ${zip} .`);
  console.log("built", zip, (fs.statSync(zip).size / 1e6).toFixed(1) + " MB");
}
