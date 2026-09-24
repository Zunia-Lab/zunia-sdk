// Lints the tarballs `pnpm publish` would upload: package.json fields (publint),
// type resolution (attw) and leftover workspace ranges.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, packAll, run } from "./pack.mjs";

const destination = mkdtempSync(join(tmpdir(), "zunia-pack-"));
let failed = false;
try {
  for (const [name, tarball] of Object.entries(packAll(destination))) {
    console.log(`\n== ${name}`);
    const manifest = execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" });
    if (manifest.includes("workspace:")) {
      console.error(`${name}: the packed package.json still has a workspace: range`);
      failed = true;
    }
    try {
      run("pnpm", ["exec", "publint", "run", tarball, "--strict"], { cwd: ROOT });
      // ESM only: Node 20.19+ and 22.12+ can also require() these packages.
      const styles = name === "@zunialab/sdk-web" ? ["--exclude-entrypoints", "./connect-button.css"] : [];
      run("pnpm", ["exec", "attw", tarball, "--profile", "esm-only", "--no-emoji", ...styles], { cwd: ROOT });
    } catch {
      failed = true;
    }
  }
} finally {
  rmSync(destination, { recursive: true, force: true });
}
if (failed) process.exit(1);
