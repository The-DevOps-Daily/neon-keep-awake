// Watches a compute through the Neon API. Reading the endpoint is a
// control-plane call: it does not touch the compute, so watching cannot keep
// it awake.
import pg from "pg";
import { endpoint } from "./neon.mjs";

export const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One sample: what the API says right now.
export async function sample(projectId, endpointId) {
  const e = await endpoint(projectId, endpointId);
  return { at: new Date().toISOString(), state: e.current_state, lastActive: e.last_active ?? null, suspendedAt: e.suspended_at ?? null };
}

// Polls until the compute is no longer active, or until maxSeconds.
// Returns the samples and, if it suspended, Neon's own timestamps.
export async function watchUntilSuspended(projectId, endpointId, { maxSeconds, onSample } = {}) {
  const t0 = Date.now();
  const samples = [];
  let lastActiveSeen = null;
  while (Date.now() - t0 < maxSeconds * 1000) {
    const s = await sample(projectId, endpointId);
    samples.push(s);
    onSample?.(s);
    if (s.state === "active") lastActiveSeen = s.lastActive;
    else if (samples.some((x) => x.state === "active")) {
      return { suspended: true, detectedAt: s.at, suspendedAt: s.suspendedAt, lastActive: s.lastActive ?? lastActiveSeen, samples };
    }
    await sleep(POLL_MS);
  }
  return { suspended: false, samples, lastActive: lastActiveSeen };
}

// Connects with certificate checks on. channel_binding is dropped because
// node-postgres does not read it from the URL.
export async function connect(uri, { application = "neon-keep-awake" } = {}) {
  const url = new URL(uri);
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.delete("channel_binding");
  url.searchParams.set("application_name", application);
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 30_000 });
  client.lastError = null;
  // A suspend closes the socket under an idle client; keep the error to report it.
  client.on("error", (e) => (client.lastError = e));
  await client.connect();
  return client;
}

// Runs one query and reports how it went instead of throwing.
export async function probe(client, sql = "select 1") {
  const t = performance.now();
  try {
    await client.query(sql);
    return { ok: true, ms: Math.round(performance.now() - t) };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t), error: e.message, code: e.code ?? null };
  }
}

export { sleep };
