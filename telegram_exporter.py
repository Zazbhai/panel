"""Export every Firebase database URL in Telegram history to local TXT batches."""
import argparse
import asyncio
import math
import os
import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from firebase_batches import FirebaseBatchWriter


DATABASE_URL_RE = re.compile(
    r"https?://[a-z0-9-]+(?:\.[a-z0-9-]+)*\."
    r"(?:firebaseio\.com|firebasedatabase\.app)(?![a-z0-9-]|\.[a-z0-9-])"
    r"(?:[/?#][^\s<>\"'\x60*\\\[\]{}]*)?",
    re.IGNORECASE,
)


def extract_database_urls(message):
    texts = [getattr(message, "raw_text", None) or getattr(message, "text", "") or ""]
    for entity in getattr(message, "entities", None) or []:
        if getattr(entity, "url", None):
            texts.append(entity.url)
    for row in getattr(message, "buttons", None) or []:
        for button in row:
            if getattr(button, "url", None):
                texts.append(button.url)
    urls = []
    for text in texts:
        text = text.replace(r"\:", ":").replace(r"\/", "/")
        for match in DATABASE_URL_RE.finditer(text):
            url = match[0].rstrip(".,;:!?\u201d\u2019)\x60*]}>\\")
            parts = urlsplit(url)
            url = urlunsplit((
                parts.scheme.lower(), parts.netloc.lower(),
                parts.path or "/", parts.query, parts.fragment,
            ))
            if url not in urls:
                urls.append(url)
    return urls


class IncompleteHistoryError(RuntimeError):
    pass


class HistoryExporter:
    def __init__(self, client, source, source_id, writer, *, start_from=1,
                 rescan=False, wait_time=1, log=print):
        self.client = client
        self.source = source
        self.source_id = source_id
        self.writer = writer
        self.cursor = start_from - 1 if rescan else writer.cursor(source_id, start_from)
        if rescan:
            writer.save_cursor(source_id, self.cursor, reset=True)
        self.wait_time = wait_time
        self.log = log
        self.lock = asyncio.Lock()
        self.wake = asyncio.Event()

    async def scan(self):
        """Read newest-first; commit a cursor only after every page is saved."""
        async with self.lock:
            newest = await self.client.get_messages(self.source, limit=1)
            if not newest:
                return 0
            latest = newest[0].id
            if latest < self.cursor:
                raise IncompleteHistoryError(
                    f"Source newest ID #{latest} is below checkpoint #{self.cursor}. "
                    "Run with --rescan to recheck available history."
                )
            if latest == self.cursor:
                return 0
            lower = self.cursor
            messages = 0
            added = 0
            self.log(f"Scanning available history #{lower + 1} through #{latest}...", flush=True)
            async for message in self.client.iter_messages(
                self.source, limit=None, offset_id=latest + 1,
                min_id=lower, reverse=False, wait_time=self.wait_time,
            ):
                if not lower < message.id <= latest:
                    continue
                added += self.writer.add_urls(extract_database_urls(message))
                messages += 1
                if messages % 100 == 0:
                    self.log(
                        f"Scanned {messages} posts through #{message.id}; "
                        f"{added} new links ({self.writer.count} total).", flush=True,
                    )
            if messages == 0:
                raise IncompleteHistoryError(
                    f"Telegram shows newest post #{latest}, but history returned "
                    f"no posts after #{lower}. Check the source/access; progress "
                    "was not advanced."
                )
            # Events only wake scans. They never advance this checkpoint.
            self.writer.save_cursor(self.source_id, latest)
            self.cursor = latest
            self.log(
                f"History saved through #{latest}: {messages} posts, {added} new "
                f"links; {self.writer.count} unique links total.", flush=True,
            )
            return messages

    async def run(self, flood_error, *, interval=10):
        while self.client.is_connected():
            self.wake.clear()
            try:
                await self.scan()
                if self.wake.is_set():
                    continue
                await asyncio.wait_for(self.wake.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass
            except flood_error as error:
                self.log(
                    f"Telegram cooldown: {error.seconds + 1}s. Saved links are "
                    "safe; the incomplete history pass will be retried.", flush=True,
                )
                await asyncio.sleep(error.seconds + 1)
            except (OSError, ConnectionError, IncompleteHistoryError) as error:
                self.log(f"History retry in {interval}s: {error}", flush=True)
                await asyncio.sleep(interval)


def arguments(base_dir):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-size", type=int,
                        default=int(os.getenv("FIREBASE_BATCH_SIZE", "1000")))
    parser.add_argument("--output-dir", type=Path,
                        default=Path(os.getenv("FIREBASE_BATCH_DIR", str(base_dir / "firebase_batches"))))
    parser.add_argument("--from-id", type=int, default=1,
                        help="First message ID to include on a fresh export/rescan")
    parser.add_argument("--rescan", action="store_true",
                        help="Recheck all available history; existing links remain deduplicated")
    parser.add_argument("--poll-interval", type=float, default=10)
    args = parser.parse_args()
    if args.batch_size < 1 or args.from_id < 1 or not math.isfinite(args.poll_interval) or args.poll_interval <= 0:
        parser.error("Batch size, first message ID and poll interval must be positive")
    return args


