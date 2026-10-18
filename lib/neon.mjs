// Small Neon API client: just the calls the scripts need.
import { readFileSync } from "node:fs";

const API = "https://console.neon.tech/api/v2";

// Reads .env next to package.json, without a dependency.
export function loadEnv() {
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env: use the environment as it is
  }
}

export function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function api(method, path, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${need("NEON_API_KEY")}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (res.ok) return res.status === 204 ? {} : res.json();
    const text = await res.text();
    // 423: another operation is running on the project. 429 and 5xx: try again.
    if ((res.status === 0 || res.status === 423 || res.status === 429 || res.status >= 500) && attempt < 8) {
      await sleep(1000 * attempt);
      continue;
    }
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
}

export async function waitOperations(projectId, operations = []) {
  for (const op of operations) {
    for (let i = 0; i < 600; i++) {
      const { operation } = await api("GET", `/projects/${projectId}/operations/${op.id}`);
      if (operation.status === "finished") break;
      if (operation.status === "failed" || operation.status === "error") throw new Error(`operation ${op.id} ${operation.status}`);
      await sleep(500);
    }
  }
}

export async function endpoint(projectId, endpointId) {
  return (await api("GET", `/projects/${projectId}/endpoints/${endpointId}`)).endpoint;
}

export async function setEndpoint(projectId, endpointId, settings) {
  const r = await api("PATCH", `/projects/${projectId}/endpoints/${endpointId}`, { endpoint: settings });
  await waitOperations(projectId, r.operations);
  return r.endpoint;
}

// pooled=false must be explicit: without it the API returns the pooled string.
export async function connectionUri(projectId, branchId, pooled, database = "neondb") {
  const q = new URLSearchParams({ branch_id: branchId, database_name: database, role_name: "neondb_owner", pooled: String(pooled) });
  return (await api("GET", `/projects/${projectId}/connection_uri?${q}`)).uri;
}

// A child branch with its own compute, so experiments never share a compute.
export async function createBranch(projectId, name, { suspendTimeout, cu }) {
  const { branches } = await api("GET", `/projects/${projectId}/branches`);
  const parent = branches.find((b) => b.default) ?? branches[0];
  const r = await api("POST", `/projects/${projectId}/branches`, {
    branch: { name, parent_id: parent.id },
    endpoints: [{ type: "read_write", suspend_timeout_seconds: suspendTimeout, autoscaling_limit_min_cu: cu, autoscaling_limit_max_cu: cu }],
  });
  await waitOperations(projectId, r.operations);
  return { branchId: r.branch.id, endpointId: r.endpoints[0].id };
}

export async function deleteBranch(projectId, branchId) {
  const r = await api("DELETE", `/projects/${projectId}/branches/${branchId}`);
  await waitOperations(projectId, r.operations);
}
