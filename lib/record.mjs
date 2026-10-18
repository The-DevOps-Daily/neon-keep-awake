// Results are JSON lines. Every file starts with a stamp (a hash of the code
// that wrote it), and only one process may write a file at a time, so a stray
// runner from an earlier session cannot mix its lines into a new run.
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// The hash covers lib/, the script that is running and the lockfile.
export function codeStamp(script = process.argv[1]) {
  const h = createHash("sha256");
  for (const f of readdirSync(join(ROOT, "lib")).sort()) h.update(f).update(readFileSync(join(ROOT, "lib", f)));
  h.update(readFileSync(script));
  h.update(readFileSync(join(ROOT, "package-lock.json")));
  return h.digest("hex").slice(0, 12);
}

export function openResults(name, meta) {
  const file = join(ROOT, "results", `${name}.jsonl`);
  const lock = `${file}.lock`;
  let fd;
  try {
    fd = openSync(lock, "wx");
  } catch {
    throw new Error(`${lock} exists: another run is writing ${name}.jsonl`);
  }
  closeSync(fd);
  const release = () => existsSync(lock) && unlinkSync(lock);
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
  const stamp = codeStamp();
  if (!existsSync(file)) writeFileSync(file, "");
  const write = (event) => appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), stamp, ...event }) + "\n");
  write({ type: "start", ...meta });
  return { write, stamp, file, release };
}

// Reads a results file and refuses lines from a different version of the code.
export function readResults(name, { stamp } = {}) {
  const file = join(ROOT, "results", `${name}.jsonl`);
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const stamps = new Set(lines.map((l) => l.stamp));
  if (stamps.has(undefined)) throw new Error(`${name}.jsonl has unstamped lines`);
  if (stamp && !stamps.has(stamp)) throw new Error(`${name}.jsonl has no lines from stamp ${stamp}`);
  return lines;
}
