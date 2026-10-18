// Stage 2: a health check every N seconds. How much of the time is the
// compute awake, and how long does each check wait when it is not?
//
// Each config gets its own branch and compute. A check opens a new pooled
// connection, runs SELECT 1 and closes it, like an uptime monitor calling a
// /health route. The compute's state is polled through the API throughout.
//
//   node scripts/02-health-checks.mjs 60:30:12 300:300:40
//   (suspend timeout seconds : check interval seconds : minutes to run)
import { readFileSync } from "node:fs";
import { api, connectionUri, createBranch, deleteBranch, loadEnv } from "../lib/neon.mjs";
import { openResults } from "../lib/record.mjs";
import { connect, sample, sleep } from "../lib/watch.mjs";

loadEnv();
const { projectId } = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const POLL_MS = Number(process.env.POLL_MS ?? 3000);
const configs = (process.argv.slice(2).length ? process.argv.slice(2) : ["60:30:12", "60:90:15", "60:120:16", "60:180:18", "300:60:30", "300:300:40", "300:600:60"]).map((c) => {
  const [timeout, interval, minutes] = c.split(":").map(Number);
  if (!(timeout >= 60 && interval > 0 && minutes > 0)) throw new Error(`bad config ${c}`);
  return { timeout, interval, minutes };
});

async function runConfig({ timeout, interval, minutes }) {
  const name = `02-health-checks-T${timeout}-I${interval}`;
  const out = openResults(name, { projectId, suspendTimeout: timeout, interval, minutes, cu: 0.25, pollMs: POLL_MS });
  const { branchId, endpointId } = await createBranch(projectId, `hc-t${timeout}-i${interval}-${Date.now().toString(36)}`, { suspendTimeout: timeout, cu: 0.25 });
  out.write({ type: "branch", branchId, endpointId });
  const pooled = await connectionUri(projectId, branchId, true);

  // Let the compute that branch creation started go to sleep first, so every
  // config starts from the same place: suspended.
  for (let s = await sample(projectId, endpointId); s.state === "active"; s = await sample(projectId, endpointId)) await sleep(POLL_MS);

  const startedAt = Date.now();
  const endAt = startedAt + minutes * 60_000;
  let latest = await sample(projectId, endpointId);
  out.write({ type: "poll", ...latest });
  let stop = false;
  const poller = (async () => {
    while (!stop) {
      await sleep(POLL_MS);
      try {
        const s = await sample(projectId, endpointId);
        if (s.state !== latest.state || s.suspendedAt !== latest.suspendedAt) out.write({ type: "poll", ...s });
        latest = s;
      } catch (e) {
        out.write({ type: "poll-error", error: e.message });
      }
    }
  })();

  try {
    for (let k = 0; Date.now() < endAt; k++) {
      const due = startedAt + k * interval * 1000;
      if (due > Date.now()) await sleep(due - Date.now());
      if (Date.now() >= endAt) break;
      const stateBefore = latest.state;
      const t = performance.now();
      let ok = true;
      let error = null;
      try {
        const c = await connect(pooled, { application: "health-check" });
        await c.query("select 1");
        await c.end();
      } catch (e) {
        ok = false;
        error = e.message;
      }
      out.write({ type: "check", k, stateBefore, ms: Math.round(performance.now() - t), ok, error });
    }
    // Run to the end of the window so the last check's awake time is counted.
    if (Date.now() < endAt) await sleep(endAt - Date.now());
  } finally {
    stop = true;
    await poller;
    out.write({ type: "end", startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString() });
    const { branch } = await api("GET", `/projects/${projectId}/branches/${branchId}`).catch(() => ({}));
    if (branch) out.write({ type: "branch-usage", branchId, active_time_seconds: branch.active_time_seconds, compute_time_seconds: branch.compute_time_seconds, cpu_used_sec: branch.cpu_used_sec });
    await deleteBranch(projectId, branchId).then(
      () => out.write({ type: "deleted", branchId }),
      (e) => out.write({ type: "delete-failed", branchId, error: e.message }),
    );
    out.release();
  }
  console.log(`${name}: done`);
}

// Configs run side by side; each has its own compute, so they do not interact.
await Promise.all(configs.map((c, i) => sleep(i * 5000).then(() => runConfig(c))));
