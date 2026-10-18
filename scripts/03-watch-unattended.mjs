// Stage 3: does a compute that nobody connects to ever wake up on its own?
//
// Watches the main branch's compute through the API for HOURS (default 12)
// and never connects to it. Every change of state, last_active or
// suspended_at is recorded. Run it on a project nothing else uses.
//
//   HOURS=12 node scripts/03-watch-unattended.mjs
import { readFileSync } from "node:fs";
import { api, loadEnv } from "../lib/neon.mjs";
import { openResults } from "../lib/record.mjs";
import { sample, sleep } from "../lib/watch.mjs";

loadEnv();
const { projectId, mainBranchId, mainEndpointId } = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const HOURS = Number(process.env.HOURS ?? 12);
const EVERY_MS = Number(process.env.WATCH_EVERY_MS ?? 15_000);

const out = openResults("03-watch-unattended", { projectId, endpointId: mainEndpointId, hours: HOURS, everyMs: EVERY_MS });
const usage = async (label) => {
  const { branch } = await api("GET", `/projects/${projectId}/branches/${mainBranchId}`);
  out.write({ type: "branch-usage", label, active_time_seconds: branch.active_time_seconds, compute_time_seconds: branch.compute_time_seconds, cpu_used_sec: branch.cpu_used_sec });
};
await usage("start");

const end = Date.now() + HOURS * 3600_000;
let prev = null;
let polls = 0;
let failures = 0;
let lastBeat = Date.now();
while (Date.now() < end) {
  try {
    const s = await sample(projectId, mainEndpointId);
    polls++;
    if (!prev || s.state !== prev.state || s.lastActive !== prev.lastActive || s.suspendedAt !== prev.suspendedAt) {
      out.write({ type: "change", ...s, previous: prev && { state: prev.state, lastActive: prev.lastActive, suspendedAt: prev.suspendedAt } });
      console.log(`${s.at} ${s.state} last_active=${s.lastActive} suspended_at=${s.suspendedAt}`);
    }
    prev = s;
  } catch (e) {
    failures++;
    out.write({ type: "poll-error", error: e.message });
  }
  if (Date.now() - lastBeat > 30 * 60_000) {
    out.write({ type: "heartbeat", polls, failures });
    await usage("heartbeat").catch(() => {});
    lastBeat = Date.now();
  }
  await sleep(EVERY_MS);
}
await usage("end");
out.write({ type: "done", polls, failures });
