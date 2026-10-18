// Recomputes the code stamp of each stage script and compares it with the
// stamps in its results files, so you can tell the results came from the code
// in this repository as it is now.
import { readdirSync, readFileSync } from "node:fs";
import { codeStamp } from "../lib/record.mjs";

const scripts = { "01-idle-clients": "01-idle-clients.mjs", "02-health-checks": "02-health-checks.mjs", "03-watch-unattended": "03-watch-unattended.mjs", "07-database-timeout": "07-database-timeout.mjs" };
const results = new URL("../results/", import.meta.url);
let bad = 0;
for (const f of readdirSync(results).filter((f) => f.endsWith(".jsonl")).sort()) {
  const key = Object.keys(scripts).find((k) => f.startsWith(k));
  if (!key) continue;
  const expected = codeStamp(new URL(`./${scripts[key]}`, import.meta.url).pathname);
  const stamps = [...new Set(readFileSync(new URL(f, results), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).stamp))];
  const ok = stamps.length === 1 && stamps[0] === expected;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "DIFF"} ${f}: ${stamps.join(",")} (code now ${expected})`);
}
process.exit(bad ? 1 : 0);
