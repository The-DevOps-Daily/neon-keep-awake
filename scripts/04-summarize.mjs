// Stage 4: turn the results files into results/summary.json and summary.md.
// Only reads files; it never calls Neon. Each results file must come from one
// version of the code (one stamp), or this script stops.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readResults } from "../lib/record.mjs";

const CU = 0.25;
const ms = (a, b) => new Date(b) - new Date(a);
const sec = (a, b) => Math.round(ms(a, b) / 1000);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
function oneStamp(name, lines) {
  const stamps = [...new Set(lines.map((l) => l.stamp))];
  if (stamps.length !== 1) throw new Error(`${name}: lines from ${stamps.length} code versions (${stamps.join(", ")}); keep one run per file`);
  return stamps[0];
}
const results = new URL("../results/", import.meta.url);
const summary = { cu: CU, stamps: {} };
const md = [];

// Neon's own record of each compute's starts and suspends (scripts/05-operations.mjs),
// used to check the awake time we measured by polling.
const opsFile = readdirSync(results).find((f) => /^operations-.+\.json$/.test(f));
const operations = opsFile ? JSON.parse(readFileSync(new URL(opsFile, results), "utf8")).operations : null;
function awakeFromOperations(endpointId, from, to) {
  if (!operations) return null;
  // Neon's timestamps have no fractions and ours do, so work in milliseconds.
  const [f, t] = [Date.parse(from), Date.parse(to)];
  const ops = operations
    .filter((o) => o.endpoint === endpointId && (o.action === "start_compute" || o.action === "suspend_compute"))
    .map((o) => ({ action: o.action, at: Date.parse(o.created) }))
    .sort((a, b) => a.at - b.at);
  let since = null;
  let total = 0;
  for (const o of ops) {
    if (o.action === "start_compute") since ??= o.at;
    else if (since !== null) {
      const b = Math.min(o.at, t) - Math.max(since, f);
      if (b > 0) total += b;
      since = null;
    }
  }
  if (since !== null && t > since) total += t - Math.max(since, f);
  return Math.round(total / 1000);
}

// Stage 1: idle clients.
if (existsSync(new URL("01-idle-clients.jsonl", results))) {
  const lines = readResults("01-idle-clients");
  summary.stamps["01-idle-clients"] = oneStamp("01", lines);
  const timeout = lines.find((l) => l.type === "start").suspendTimeout;
  const runs = lines.filter((l) => l.type === "run");
  const byScenario = {};
  for (const r of runs) (byScenario[r.scenario] ??= []).push(r);
  summary.idleClients = { suspendTimeout: timeout, scenarios: {} };
  md.push(`## Idle clients (suspend timeout ${timeout} s, ${CU} CU)\n`);
  // The API's last_active is only refreshed every few minutes, so the table
  // times the suspend from our own last query instead (both are in the JSON).
  md.push("| Scenario | Runs | Suspended | Last query to suspend (s) | Held connection after the suspend |");
  md.push("|---|---|---|---|---|");
  for (const [name, rs] of Object.entries(byScenario)) {
    const susp = rs.filter((r) => r.suspended);
    const toSuspend = susp.map((r) => sec(r.lastQueryAt, r.suspendedAt));
    const apiGap = susp.filter((r) => r.lastActiveApi).map((r) => sec(r.lastActiveApi, r.suspendedAt));
    const held = susp.flatMap((r) => r.heldAfterSuspend ?? []).map((h) => (h.query.ok ? `ok (${h.query.ms} ms)` : `error: ${h.query.error}`));
    const stayed = rs.filter((r) => !r.suspended);
    const afterRelease = stayed.filter((r) => r.afterRelease?.suspended).map((r) => sec(r.afterRelease.releasedAt, r.afterRelease.suspendedAt));
    summary.idleClients.scenarios[name] = {
      runs: rs.length,
      suspended: susp.length,
      lastQueryToSuspendSeconds: toSuspend,
      lastActiveToSuspendSeconds: apiGap,
      stayedActiveForSeconds: stayed.map((r) => r.window),
      lastActiveUpdatesWhileStaying: stayed.map((r) => r.lastActiveValues.length),
      afterReleaseToSuspendSeconds: afterRelease,
      heldAfterSuspend: susp.flatMap((r) => r.heldAfterSuspend ?? []),
      afterSuspend: susp.map((r) => r.afterSuspend).filter(Boolean),
      wakeMs: rs.map((r) => r.wakeMs),
    };
    const suspCell = stayed.length ? `${susp.length} of ${rs.length} (others awake for the whole ${stayed[0].window} s)` : `${susp.length} of ${rs.length}`;
    const releaseCell = afterRelease.length ? `; after the client let go: suspended ${afterRelease.join(", ")} s later` : "";
    md.push(`| ${name} | ${rs.length} | ${suspCell}${releaseCell} | ${toSuspend.join(", ") || "-"} | ${[...new Set(held)].join("; ") || "-"} |`);
  }
  const usage = lines.find((l) => l.type === "branch-usage");
  if (usage) summary.idleClients.branchUsage = usage;
  md.push("");
}

