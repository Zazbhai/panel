# Firebase link export

Upload these three files together to your server's panel directory:

- test.py
- telegram_exporter.py
- firebase_batches.py

Keep your existing Telegram session file. Inside the existing Python environment:

    python3 test.py --batch-size 1000

This exports Firebase Realtime Database URLs to local TXT files, one URL per
line. It does not forward Telegram posts, copy media, or add databases to the
dashboard. All matching URLs in each message, caption, hidden text link or URL
button are extracted. Duplicate URLs are skipped across messages and restarts.

Output is next to test.py, in firebase_batches/:

    batch_0001 - 1000 links.txt
    batch_0002 - 1000 links.txt
    batch_0003 - 237 links.txt
    export.sqlite3

Each full batch contains exactly 1,000 links. The last batch is saved immediately,
even when it has fewer links; its filename updates to show the current count.
To use X links per batch, supply --batch-size X. If you already exported with a
different size, use a new folder:

    python3 test.py --batch-size 500 --output-dir firebase_batches_500

The SQLite file holds deduplication and channel-specific progress. Keep it when
restarting. Missing TXT files are regenerated from it at startup.

The first run scans all available source history, newest first. It deliberately
ignores the old forwarding last_done.txt so previously forwarded messages also
become TXT output. Afterward, events wake the exporter and polling every 10
seconds catches missed notifications. History progress advances only when the
whole scan has been saved; an interrupted scan safely replays without duplicates.

To explicitly recheck older available messages:

    python3 test.py --rescan

To start at a particular message ID:

    python3 test.py --rescan --from-id 3861

Use --rescan to recover URLs added by edits while the exporter was offline.
Telegram must expose the history to the logged-in account; deleted or inaccessible
messages cannot be recovered by the script. This version resolves the configured
source exactly, without matching unrelated channel IDs by their suffix.

Stop with Ctrl+C. No target channel is needed.

Offline checks (no Telegram login or network requests):

    python3 scripts/verify-userbot.py
