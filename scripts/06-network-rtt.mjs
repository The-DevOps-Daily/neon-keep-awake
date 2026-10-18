// How far is this machine from the Neon region? Times plain TCP connects to
// the region's proxy host (no TLS, no endpoint name, no query), so wake-up
// times can be read against the network round trip. It names no compute, so
// it cannot wake one.
import { readFileSync } from "node:fs";
import net from "node:net";
import { endpoint, loadEnv } from "../lib/neon.mjs";

loadEnv();
const { projectId, mainEndpointId } = JSON.parse(readFileSync(new URL("../.state.json", import.meta.url), "utf8"));
const host = (await endpoint(projectId, mainEndpointId)).proxy_host;
const times = [];
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  await new Promise((resolve, reject) => {
    const s = net.connect({ host, port: 5432 }, () => {
      times.push(performance.now() - t);
      s.destroy();
      resolve();
    });
    s.on("error", reject);
  });
  await new Promise((r) => setTimeout(r, 300));
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ host, tcpConnectMs: times.map((x) => Math.round(x)), median: Math.round((times[4] + times[5]) / 2) }));
