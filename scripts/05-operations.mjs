// Lists the project's operations (start_compute, suspend_compute,
// check_availability, ...) with their times, newest first, and counts them by
// action. These are what the Console shows under Monitoring > System operations.
//
//   node scripts/05-operations.mjs [projectId] [limit]
import { readFileSync, writeFileSync } from "node:fs";
import { api, loadEnv } from "../lib/neon.mjs";

loadEnv();
const projectId = process.argv[2] || JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8")).projectId;
const limit = Number(process.argv[3] ?? 1000);

const ops = [];
let cursor;
while (ops.length < limit) {
  const q = new URLSearchParams({ limit: "100" });
  if (cursor) q.set("cursor", cursor);
  const page = await api("GET", `/projects/${projectId}/operations?${q}`);
  ops.push(...page.operations);
  cursor = page.pagination?.cursor;
  if (!cursor || page.operations.length === 0) break;
}
const counts = {};
for (const o of ops) counts[o.action] = (counts[o.action] ?? 0) + 1;
const rows = ops.map((o) => ({ action: o.action, status: o.status, branch: o.branch_id, endpoint: o.endpoint_id ?? null, created: o.created_at, ms: o.total_duration_ms ?? null }));
writeFileSync(new URL(`../results/operations-${projectId}.json`, import.meta.url), JSON.stringify({ projectId, fetchedAt: new Date().toISOString(), counts, operations: rows }, null, 2) + "\n");
console.log(counts);
for (const r of rows.slice(0, 15)) console.log(r.created, r.action, r.status, r.endpoint ?? r.branch, r.ms);
