# neon-keep-awake

Measure what keeps a Neon compute from scaling to zero, and what each pattern costs in CU-hours. Real Neon computes, watched through the Neon API; nothing is simulated.

```bash
cp .env.example .env        # add a Neon API key
npm install
npm run setup               # creates one project, 0.25 CU computes
npm run idle-clients        # stage 1, about an hour
npm run health-checks       # stage 2, about an hour (configs run side by side)
HOURS=12 npm run watch-unattended   # stage 3, leave it running
npm run summarize           # results/summary.md and summary.json
npm run teardown            # deletes the project
```

Stage 1 sets the suspend timeout to 60 seconds, which needs a plan that lets you change it. On a plan with the fixed 5-minute timeout, run it with `SUSPEND_TIMEOUT=300` (it takes about five times longer).

## What each script does

| Script | What it measures |
|---|---|
| `00-setup.mjs` | Creates a project. Every compute is fixed at 0.25 CU, so CU-hours are easy to read off. |
| `01-idle-clients.mjs` | Wakes a compute, leaves one kind of quiet client open (none, an idle direct or pooled connection, an open transaction, a `LISTEN` connection, a monitoring agent), and watches whether and when the compute suspends. After a suspend it uses the held connection again and records what the client sees. |
| `02-health-checks.mjs` | A health check (new pooled connection, `SELECT 1`) every N seconds against computes with a 60 s or 300 s suspend timeout. Records the share of time the compute is awake and how long the checks that woke it waited. |
| `03-watch-unattended.mjs` | Watches a compute that nothing connects to for hours, and records every time it wakes anyway. |
| `04-summarize.mjs` | Reads `results/*.jsonl` and writes the tables. It refuses a results file written by more than one version of the code. It also reads the operations log from `05`, to check the polled awake time against Neon's own record. |
| `05-operations.mjs` | Saves the project's operations log (`start_compute`, `suspend_compute`, `check_availability`, ...): what the Console shows under Monitoring > System operations. |
| `06-network-rtt.mjs` | TCP connect time to the region's proxy, to read wake-up times against the network round trip. Names no compute, so it wakes nothing. |
| `07-database-timeout.mjs` | Sets `idle_in_transaction_session_timeout` on the database, leaks a transaction on a new connection, and checks that the compute still suspends. |
| `08-verify-stamps.mjs` | Checks that every results file was written by the scripts as they are in this repository. |
| `99-teardown.mjs` | Deletes the project. |

The compute's state comes from `GET /projects/{id}/endpoints/{id}` (`current_state`, `last_active`, `suspended_at`). That is a control-plane call and does not touch the compute, so watching it cannot keep it awake.

## Results

From our runs in `aws-eu-central-1`, 0.25 CU (full tables in `results/summary.md`):

- An idle connection, direct or pooled, did not stop the suspend (3 of 3 each). Neither did a `LISTEN` connection. The suspend closed all of them.
- An open transaction (`idle in transaction`), direct or pooled, kept the compute awake for the whole 6-minute window, 4 of 4. `idle_in_transaction_session_timeout` fixed it.
- A monitoring query every 20 seconds kept it awake.
- A health check every 5 minutes kept a compute with the default 5-minute timeout awake for the whole 40-minute run: in these runs the suspend came 312 to 327 seconds after a wake. Every 6 minutes: 90.6% awake. Every 10 minutes: 52.1%.
- Polled awake time matched Neon's operations log within half a percentage point.

Write-up: _link added when the post is published_.

The raw runs are in `results/*.jsonl`; every line carries a hash of the code that wrote it (`npm run verify-stamps`).

## License

MIT
