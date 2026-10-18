// Creates a Neon project for the experiments and saves its ids in .state.json.
// Every compute is fixed at 0.25 CU, the smallest size, so CU-hours are easy
// to read off. The main branch keeps the default 5-minute scale to zero.
import { existsSync, writeFileSync } from "node:fs";
import { api, loadEnv, waitOperations } from "../lib/neon.mjs";

loadEnv();
const STATE = new URL("../.state.json", import.meta.url);
if (existsSync(STATE)) throw new Error(".state.json exists: run scripts/99-teardown.mjs first, or reuse the project");

const r = await api("POST", "/projects", {
  project: {
    name: "neon-keep-awake",
    region_id: process.env.NEON_REGION ?? "aws-eu-central-1",
    pg_version: 17,
    default_endpoint_settings: { autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25, suspend_timeout_seconds: 300 },
  },
});
await waitOperations(r.project.id, r.operations);
const state = { projectId: r.project.id, mainBranchId: r.branch.id, mainEndpointId: r.endpoints[0].id, createdAt: new Date().toISOString() };
writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
console.log(`project ${state.projectId}, main branch ${state.mainBranchId}, compute ${state.mainEndpointId}`);
