// Deletes the experiment project and .state.json.
import { readFileSync, unlinkSync } from "node:fs";
import { api, loadEnv } from "../lib/neon.mjs";

loadEnv();
const STATE = new URL("../.state.json", import.meta.url);
const { projectId } = JSON.parse(readFileSync(STATE, "utf8"));
await api("DELETE", `/projects/${projectId}`);
unlinkSync(STATE);
console.log(`deleted project ${projectId}`);
