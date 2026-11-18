// Builds browser-specific packages from ext/ into dist/<browser>/ and dist/*.zip
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const base = JSON.parse(fs.readFileSync("manifest.base.json", "utf8"));

const variants = {
  firefox: {
    ...base,
    background: { scripts: ["background.js"] },
    browser_specific_settings: {
      gecko: {
        id: "outloud@notesonoli",
        strict_min_version: "128.0",
        data_collection_permissions: { required: ["none"] },
      },
    },
  },
  chrome: {
    ...base,
    background: { service_worker: "background.js" },
  },
};

fs.rmSync("dist", { recursive: true, force: true });
for (const [name, manifest] of Object.entries(variants)) {
  const out = path.join("dist", name);
  fs.cpSync("ext", out, { recursive: true });
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const zip = path.resolve("dist", `out-loud-${base.version}-${name}.zip`);
  execSync(`cd ${out} && zip -qr -X ${zip} .`);
  console.log("built", zip);
}
