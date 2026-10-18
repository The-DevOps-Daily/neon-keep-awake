## Idle clients (suspend timeout 60 s, 0.25 CU)

| Scenario | Runs | Suspended | Last query to suspend (s) | Held connection after the suspend |
|---|---|---|---|---|
| none | 3 | 3 of 3 | 75, 68, 66 | - |
| idle-direct | 3 | 3 of 3 | 82, 81, 83 | error: Client has encountered a connection error and is not queryable |
| idle-pooled | 3 | 3 of 3 | 81, 83, 81 | error: Client has encountered a connection error and is not queryable |
| idle-in-transaction-direct | 2 | 0 of 2 (others awake for the whole 360 s); after the client let go: suspended 65, 72 s later | - | - |
| idle-in-transaction-pooled | 2 | 0 of 2 (others awake for the whole 360 s); after the client let go: suspended 68, 72 s later | - | - |
| idle-in-transaction-with-timeout | 2 | 2 of 2 | 102, 98 | error: Client has encountered a connection error and is not queryable |
| listen-direct | 2 | 2 of 2 | 83, 79 | error: Client has encountered a connection error and is not queryable |
| monitor-postgres-db-20s | 1 | 0 of 1 (others awake for the whole 360 s); after the client let go: suspended 63 s later | - | - |

## Health checks (new pooled connection + SELECT 1, 0.25 CU)

| Suspend timeout | Check every | Minutes | Checks | Checks that woke it | Awake per wake (s) | Wake check median / max (ms) | Warm check median (ms) | Awake (polled) | Awake (Neon operations log) | CU-hours per 30 days |
|---|---|---|---|---|---|---|---|---|---|---|
| 60 s | 30 s | 12 | 24 | 1 | - | 980 / 980 | 308 | 100.0% | 100.0% | 179.9 |
| 60 s | 90 s | 15 | 10 | 10 | 74 | 848 / 1310 | - | 82.2% | 81.8% | 148 |
| 60 s | 120 s | 16 | 8 | 8 | 86 | 859.5 / 1662 | - | 70.2% | 70.1% | 126.4 |
| 60 s | 180 s | 18 | 6 | 6 | 73 | 912 / 1764 | - | 40.5% | 40.6% | 72.9 |
| 300 s | 60 s | 30 | 30 | 1 | - | 847 / 847 | 329 | 100.0% | 100.0% | 180 |
| 300 s | 300 s | 40 | 8 | 1 | - | 853 / 853 | 339 | 100.0% | 100.0% | 180 |
| 300 s | 360 s | 42 | 7 | 7 | 327 | 1040 / 1753 | - | 90.6% | 90.5% | 163 |
| 300 s | 420 s | 42 | 6 | 6 | 314 | 1133.5 / 1878 | - | 74.7% | 74.6% | 134.5 |
| 300 s | 600 s | 60 | 6 | 6 | 313 | 1004 / 1163 | - | 52.1% | 52.0% | 93.8 |

## Unattended compute (no client at all)

Watched for 1.9 h after its first suspend (poll every 15 s). Wakes nobody asked for: 0, awake about 0 s in total. Still running.


