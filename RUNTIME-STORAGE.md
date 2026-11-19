Orders, saved OTPs, permanent service locks, active leases, and the shared number inventory now live in `runtime.sqlite`. Use Node **22.13 or newer** (Node 24 LTS is recommended). PM2 must use that Node version too. SQLite runs in WAL mode with `synchronous=NORMAL` so transactions stay off the HTTP event loop while preserving committed changes across process crashes.

On the first start, the server imports the existing `rotation.json` transactionally and preserves the original in `rotation.pre-sqlite.json`. After migration, `rotation.json` stores the database list and a migration marker; new orders do not rewrite that file. Keep the SQLite file when updating or redeploying the application. If it is missing after migration, allocation fails closed rather than forgetting permanent locks.

A number has one waiting order at a time. Its first OTP permanently locks `(service, number)` and releases that order's lease. Another service can then allocate it after checking the device is online. The completed order still accepts additional OTPs until its original expiry. A later OTP for the old order cannot release a newer order's lease. A device SMS can be saved against only one order.

The shared inventory caches a device/number mapping for up to 24 hours; refreshing online status does not extend that mapping lifetime. Normal warm allocations read only device status, using the existing ten-second request cache. A cache miss can still require bounded discovery reads. Startup and low-watermark refills run per service in parallel, and concurrent `getNumber` calls join the same in-flight service refill instead of duplicating Firebase scans. Discovery checks up to 16 databases in parallel and permits 6 shared Firebase reads by default; `NUMBER_DATABASE_CONCURRENCY` and `MAX_CONCURRENT_DATABASE_READS` can tune those limits. The default number allocation budget is 10 seconds; `NUMBER_REQUEST_TIMEOUT_MS` can lower it to a value from 1,000 through 10,000 milliseconds. SQLite claims use a 250 ms lock wait and a 100 ms deadline margin so contention fails within the API allocation budget. All SMS matching remains on-demand through `getStatus`; the recent-orders and service-messages feeds read saved SQLite data only.

Back up runtime data with a consistent SQLite backup. With PM2 stopped, copy `runtime.sqlite` and any existing `runtime.sqlite-wal` and `runtime.sqlite-shm` alongside `rotation.json` and `services.json`. For a running process, use SQLite's backup facility, not an ordinary copy of the database file alone. `rotation.pre-sqlite.json` is a pre-migration fallback and does not contain subsequent orders or locks.

Run synthetic checks without starting the live server or accessing Firebase:

```powershell
node scripts/verify-runtime-store.cjs
node scripts/verify-backend-regressions.cjs
node scripts/verify-ui-regressions.cjs
```