// Stage 2: health checks.
const hcFiles = readdirSync(results).filter((f) => /^02-health-checks-T\d+-I\d+\.jsonl$/.test(f)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
if (hcFiles.length) {
  summary.healthChecks = [];
  md.push(`## Health checks (new pooled connection + SELECT 1, ${CU} CU)\n`);
  md.push("| Suspend timeout | Check every | Minutes | Checks | Checks that woke it | Awake per wake (s) | Wake check median / max (ms) | Warm check median (ms) | Awake (polled) | Awake (Neon operations log) | CU-hours per 30 days |");
  md.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const f of hcFiles) {
    const name = f.replace(/\.jsonl$/, "");
    const lines = readResults(name);
    summary.stamps[name] = oneStamp(name, lines);
    const start = lines.find((l) => l.type === "start");
    const end = lines.find((l) => l.type === "end");
    if (!end) continue; // still running
    const checks = lines.filter((l) => l.type === "check");
    const polls = lines.filter((l) => l.type === "poll");
    // Awake intervals: a check that found the compute asleep starts one (it
    // woke it); a poll that sees it suspended ends one at Neon's suspended_at.
    const events = [
      ...checks.map((c) => ({ at: new Date(new Date(c.t) - c.ms).toISOString(), kind: "check", woke: c.stateBefore !== "active" })),
      ...polls.map((p) => ({ at: p.at, kind: "poll", state: p.state, suspendedAt: p.suspendedAt })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    let awakeSince = null;
    let awake = 0;
    const completed = []; // seconds awake for each wake that ended in a suspend inside the window
    const startedAt = end.startedAt;
    const endedAt = end.endedAt;
    for (const ev of events) {
      if (ev.at < startedAt) {
        if (ev.kind === "poll" && ev.state === "active") awakeSince = startedAt;
        continue;
      }
      if (awakeSince === null && ((ev.kind === "check" && ev.woke) || (ev.kind === "poll" && ev.state === "active"))) awakeSince = ev.at;
      else if (awakeSince !== null && ev.kind === "poll" && ev.state !== "active") {
        // A poll still showing the suspend from before this wake is stale.
        // (Neon's timestamps have no fractions, so compare as dates, not strings.)
        if (ev.suspendedAt && new Date(ev.suspendedAt) <= new Date(awakeSince)) continue;
        const until = ev.suspendedAt ?? ev.at;
        awake += ms(awakeSince, until);
        if (awakeSince > startedAt) completed.push(Math.round(ms(awakeSince, until) / 1000));
        awakeSince = null;
      }
    }
    if (awakeSince !== null) awake += ms(awakeSince, endedAt);
    const window = ms(startedAt, endedAt);
    const woke = checks.filter((c) => c.stateBefore !== "active");
    const warm = checks.filter((c) => c.stateBefore === "active");
    const fraction = awake / window;
    const row = {
      suspendTimeout: start.suspendTimeout,
      interval: start.interval,
      minutes: Math.round(window / 60000),
      checks: checks.length,
      failedChecks: checks.filter((c) => !c.ok).length,
      wakeChecks: woke.length,
      wakeMsMedian: median(woke.map((c) => c.ms)),
      wakeMsMax: woke.length ? Math.max(...woke.map((c) => c.ms)) : null,
      warmMsMedian: median(warm.map((c) => c.ms)),
      awakeSeconds: Math.round(awake / 1000),
      // From a wake to its suspend, for wakes that ended inside the window.
      awakeSecondsPerWake: completed.length ? median(completed) : null,
      awakeSecondsPerWakeAll: completed,
      awakeFraction: Number(fraction.toFixed(3)),
      cuHoursPer30Days: Number((fraction * 24 * 30 * CU).toFixed(1)),
      awakeSecondsFromOperations: awakeFromOperations(lines.find((l) => l.type === "branch").endpointId, startedAt, endedAt),
      branchUsage: lines.find((l) => l.type === "branch-usage") ?? null,
    };
    summary.healthChecks.push(row);
    md.push(`| ${row.suspendTimeout} s | ${row.interval} s | ${row.minutes} | ${row.checks} | ${row.wakeChecks} | ${row.awakeSecondsPerWake ?? "-"} | ${row.wakeMsMedian ?? "-"} / ${row.wakeMsMax ?? "-"} | ${row.warmMsMedian ?? "-"} | ${(row.awakeFraction * 100).toFixed(1)}% | ${row.awakeSecondsFromOperations === null ? "-" : `${Math.min(100, (row.awakeSecondsFromOperations * 1000 * 100) / window).toFixed(1)}%`} | ${row.cuHoursPer30Days} |`);
  }
  md.push("");
}

// Stage 3: unattended compute.
if (existsSync(new URL("03-watch-unattended.jsonl", results))) {
  const lines = readResults("03-watch-unattended");
  summary.stamps["03-watch-unattended"] = oneStamp("03", lines);
  const start = lines.find((l) => l.type === "start");
  const changes = lines.filter((l) => l.type === "change");
  const done = lines.find((l) => l.type === "done");
  const lastAt = done?.t ?? lines.at(-1).t;
  // Wakes after the first suspend: nothing of ours connected, so each one was
  // started by something else.
  const firstSuspend = changes.find((c) => c.state !== "active");
  const wakes = [];
  let since = null;
  for (const c of changes) {
    if (!firstSuspend || c.t <= firstSuspend.t) continue;
    if (c.state === "active" && c.previous?.state !== "active") since = c;
    if (c.state !== "active" && since) {
      wakes.push({ seenAt: since.at, lastActive: since.lastActive, suspendedAt: c.suspendedAt, awakeSecondsApprox: sec(since.at, c.suspendedAt ?? c.at) });
      since = null;
    }
  }
  const hours = firstSuspend ? ms(firstSuspend.t, lastAt) / 3600_000 : 0;
  const awake = wakes.reduce((s, w) => s + w.awakeSecondsApprox, 0);
  summary.unattended = {
    hoursWatched: Number(hours.toFixed(2)),
    everyMs: start.everyMs,
    wakes,
    awakeSeconds: awake,
    finished: Boolean(done),
    usage: lines.filter((l) => l.type === "branch-usage"),
    pollFailures: done?.failures ?? null,
  };
  md.push(`## Unattended compute (no client at all)\n`);
  md.push(`Watched for ${hours.toFixed(1)} h after its first suspend (poll every ${start.everyMs / 1000} s). Wakes nobody asked for: ${wakes.length}, awake about ${awake} s in total.${done ? "" : " Still running."}\n`);
  for (const w of wakes) md.push(`- seen active ${w.seenAt}, last_active ${w.lastActive}, suspended ${w.suspendedAt} (about ${w.awakeSecondsApprox} s)`);
  md.push("");
}

writeFileSync(new URL("summary.json", results), JSON.stringify(summary, null, 2) + "\n");
writeFileSync(new URL("summary.md", results), md.join("\n") + "\n");
console.log(md.join("\n"));