async def run(api_id, api_hash, source, base_dir):
    from telethon import TelegramClient, events, utils
    from telethon.errors import FloodWaitError

    args = arguments(base_dir)
    client = TelegramClient(str(base_dir / "userbot_session"), api_id, api_hash)
    try:
        def phone_number():
            phone = input("Apna phone number daalo (+91XXXXXXXXXX), bot token NAHI: ").strip()
            if ":" in phone:
                raise ValueError("Phone number required, not a bot token.")
            return phone

        await client.start(phone=phone_number)
        me = await client.get_me()
        if me.bot:
            raise RuntimeError("A Telegram user account session is required, not a bot session.")
        print(f"Login: {me.first_name} - channels load ho rahe hain...", flush=True)
        entity = None
        async for dialog in client.iter_dialogs():
            if str(dialog.id) == str(source):
                entity = dialog.entity
                break
        if entity is None:
            entity = await client.get_entity(source)
        source_id = utils.get_peer_id(entity)
        print(f"Source mila: {getattr(entity, 'title', source_id)} ({source_id})", flush=True)
        with FirebaseBatchWriter(args.output_dir, args.batch_size) as writer:
            exporter = HistoryExporter(
                client, entity, source_id, writer,
                start_from=args.from_id, rescan=args.rescan,
            )

            async def wake_scan(_event):
                exporter.wake.set()

            async def save_edit(event):
                async with exporter.lock:
                    writer.add_urls(extract_database_urls(event.message))
                    exporter.wake.set()

            client.add_event_handler(wake_scan, events.NewMessage(chats=entity))
            client.add_event_handler(save_edit, events.MessageEdited(chats=entity))
            print(
                f"Export #{exporter.cursor + 1} se; {writer.count} existing links. "
                f"Output: {writer.output_dir}; {args.batch_size} links per batch. "
                "Old forwarding last_done.txt is intentionally not used.",
                flush=True,
            )
            worker = asyncio.create_task(exporter.run(FloodWaitError, interval=args.poll_interval))
            disconnected = asyncio.ensure_future(client.disconnected)
            try:
                done, _pending = await asyncio.wait(
                    [worker, disconnected], return_when=asyncio.FIRST_COMPLETED,
                )
                if worker in done:
                    await worker
            finally:
                client.remove_event_handler(wake_scan)
                client.remove_event_handler(save_edit)
                worker.cancel()
                await asyncio.gather(worker, return_exceptions=True)
                print(f"Export stopped. {writer.count} unique links saved.", flush=True)
    finally:
        await client.disconnect()
