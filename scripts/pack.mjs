import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
export const PACKAGES = ["core", "web", "react", "interchain"];

export function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: "inherit", ...options });
}

/** Packs each published package with pnpm, which rewrites `workspace:` ranges like `pnpm publish` does. */
export function packAll(destination) {
  const tarballs = {};
  for (const name of PACKAGES) {
    const dir = join(ROOT, "packages", name);
    const { name: fullName, version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    execFileSync("pnpm", ["pack", "--pack-destination", destination], { cwd: dir, stdio: "ignore" });
    tarballs[fullName] = join(destination, `${fullName.replace("@", "").replace("/", "-")}-${version}.tgz`);
  }
  return tarballs;
}
