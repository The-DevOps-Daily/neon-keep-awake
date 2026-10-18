// Stage 1: which kinds of open-but-quiet clients keep a compute awake?
//
// Each run wakes the compute, sets up one client pattern, then watches the
// compute through the API until it suspends or the window ends. After a
// suspend it tries each held connection again, to see what an app would see.
//
//   node scripts/01-idle-clients.mjs            all scenarios, default runs
//   node scripts/01-idle-clients.mjs idle-direct idle-pooled
import { readFileSync } from "node:fs";
import { api, connectionUri, createBranch, deleteBranch, loadEnv } from "../lib/neon.mjs";
import { openResults } from "../lib/record.mjs";
import { connect, probe, sleep, watchUntilSuspended } from "../lib/watch.mjs";

loadEnv();
const { projectId } = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const TIMEOUT = Number(process.env.SUSPEND_TIMEOUT ?? 60);
const STAY_WINDOW = Number(process.env.STAY_WINDOW ?? 360); // long enough to show a compute that never suspends
const WINDOW = TIMEOUT + 240;

let direct, pooled, postgresDb;

const scenarios = {
  // Nothing open after the last query: the baseline.
  none: { runs: 3, window: WINDOW, setup: async () => ({ held: [] }) },

  "idle-direct": {
    runs: 3,
    window: WINDOW,
    setup: async () => {
      const c = await connect(direct);
      await c.query("select 1");
      return { held: [["direct", c]] };
    },
  },

  "idle-pooled": {
    runs: 3,
    window: WINDOW,
    setup: async () => {
      const c = await connect(pooled);
      await c.query("select 1");
      return { held: [["pooled", c]] };
    },
  },

  // An app that checked out a client, ran BEGIN and never committed.
  "idle-in-transaction-direct": {
    runs: 2,
    window: STAY_WINDOW,
    setup: async () => {
      const c = await connect(direct);
      await c.query("begin");
      await c.query("select 1");
      return { held: [["direct", c]], release: () => c.query("rollback") };
    },
  },

  "idle-in-transaction-pooled": {
    runs: 2,
    window: STAY_WINDOW,
    setup: async () => {
      const c = await connect(pooled);
      await c.query("begin");
      await c.query("select 1");
      return { held: [["pooled", c]], release: () => c.query("rollback") };
    },
  },

  // The same leak with Postgres told to end such sessions after 30 seconds.
  "idle-in-transaction-with-timeout": {
    runs: 2,
    window: WINDOW,
    setup: async () => {
      const c = await connect(direct);
      await c.query("set idle_in_transaction_session_timeout = '30s'");
      await c.query("begin");
      await c.query("select 1");
      return { held: [["direct", c]] };
    },
  },

  // A LISTEN connection, as used for cache invalidation or live updates.
  "listen-direct": {
    runs: 2,
    window: WINDOW,
    setup: async () => {
      const c = await connect(direct);
      c.received = [];
      c.on("notification", (n) => c.received.push(n.payload));
      await c.query("listen keep_awake");
      return {
        held: [["direct", c]],
        afterSuspend: async () => {
          // Wakes the compute with a new connection and sends a notification.
          const sender = await connect(direct);
          await sender.query("notify keep_awake, 'after-suspend'");
          await sender.end();
          await sleep(3000);
          return { notificationReceived: c.received.includes("after-suspend") };
        },
      };
    },
  },

  // A monitoring agent that keeps one connection to the postgres database and
  // reads pg_stat_database every 20 seconds, like postgres_exporter.
  "monitor-postgres-db-20s": {
    runs: 1,
    window: STAY_WINDOW,
    setup: async () => {
      const c = await connect(postgresDb);
      await c.query("select sum(xact_commit) from pg_stat_database");
      const timer = setInterval(() => c.query("select sum(xact_commit) from pg_stat_database").catch(() => {}), 20_000);
      return { held: [["direct-postgres-db", c]], release: () => clearInterval(timer) };
    },
  },
};

const chosen = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
for (const name of chosen) if (!scenarios[name]) throw new Error(`unknown scenario ${name}`);

const out = openResults("01-idle-clients", { projectId, suspendTimeout: TIMEOUT, cu: 0.25, scenarios: chosen });
const { branchId, endpointId } = await createBranch(projectId, `idle-clients-${Date.now().toString(36)}`, { suspendTimeout: TIMEOUT, cu: 0.25 });
out.write({ type: "branch", branchId, endpointId });
direct = await connectionUri(projectId, branchId, false);
pooled = await connectionUri(projectId, branchId, true);
postgresDb = await connectionUri(projectId, branchId, false, "postgres");

try {
  for (const name of chosen) {
    const sc = scenarios[name];
    for (let run = 1; run <= sc.runs; run++) {
      // Wake the compute (often a cold start) and time it.
      const t = performance.now();
      const waker = await connect(direct);
      await waker.query("select 1");
      const wakeMs = Math.round(performance.now() - t);
      await waker.end();

      const pattern = await sc.setup();
      const lastQueryAt = new Date().toISOString();
      const res = await watchUntilSuspended(projectId, endpointId, { maxSeconds: sc.window });
      const event = {
        type: "run",
        scenario: name,
        run,
        wakeMs,
        lastQueryAt,
        window: sc.window,
        suspended: res.suspended,
        suspendedAt: res.suspendedAt ?? null,
        detectedAt: res.detectedAt ?? null,
        lastActiveApi: res.lastActive ?? null,
        // Every distinct last_active value the API reported while we watched.
        lastActiveValues: [...new Set(res.samples.map((s) => s.lastActive).filter(Boolean))],
        samples: res.samples.length,
      };
      if (res.suspended) {
        await sleep(5000);
        event.heldAfterSuspend = [];
        for (const [kind, c] of pattern.held) {
          const before = c.lastError ? { error: c.lastError.message, code: c.lastError.code ?? null } : null;
          event.heldAfterSuspend.push({ kind, errorEventBeforeQuery: before, query: await probe(c) });
        }
        if (pattern.afterSuspend) event.afterSuspend = await pattern.afterSuspend();
      }
      if (pattern.release) await Promise.resolve(pattern.release()).catch(() => {});
      for (const [, c] of pattern.held) await c.end().catch(() => {});
      // A compute that stayed up: show that it suspends once the client goes.
      if (!res.suspended) {
        const releasedAt = new Date().toISOString();
        const after = await watchUntilSuspended(projectId, endpointId, { maxSeconds: WINDOW });
        event.afterRelease = { releasedAt, suspended: after.suspended, suspendedAt: after.suspendedAt ?? null, lastActiveApi: after.lastActive ?? null };
      }
      out.write(event);
      console.log(`${name} #${run}: ${res.suspended ? `suspended at ${res.suspendedAt}` : `still active after ${sc.window}s`} (wake ${wakeMs} ms)`);
    }
  }
} finally {
  // Neon's own usage counters for this branch, read before it is deleted.
  const { branch } = await api("GET", `/projects/${projectId}/branches/${branchId}`).catch(() => ({}));
  if (branch) out.write({ type: "branch-usage", branchId, active_time_seconds: branch.active_time_seconds, compute_time_seconds: branch.compute_time_seconds, cpu_used_sec: branch.cpu_used_sec, created_at: branch.created_at });
  await deleteBranch(projectId, branchId).then(
    () => out.write({ type: "deleted", branchId }),
    (e) => out.write({ type: "delete-failed", branchId, error: e.message }),
  );
}
