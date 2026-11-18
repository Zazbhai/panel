# Code audit — 18 November 2026

Reviewed the backend routes/storage, OTP matcher, page controllers/shared UI, build script and Telegram importer. Production Firebase and Telegram were not accessed. Existing local data files were not edited by this audit.

## Fixed

| Area | Bug and fix |
| --- | --- |
| Order expiry | `getStatus` queried Firebase for expired completed orders. It now returns the saved OTP without an upstream request. |
| OTP persistence | Receiving more than 100 OTPs or storing more than 500 matched messages made the next rotation read reject the whole file. Removed these incompatible read limits. |
| OTP lengths | Services accepted 1–32 digits while rotation and the latest OTP page rejected codes outside 4–8. Persistence and display now support the configured range. |
| Latest OTP | A late older message could overwrite a newer OTP. History is now ordered by receive time, and the latest fields come from the newest entry. |
| Legacy OTP deduplication | A later message with the same code as a legacy record was discarded. Deduplication now uses code plus timestamp when the old record has no message key. |
| Rotation cleanup | A missing Firebase node normally returns HTTP 200 with JSON `null`, rather than 404. Both missing-node responses now remove the URL; permission failures do not. Scan counts retain their original denominator. |
| JSON storage | Direct overwrite could expose partial JSON to readers or leave an empty file after interruption. Rotation and service saves now write a temporary file and rename it over the destination. |
| Service allocation | Disabled services and services with no enabled templates could allocate numbers. New allocations now require an enabled service/template. Duplicate service IDs are rejected, and service usage maps avoid inherited object keys. |
| API key validation | Applying a key on the API page checked `/api/config`, which authenticates the admin cookie. It now checks the explicit-key `/api/health` route. |
| Latest six OTPs | The page indirectly triggered Firebase scans through `/api/recent-orders` and hid history when services were missing/disabled. Saved-only requests now skip scans; stored OTPs remain readable without live service configuration. |
| Order details | Saved messages were re-matched against current templates and disappeared after template edits. Details now use the already matched saved history. |
| Navigation | Returning through browser Back could leave recent-order polling permanently stopped. The interval now resumes on a restored page. `.html` routes also receive the correct bottom-navigation active state. |
| Empty rotation | The devices page silently reintroduced the default database when the saved rotation was empty. A successfully loaded empty list is now respected. |
| Device scan jobs | Navigating back during a second scan hid the previous totals; transient poll errors also stopped tracking the running job. Running jobs now expose their previous result and polling retries transient failures. |
| Template matching | `[DIGITS:n]` read the wrong regex capture, and repeated OTP markers could accept different codes. Browser and backend now agree on both rules. |
| Telegram importer | Failed URL submissions remained deduplicated forever. Failures now release the URL for another attempt, imports have four concurrent network slots, endpoint query parameters are preserved, and Markdown URL suffixes are stripped. The dashboard key is read from the environment or the same local `.env` as the server. |
| Browser storage | Blocking localStorage prevented services from becoming usable even after successful server loading/saving. Cache failures no longer invalidate successful server operations. |
| Build | Rotation's count/device-stat CSS existed only in generated HTML and disappeared on rebuild. It now has a source file at `frontend/rotation.css`. Browser fixtures were also updated for bottom navigation, scan jobs and the saved six-OTP feed. |

## Remaining findings

1. **High: Telegram session credentials are tracked.** `git ls-files` includes `userbot_session.session`; `test.py` also contains Telegram API credentials. Ignore rules were added to prevent new session files, but ignore rules do not remove an already tracked file or its history. Removing it from tracking/history and revoking an exposed session requires an explicit credential cleanup; this audit did not delete the working session or rewrite Git history.
2. **High: Telegram import progress can skip work.** `last_done.txt` is global rather than scoped to the source channel. Live events and old-message forwarding both write it; failed background URL registration is not recorded in a durable retry queue. A restart or source change can therefore skip historical posts or URLs that never reached rotation. Releasing failed in-memory submissions improves retries within a run but does not solve restart recovery.
3. **Medium: Number allocation blocks other rotation operations.** `getNumber` holds `withRotationLock` while `findAvailableActiveNumber` performs upstream reads. Many slow databases can delay URL additions, other allocations and recent-order reads. A snapshot/read/reserve design with a final lock-and-recheck is needed to shorten this safely.
4. **Medium: Concurrent editing can overwrite newer configuration.** Rotation and service updates replace complete lists without a revision check. Atomic writes prevent partial files, but another browser tab or a URL importer can still add entries between loading and saving. Optimistic revision checks should reject stale saves instead of silently replacing newer lists.

## Verification

Passed offline regression suites:

- `node scripts/verify-api-health-balance.cjs`
- `node scripts/verify-backend-regressions.cjs`
- `node scripts/verify-ui-regressions.cjs`
- `node scripts/verify-service-matching-core.js`
- `python scripts/verify-userbot.py`

The server fixture evaluates request handlers with synthetic storage and a mocked fetch function, without executing server startup. JavaScript syntax, Python compilation, embedded-script syntax and diff checks are included in the final verification.

Browser execution was attempted through `python -u scripts/verify-frontend.py`, but Playwright failed before launching Chrome with Windows `PermissionError: [WinError 5] Access is denied`. Layout and browser interaction checks therefore remain unverified in this run. No claim is made that every possible bug has been eliminated.
