Orders, saved OTPs, permanent service locks, active leases, and the shared number inventory now live in `runtime.sqlite`. Use Node **22.13 or newer** (Node 24 LTS is recommended). PM2 must use that Node version too. SQLite runs in WAL mode with `synchronous=NORMAL` so transactions stay off the HTTP event loop while preserving committed changes across process crashes.

On the first start, the server imports the existing `rotation.json` transactionally and preserves the original in `rotation.pre-sqlite.json`. After migration, `rotation.json` stores the database list and a migration marker; new orders do not rewrite that file. Keep the SQLite file when updating or redeploying the application. If it is missing after migration, allocation fails closed rather than forgetting permanent locks.

A number has one waiting order at a time. Its first OTP permanently locks `(service, number)` and releases that order's lease. Another service can then allocate it after checking the device is online. The completed order still accepts additional OTPs until its original expiry. A later OTP for the old order cannot release a newer order's lease. A device SMS can be saved against only one order.

The shared inventory caches a device/number mapping for up to 24 hours; refreshing online status does not extend that mapping lifetime. `getNumber` first selects and reserves recently verified, unused stock in one SQLite transaction, without rebuilding a queue or reading Firebase. Both the number and its database check must be fresh (60 seconds by default, set by `ACTIVE_CLIENT_STATUS_TTL_MS`). The transaction excludes service locks, previous attempts for that service, and active leases. Recycled numbers use the existing fallback path with an explicit online check. Global online totals can therefore exceed stock eligible for a particular service.

A background sweeper keeps low-watermark pools populated and checks every configured database in parallel, with 32 shared Firebase reads by default; `NUMBER_DATABASE_CONCURRENCY` and `MAX_CONCURRENT_DATABASE_READS` can tune those limits. Queue refills read persisted status without rewriting every database's status or extending its freshness. Each inventory task has a bounded timeout (`NUMBER_MAPPING_PREFETCH_TASK_TIMEOUT_MS`, default 12 seconds), failed databases are left unchecked for the next pass, and a watchdog (`NUMBER_MAPPING_PREFETCH_WATCHDOG_MS`, default 30 seconds) aborts and restarts a pass that stops making progress. `getNumber` never waits for a full database sweep. If the pool is cold or empty it returns `NO_NUMBERS` while the sweeper continues. The default allocation budget is 30 seconds; `NUMBER_REQUEST_TIMEOUT_MS` accepts values from 1,000 through 30,000 milliseconds. SQLite claims use a 250 ms lock wait and a 100 ms deadline margin. All SMS matching remains on-demand through `getStatus`; the recent-orders and service-messages feeds read saved SQLite data only.

Stock totals and inventory progress share one read snapshot, cached for three seconds per server process. Once a snapshot exists, stock requests return it immediately while one background refresh updates an expired cache. Responses mark old snapshots with `stale: true`; the stocks page keeps the totals visible and shows their timestamp. The initial request after a process restart still needs a successful storage read.

Ready claims and database inventory refresh transactions retry brief SQLite lock conflicts at most twice with a short delay. Allocation retries retain the original deadline; other storage errors are not retried.

Back up runtime data with a consistent SQLite backup. With PM2 stopped, copy `runtime.sqlite` and any existing `runtime.sqlite-wal` and `runtime.sqlite-shm` alongside `rotation.json` and `services.json`. For a running process, use SQLite's backup facility, not an ordinary copy of the database file alone. `rotation.pre-sqlite.json` is a pre-migration fallback and does not contain subsequent orders or locks.

Run synthetic checks without starting the live server or accessing Firebase:

```powershell
node scripts/verify-runtime-store.cjs
node scripts/verify-backend-regressions.cjs
node scripts/verify-ui-regressions.cjs
node scripts/verify-ready-stock.cjs
```
