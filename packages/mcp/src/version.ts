import { createRequire } from "node:module";

// dist/*.js and src/*.ts both sit one level under the package root.
const manifest = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

export const PACKAGE_NAME = manifest.name;
export const VERSION = manifest.version;
export const USER_AGENT = `zunia-mcp/${VERSION} (+https://docs.zunialab.com/docs/get-started/ai)`;
