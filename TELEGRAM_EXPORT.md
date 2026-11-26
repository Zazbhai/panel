# Firebase link export

Upload these files together to your server's panel directory:

- test.py
- telegram_exporter.py
- firebase_batches.py

Keep your existing Telegram session file. Inside the existing Python environment:

    python3 test.py --batch-size 1000

Edit `ROUTES` in `test.py`. Add one object per source-to-target pair:

    ROUTES = [
        {"source": -1004418505510, "target": "@target_one"},
        {"source": "@other_source", "target": "@target_two"},
        {"source": -1004418505510, "target": "@backup_target"},
    ]

Each pair starts its own concurrent history/live worker with an independent
checkpoint and output folder under `firebase_batches/route_<source>_<target>/`.
Repeating a source creates separate route batches for each target. On startup,
each worker scans its history, extracts all Firebase URLs, writes its
route-specific batches, and submits the URLs to the dashboard endpoint. After
all configured routes finish registration, each worker sends its batch files to
its target as Telegram documents. Failed registrations are reported and do not
prevent sending the files. Later scans send only newly created batch files.
URL checks run concurrently with a bounded pool, so forwarding does not wait for
the dashboard checks. A URL rejected by Firebase is logged and eligible for
submission again when it appears in a later post.

Messages are forwarded to their configured targets. All Firebase URLs in each
message, caption, hidden text link or URL button are exported to local TXT files,
one URL per line, and submitted to the dashboard's `/api/addDatabaseUrl` endpoint.
The endpoint defaults to `http://127.0.0.1:3000/api/addDatabaseUrl`; set
`DASHBOARD_ADD_DATABASE_URL_ENDPOINT` if the dashboard uses another address.
`DASHBOARD_API_KEY` is read from the environment or the adjacent `.env` file.
Duplicate TXT URLs are skipped across messages and restarts.
If dashboard registration fails, the worker sends the URL and error to the target
channel(s) for that route. To also send failures through a Telegram bot, set
`DATABASE_FAILURE_BOT_TOKEN` and `DATABASE_FAILURE_BOT_CHAT_ID` in the environment
or adjacent `.env`. The bot must be started and allowed to message that chat.
Failure alerts are spaced at 1.1 seconds by default; change this with
`DATABASE_FAILURE_BOT_INTERVAL_SECONDS`. Invalid bot credentials or a missing
chat are reported with the Bot API HTTP status and then disabled for the run.

Output is next to test.py, in firebase_batches/:

    route_-1004492989164_-1005794536077/
      batch_0001 - 1000 links.txt
      batch_0002 - 237 links.txt
      export.sqlite3

Each full batch contains exactly 1,000 links. The last batch is saved immediately,
even when it has fewer links; its filename updates to show the current count.
To use X links per batch, supply --batch-size X. If you already exported with a
different size, use a new folder:

    python3 test.py --batch-size 500 --output-dir firebase_batches_500

Each route's SQLite file holds deduplication and progress. Keep these folders
when restarting. Missing TXT files are regenerated from SQLite at startup. If
upgrading from the older shared output format, the new route folders trigger an
automatic history rescan once to rebuild the per-route batches.
Each route also writes a plain-text message ID checkpoint beside `test.py`,
named `last_done_<source-id>_<target-id>.txt`. For the example route, it will be
`last_done_-1004418505510_<target-peer-id>.txt`. The SQLite cursor and text file
are both updated only after Telegram confirms that message was forwarded.

The first run scans available history for each configured source-target route,
oldest first, then keeps watching for new posts. Events wake workers and polling
every 10 seconds catches missed notifications. Each route advances its own
checkpoint only after a message was forwarded; a failed or interrupted message
is retried without skipping it. Firebase URL output is globally deduplicated.

To explicitly recheck older available messages:

    python3 test.py --rescan

To start at a particular message ID:

    python3 test.py --rescan --from-id 3861

Use --rescan to replay history for every configured route; already exported URLs
remain deduplicated, but posts will be forwarded again. Telegram must expose the
history to the logged-in account; deleted or inaccessible messages cannot be
recovered by the script. Each route resolves its configured source and target
explicitly. Numeric IDs are resolved from the logged-in account's Telegram
dialogs, so that account must be a member of both channels. When available,
using a channel's `@username` in `test.py` is the most reliable form. An
unresolvable route exits before scanning and identifies the missing source or
target.

Stop with Ctrl+C.

To import every URL already saved in `firebase_batches/` into rotation without
replacing the current list, run:

    python3 import_firebase_batches.py --concurrency 16

The importer deduplicates locally, lets the dashboard validate each Firebase
database, reports existing URLs separately, and writes rejected URLs with their
error to `firebase_batch_import_failures.txt`. Use `--dry-run` to inspect the
batch count without making dashboard requests.

Large history scans log progress while Telegram history is being fetched. The
route worker uses a 0.25 second pause between history pages by default. Set
`TELEGRAM_HISTORY_WAIT_TIME` in `.env` to increase it when Telegram responds
with flood waits, for example `TELEGRAM_HISTORY_WAIT_TIME=1`.

Offline checks (no Telegram login or network requests):

    python3 scripts/verify-userbot.py
