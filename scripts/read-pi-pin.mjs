// Reads the authoritative Pi checkout ref from the production lock.
//
// Single source of truth for CI: .github/workflows/ci.yml uses this script's
// output as the actions/checkout ref for blueforst/pi, so the CI Pi checkout
// can never drift from src/contracts/pins/production-lock.json (iris_agent#41).
//
// Usage:
//   node scripts/read-pi-pin.mjs            # prints pi.fork.seamCommit
//   node scripts/read-pi-pin.mjs --tree     # prints pi.fork.seamTree
//   node scripts/read-pi-pin.mjs --pin <path>   # read a specific pin file

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const pinFlag = args.indexOf("--pin");
const pinPath =
  pinFlag >= 0
    ? args[pinFlag + 1]
    : resolve(import.meta.dirname, "..", "src", "contracts", "pins", "production-lock.json");

const pin = JSON.parse(readFileSync(pinPath, "utf8"));

const wantTree = args.includes("--tree");
const value = wantTree ? pin.pi.fork.seamTree : pin.pi.fork.seamCommit;
if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
  console.error(
    `read-pi-pin: invalid ${wantTree ? "seamTree" : "seamCommit"} in production lock: ${value}`,
  );
  process.exit(1);
}
console.log(value);
