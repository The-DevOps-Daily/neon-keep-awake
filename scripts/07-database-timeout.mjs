// Checks the fix as the post recommends it: set
// idle_in_transaction_session_timeout on the database (not per session), leak
// a transaction on a new connection, and see whether the compute still
// suspends. One run, on its own branch with a 60-second suspend timeout.
import { readFileSync } from "node:fs";
import { connectionUri, createBranch, deleteBranch, loadEnv } from "../lib/neon.mjs";
import { openResults } from "../lib/record.mjs";
import { connect, probe, sleep, watchUntilSuspended } from "../lib/watch.mjs";

loadEnv();
const { projectId } = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const out = openResults("07-database-timeout", { projectId, suspendTimeout: 60, setting: "30s" });
const { branchId, endpointId } = await createBranch(projectId, `db-timeout-${Date.now().toString(36)}`, { suspendTimeout: 60, cu: 0.25 });
const direct = await connectionUri(projectId, branchId, false);
try {
  const admin = await connect(direct);
  await admin.query("alter database neondb set idle_in_transaction_session_timeout = '30s'");
  await admin.end();

  // A new session picks the setting up without setting anything itself.
  const app = await connect(direct);
  const { rows } = await app.query("show idle_in_transaction_session_timeout");
  await app.query("begin");
  await app.query("select 1");
  const lastQueryAt = new Date().toISOString();
  const res = await watchUntilSuspended(projectId, endpointId, { maxSeconds: 360 });
  const event = {
    type: "run",
    sessionSetting: rows[0].idle_in_transaction_session_timeout,
    lastQueryAt,
    suspended: res.suspended,
    suspendedAt: res.suspendedAt ?? null,
    secondsToSuspend: res.suspended ? Math.round((new Date(res.suspendedAt) - new Date(lastQueryAt)) / 1000) : null,
    leakedSessionError: app.lastError ? { message: app.lastError.message, code: app.lastError.code ?? null } : null,
  };
  if (res.suspended) {
    await sleep(3000);
    event.leakedSessionQuery = await probe(app);
  }
  out.write(event);
  console.log(JSON.stringify(event));
  await app.end().catch(() => {});
} finally {
  await deleteBranch(projectId, branchId).then(
    () => out.write({ type: "deleted", branchId }),
    (e) => out.write({ type: "delete-failed", branchId, error: e.message }),
  );
}
