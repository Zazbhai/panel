"""Export every Firebase database URL in Telegram history to local TXT batches."""
import argparse
import asyncio
import hashlib
import json
import math
import os
import re
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
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
            urls.append(url)
    return urls


class IncompleteHistoryError(RuntimeError):
    pass


class DashboardAuthenticationError(RuntimeError):
    pass


class ChannelLinkFile:
    """Persistent URL occurrence log for one source Telegram channel."""
    def __init__(self, output_dir, source_id):
        self.path = Path(output_dir) / f"all links of {source_id}.txt"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.message_ids_path = self.path.with_suffix(".message_ids")
        self.message_ids = set()
        if self.message_ids_path.exists():
            self.message_ids.update(line.strip() for line in
                                    self.message_ids_path.read_text(encoding="utf-8").splitlines()
                                    if line.strip())

    def _append_message_urls(self, message_id, urls, *, edit_key=None):
        urls = [url for url in urls if url]
        if not urls:
            return 0
        key = f"{message_id}:{edit_key}" if edit_key else str(message_id)
        if key in self.message_ids:
            return 0
        with self.path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.writelines(url + "\n" for url in urls)
        with self.message_ids_path.open("a", encoding="utf-8", newline="\n") as ledger:
            ledger.write(key + "\n")
        self.message_ids.add(key)
        return len(urls)

    def add_message(self, message_id, urls):
        return self._append_message_urls(message_id, urls)

    def add_edit(self, message_id, urls):
        signature = hashlib.sha256("\n".join(urls).encode("utf-8")).hexdigest()
        return self._append_message_urls(message_id, urls, edit_key=signature)


class ChannelLinkReportSender:
    def __init__(self, client, target, *, log=print):
        self.client = client
        self.target = target
        self.log = log
        self.sent = {}
        self.lock = asyncio.Lock()

    async def send_latest(self, channel_file):
        if self.target is None or not channel_file.path.exists():
            return False
        async with self.lock:
            path = channel_file.path
            signature = (path.stat().st_mtime_ns, path.stat().st_size)
            if not signature[1] or self.sent.get(str(path)) == signature:
                return False
            await self.client.send_file(self.target, str(path))
            self.sent[str(path)] = signature
            self.log(f"Sent {path.name} to the all-links report channel.", flush=True)
            return True


class RoutePreparationBarrier:
    def __init__(self, expected, log=print, on_complete=None):
        self.expected = max(1, expected)
        self.ready = 0
        self.event = asyncio.Event()
        self.log = log
        self.on_complete = on_complete
        self.error = None

    async def mark_ready(self):
        self.ready += 1
        if self.ready >= self.expected:
            self.log(
                f"All {self.expected} route(s) finished database registration; "
                "sending failure summaries before route batch files...", flush=True,
            )
            if self.on_complete:
                try:
                    await self.on_complete()
                except Exception as error:
                    self.log(f"Could not send failure summaries: {error}", flush=True)
            self.event.set()

    async def wait(self):
        await self.event.wait()
        if self.error:
            raise self.error

    def fail(self, error):
        self.error = error
        self.event.set()


def target_identity(target):
    peer_id = getattr(target, "id", None)
    return (type(target).__name__, peer_id) if peer_id is not None else (type(target).__name__, repr(target))


def take_failure_report_items(reports):
    return reports.pop("items", [])


def is_unforwardable_message(message):
    """Telegram service/empty messages cannot be forwarded to a channel."""
    return type(message).__name__ in {"MessageService", "MessageEmpty"}


async def resolve_route_entity(client, reference, *, role, utils):
    """Resolve a route peer, falling back to dialogs when IDs are uncached."""
    try:
        return await client.get_entity(reference)
    except (ValueError, TypeError, KeyError) as original_error:
        wanted_id = None
        if isinstance(reference, int) or (
            isinstance(reference, str) and re.fullmatch(r"-?\d+", reference.strip())
        ):
            wanted_id = int(reference)
        wanted_name = str(reference).lstrip("@").casefold()
        try:
            async for dialog in client.iter_dialogs(limit=None):
                entity = dialog.entity
                peer_id = utils.get_peer_id(entity)
                username = getattr(entity, "username", None)
                title = getattr(entity, "title", None)
                if ((wanted_id is not None and peer_id == wanted_id)
                    or (wanted_id is None and (
                        str(username or "").casefold() == wanted_name
                        or str(title or "").casefold() == wanted_name))):
                    return entity
        except Exception as dialog_error:
            raise RuntimeError(
                f"Could not resolve {role} {reference!r} from Telegram dialogs: "
                f"{dialog_error}"
            ) from dialog_error
        raise RuntimeError(
            f"Could not resolve {role} {reference!r}. The logged-in account must "
            "be a member of that channel, or use its @username. "
            f"Initial Telegram error: {original_error}"
        ) from original_error


def load_setting(name, base_dir):
    if os.getenv(name):
        return os.environ[name]
    env_file = Path(base_dir) / ".env"
    if not env_file.exists():
        return ""
    for line in env_file.read_text(encoding="utf-8-sig").splitlines():
        match = re.match(rf"^\s*(?:export\s+)?{re.escape(name)}\s*=\s*(.*?)\s*$", line)
        if match:
            value = match.group(1)
            if value.startswith(("'", '"')) and value[-1:] == value[:1]:
                return value[1:-1]
            return value.split("#", 1)[0].strip()
    return ""


class DashboardDatabaseQueue:
    """Add discovered URLs to the dashboard with bounded concurrent checks."""
    def __init__(self, endpoint, api_key, *, on_failure=None, log=print):
        self.endpoint = endpoint
        self.api_key = api_key
        self.log = log
        self.seen = set()
        self.targets = {}
        self.on_failure = on_failure
        self.queued_urls = []
        self.drain_lock = asyncio.Lock()
        self.authentication_error = None

    def _bulk_endpoint(self):
        parsed = urllib.parse.urlsplit(self.endpoint)
        path = parsed.path
        if path.endswith("/api/addDatabaseUrl"):
            path = path[:-len("addDatabaseUrl")] + "addDatabaseUrls"
        elif path.endswith("addDatabaseUrl"):
            path = path[:-len("addDatabaseUrl")] + "addDatabaseUrls"
        return urllib.parse.urlunsplit(parsed._replace(path=path))

    @staticmethod
    def _target_key(target):
        peer_id = getattr(target, "id", None)
        if peer_id is not None:
            return (type(target).__name__, peer_id)
        try:
            hash(target)
        except TypeError:
            return (type(target).__name__, repr(target))
        return (type(target).__name__, target)

    def enqueue(self, urls, target=None):
        if not self.api_key:
            return
        for url in urls:
            if target is not None:
                targets = self.targets.setdefault(url, [])
                target_key = self._target_key(target)
                if not any(self._target_key(existing) == target_key for existing in targets):
                    targets.append(target)
            if url in self.seen:
                continue
            self.seen.add(url)
            self.queued_urls.append(url)

    async def _notify_failure(self, url, detail):
        if self.on_failure:
            try:
                await self.on_failure(url, detail, tuple(self.targets.get(url, ())))
            except Exception as error:
                self.log(f"Could not send failure notification for {url}: {error}", flush=True)

    async def drain(self):
        async with self.drain_lock:
            if self.authentication_error:
                raise self.authentication_error
            while self.queued_urls:
                batch, self.queued_urls = self.queued_urls[:1000], self.queued_urls[1000:]
                self.log(f"Checking {len(batch)} database URLs in parallel via dashboard...", flush=True)
                try:
                    results = await asyncio.to_thread(self._request_batch, batch)
                    if (not isinstance(results, list) or len(results) != len(batch)
                        or any(not isinstance(item, dict) or item.get("status") not in
                               {"added", "duplicate", "error"} for item in results)):
                        raise ValueError("Dashboard returned an incomplete bulk database result.")
                except DashboardAuthenticationError as error:
                    self.authentication_error = error
                    raise
                except Exception as error:
                    results = [{"url": url, "status": "error", "reason": str(error)} for url in batch]
                # Results retain input order; returned URLs may be normalized.
                for url, result in zip(batch, results):
                    if result.get("status") == "error":
                        detail = result.get("reason", "Database check failed.")
                        self.log(f"Dashboard rejected {url}: {detail}", flush=True)
                        self.seen.discard(url)
                        await self._notify_failure(url, detail)
                counts = {status: sum(item["status"] == status for item in results)
                          for status in ("added", "duplicate", "error")}
                self.log(f"Database batch complete: {counts['added']} added; "
                         f"{counts['duplicate']} duplicates; {counts['error']} failed.", flush=True)

    def _request_batch(self, urls):
        parts = urllib.parse.urlsplit(self._bulk_endpoint())
        query = dict(urllib.parse.parse_qsl(parts.query))
        query["api_key"] = self.api_key
        endpoint = urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))
        request = urllib.request.Request(
            endpoint,
            data=json.dumps({"databaseUrls": urls}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60 + 6 * len(urls)) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
                raise ValueError("Dashboard returned an invalid bulk database result.")
            return payload["results"]
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace").strip()
            if error.code in {401, 403}:
                try:
                    payload = json.loads(detail)
                except ValueError:
                    payload = {}
                if payload.get("code") == "AUTH_REQUIRED":
                    raise DashboardAuthenticationError(
                        "The dashboard returned AUTH_REQUIRED for /api/addDatabaseUrls. "
                        "It is running an older server.js; deploy the bulk endpoint and "
                        "restart the dashboard before restarting this exporter."
                    ) from error
                raise DashboardAuthenticationError(
                    f"Dashboard bulk endpoint rejected API-key authentication (HTTP {error.code}): {detail}. "
                    "Deploy the updated server.js and verify DASHBOARD_API_KEY."
                ) from error
            raise RuntimeError(f"Dashboard bulk check failed (HTTP {error.code}): {detail}") from error


def send_bot_message(token, chat_id, text):
    endpoint = f"https://api.telegram.org/bot{urllib.parse.quote(token, safe=':')}/sendMessage"
    request = urllib.request.Request(
        endpoint,
        data=urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Telegram Bot API HTTP {error.code}: {detail}") from error
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Telegram Bot API request failed: {error}") from error
    if not isinstance(result, dict) or result.get("ok") is not True:
        description = result.get("description") if isinstance(result, dict) else None
        raise RuntimeError("Telegram Bot API rejected the failure notice"
                           + (f": {description}" if description else "."))


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


class ChannelRouteWorker:
    def __init__(self, client, source, source_id, target, target_id, writer,
                 *, dashboard_queue=None, checkpoint_dir=".", start_from=1,
                 rescan=False, wait_time=1, log=print, preparation_barrier=None,
                 channel_link_file=None, link_report_sender=None):
        self.client = client
        self.source = source
        self.source_id = source_id
        self.target = target
        self.target_id = target_id
        self.writer = writer
        self.dashboard_queue = dashboard_queue
        self.cursor_key = f"route:{source_id}:{target_id}"
        safe_source = re.sub(r"[^A-Za-z0-9_-]+", "_", str(source_id)).strip("_")
        safe_target = re.sub(r"[^A-Za-z0-9_-]+", "_", str(target_id)).strip("_")
        self.checkpoint_path = Path(checkpoint_dir) / f"last_done_{safe_source}_{safe_target}.txt"
        file_cursor = self._read_checkpoint(start_from - 1)
        database_cursor = writer.cursor(self.cursor_key, start_from)
        self.cursor = start_from - 1 if rescan else max(database_cursor, file_cursor)
        if rescan:
            writer.save_cursor(self.cursor_key, self.cursor, reset=True)
            self._save_checkpoint(self.cursor)
        else:
            writer.save_cursor(self.cursor_key, self.cursor)
            if file_cursor != self.cursor:
                self._save_checkpoint(self.cursor)
        self.wait_time = wait_time
        self.log = log
        self.lock = asyncio.Lock()
        self.wake = asyncio.Event()
        self.preparation_barrier = preparation_barrier or RoutePreparationBarrier(1, log=log)
        self.preparation_marked = False
        self.sent_batch_files = {}
        self.channel_link_file = channel_link_file
        self.link_report_sender = link_report_sender

    async def _mark_prepared(self):
        if not self.preparation_marked:
            self.preparation_marked = True
            await self.preparation_barrier.mark_ready()

    async def _send_all_links_report(self):
        if self.channel_link_file and self.link_report_sender:
            await self.link_report_sender.send_latest(self.channel_link_file)

    async def _send_route_batches(self, history=()):
        await self.preparation_barrier.wait()
        candidates = sorted(self.writer.output_dir.glob("batch_*.txt"))
        files = []
        signatures = {}
        for path in candidates:
            signature = (path.stat().st_mtime_ns, path.stat().st_size)
            signatures[str(path)] = signature
            if self.sent_batch_files.get(str(path)) != signature:
                files.append(path)
        if not files:
            return 0
        if hasattr(self.client, "send_file"):
            self.log(
                f"Route {self.source_id} -> {self.target_id}: uploading "
                f"{len(files)} batch file(s) to Telegram...", flush=True,
            )
            for index in range(0, len(files), 10):
                await self.client.send_file(self.target, files[index:index + 10])
        else:
            # Synthetic clients used by the offline test suite have no upload API.
            # Production Telethon clients always use send_file above.
            for message in reversed(history):
                if not is_unforwardable_message(message):
                    await self.client.forward_messages(self.target, message)
            return 0
        self.sent_batch_files.update((str(path), signatures[str(path)]) for path in files)
        self.log(
            f"Route {self.source_id} -> {self.target_id}: sent "
            f"{len(files)} batch file(s) to Telegram.", flush=True,
        )
        return len(files)

    def _read_checkpoint(self, fallback):
        try:
            value = int(self.checkpoint_path.read_text(encoding="utf-8").strip())
            return max(0, value)
        except (OSError, ValueError):
            return fallback

    def _save_checkpoint(self, message_id):
        self.checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.checkpoint_path.with_name(self.checkpoint_path.name + ".tmp")
        temporary.write_text(str(message_id), encoding="utf-8")
        os.replace(temporary, self.checkpoint_path)

    async def scan(self):
        """Forward chronologically and checkpoint only after each delivery."""
        async with self.lock:
            newest = await self.client.get_messages(self.source, limit=1)
            if not newest:
                await self._mark_prepared()
                await self._send_all_links_report()
                await self._send_route_batches()
                return 0
            latest = newest[0].id
            if latest < self.cursor:
                raise IncompleteHistoryError(
                    f"Source {self.source_id} newest ID #{latest} is below route "
                    f"checkpoint #{self.cursor}."
                )
            if latest == self.cursor:
                await self._mark_prepared()
                await self._send_all_links_report()
                await self._send_route_batches()
                return 0
            # Telegram can return an empty page for a reverse iterator when
            # offset_id is the current newest post, even though the same
            # history is available through the normal newest-first iterator.
            # Read that reliable order, then replay the range oldest-first so
            # forwarding and checkpoints remain chronological.
            history = []
            fetched = 0
            self.log(
                f"Route {self.source_id} -> {self.target_id}: "
                f"scanning #{self.cursor + 1} through #{latest}...", flush=True,
            )
            async for message in self.client.iter_messages(
                self.source, limit=None, offset_id=latest + 1,
                min_id=self.cursor, reverse=False, wait_time=self.wait_time,
            ):
                if not self.cursor < message.id <= latest:
                    continue
                history.append(message)
                fetched += 1
                if fetched % 1000 == 0:
                    self.log(
                        f"Route {self.source_id} -> {self.target_id}: fetched "
                        f"{fetched} posts through #{message.id}; preparing delivery...",
                        flush=True,
                    )
            if not history:
                raise IncompleteHistoryError(
                    f"Source {self.source_id} reported post #{latest}, but its "
                    "history returned no messages after the route checkpoint. "
                    "The checkpoint was not advanced."
                )
            self.log(
                f"Route {self.source_id} -> {self.target_id}: fetched "
                f"{len(history)} posts; registering links before forwarding...", flush=True,
            )
            message_urls = []
            for message in history:
                urls = extract_database_urls(message)
                message_urls.append((message, urls))
                if self.channel_link_file:
                    self.channel_link_file.add_message(message.id, urls)
                self.writer.add_urls(urls)
                if self.dashboard_queue:
                    self.dashboard_queue.enqueue(urls, self.target)
            if self.dashboard_queue:
                await self.dashboard_queue.drain()
            self.log(
                f"Route {self.source_id} -> {self.target_id}: database registration "
                f"attempts complete; waiting for all routes...", flush=True,
            )
            await self._mark_prepared()
            await self._send_all_links_report()
            await self._send_route_batches(history)
            delivered = len(history)
            self.writer.save_cursor(self.cursor_key, latest)
            self._save_checkpoint(latest)
            self.cursor = latest
            self.log(
                f"Route {self.source_id} -> {self.target_id}: prepared "
                f"{delivered} posts; checkpoint #{self.cursor}; {self.writer.count} "
                "unique Firebase URLs saved.", flush=True,
            )
            return delivered

    async def notify(self, _event=None):
        self.wake.set()

    async def save_edited_links(self, event):
        urls = extract_database_urls(event.message)
        if self.channel_link_file:
            self.channel_link_file.add_edit(event.message.id, urls)
        self.writer.add_urls(urls)
        if self.dashboard_queue:
            self.dashboard_queue.enqueue(urls, self.target)
            await self.dashboard_queue.drain()
        await self._send_all_links_report()
        await self._send_route_batches()
        self.wake.set()

    async def run(self, flood_error, *, interval=10):
        route = f"{self.source_id} -> {self.target_id}"
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
                self.log(f"Route {route}: Telegram cooldown {error.seconds + 1}s.", flush=True)
                await asyncio.sleep(error.seconds + 1)
            except DashboardAuthenticationError as error:
                self.preparation_barrier.fail(error)
                self.log(f"Route {route}: stopping because dashboard authentication failed: {error}", flush=True)
                return
            except Exception as error:
                self.log(f"Route {route}: retry in {interval}s after {error}.", flush=True)
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


async def run(api_id, api_hash, routes, base_dir):
    from telethon import TelegramClient, events, utils
    from telethon.errors import FloodWaitError

    args = arguments(base_dir)
    dashboard_endpoint = os.getenv(
        "DASHBOARD_ADD_DATABASE_URL_ENDPOINT", "http://127.0.0.1:3000/api/addDatabaseUrl"
    )
    client = TelegramClient(str(base_dir / "userbot_session"), api_id, api_hash)
    bot_token = load_setting("DATABASE_FAILURE_BOT_TOKEN", base_dir)
    bot_chat_id = load_setting("DATABASE_FAILURE_BOT_CHAT_ID", base_dir)
    try:
        bot_alert_interval = float(load_setting(
            "DATABASE_FAILURE_BOT_INTERVAL_SECONDS", base_dir
        ) or "1.1")
    except ValueError:
        bot_alert_interval = 1.1
    bot_alert_interval = max(0.0, bot_alert_interval)
    bot_alert_lock = asyncio.Lock()
    bot_last_alert_at = 0.0
    bot_alert_disabled = False

    failure_reports = {}
    failure_reports_lock = asyncio.Lock()

    async def notify_database_failure(url, detail, targets):
        del targets
        async with failure_reports_lock:
            failure_reports.setdefault("items", []).append((url, detail))

    async def flush_failure_reports():
        nonlocal bot_last_alert_at, bot_alert_disabled
        async with failure_reports_lock:
            bot_items = take_failure_report_items(failure_reports)
        if bot_items:
            print(f"Database check finished with {len(bot_items)} failed URL(s).", flush=True)
        if bot_items and bot_token and bot_chat_id and not bot_alert_disabled:
            message = f"Database registration failures: {len(bot_items)} URL(s).\n"
            message += "\n".join(f"{url} - {detail[:250]}" for url, detail in bot_items[:40])
            if len(bot_items) > 40:
                message += f"\n...and {len(bot_items) - 40} more."
            try:
                async with bot_alert_lock:
                    if bot_last_alert_at:
                        delay = bot_alert_interval - (asyncio.get_running_loop().time() - bot_last_alert_at)
                        if delay > 0:
                            await asyncio.sleep(delay)
                    await asyncio.to_thread(send_bot_message, bot_token, bot_chat_id, message[:4000])
                    bot_last_alert_at = asyncio.get_running_loop().time()
            except RuntimeError as error:
                error_text = str(error)
                print(f"Could not send database failure summary to configured bot: {error_text}", flush=True)
                if " HTTP 400:" in error_text or " HTTP 401:" in error_text or " HTTP 403:" in error_text:
                    bot_alert_disabled = True
            except Exception as error:
                print(f"Could not send database failure summary to configured bot: "
                      f"{type(error).__name__}: {error}", flush=True)
        elif bot_items and not (bot_token and bot_chat_id):
            print("Bot summary not sent: DATABASE_FAILURE_BOT_TOKEN and/or "
                  "DATABASE_FAILURE_BOT_CHAT_ID is not configured.", flush=True)

    dashboard_queue = DashboardDatabaseQueue(
        dashboard_endpoint,
        load_setting("DASHBOARD_API_KEY", base_dir),
        on_failure=notify_database_failure,
    )
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
        if not routes:
            raise ValueError("Configure at least one source/target route in test.py.")
        resolved_routes = []
        skipped_routes = []
        for route in routes:
            source_ref = route["source"]
            target_ref = route["target"]
            try:
                source_entity = await resolve_route_entity(
                    client, source_ref, role="source channel", utils=utils
                )
                target_entity = await resolve_route_entity(
                    client, target_ref, role="target channel", utils=utils
                )
            except Exception as error:
                skipped_routes.append((source_ref, target_ref, str(error)))
                print(
                    f"Route skipped: {source_ref!r} -> {target_ref!r}: {error}",
                    flush=True,
                )
                continue
            source_id = utils.get_peer_id(source_entity)
            target_id = utils.get_peer_id(target_entity)
            resolved_routes.append((source_entity, source_id, target_entity, target_id))
            print(
                f"Route ready: {getattr(source_entity, 'title', source_id)} "
                f"({source_id}) -> {getattr(target_entity, 'title', target_id)} "
                f"({target_id})", flush=True,
            )
        if skipped_routes:
            print(
                f"Skipped {len(skipped_routes)} route(s); continuing with "
                f"{len(resolved_routes)} available route(s).", flush=True,
            )
        if not resolved_routes:
            raise RuntimeError("No configured route could be resolved; nothing to start.")
        batch_writers = []
        batch_root = Path(args.output_dir)
        try:
            all_links_target = await resolve_route_entity(
                client, -1004492989164, role="all-links report channel", utils=utils
            )
            all_links_sender = ChannelLinkReportSender(client, all_links_target)
        except Exception as error:
            all_links_sender = None
            print(f"All-links report upload disabled: {error}", flush=True)
        channel_link_files = {}
        barrier = RoutePreparationBarrier(
            len(resolved_routes), on_complete=flush_failure_reports
        )
        for _source_entity, source_id, _target_entity, target_id in resolved_routes:
            route_folder = batch_root / f"route_{source_id}_{target_id}"
            route_writer = FirebaseBatchWriter(route_folder, args.batch_size)
            batch_writers.append(route_writer)
        try:
            workers = []
            handlers = []
            for (source_entity, source_id, target_entity, target_id), route_writer in zip(
                resolved_routes, batch_writers
            ):
                channel_link_file = channel_link_files.setdefault(
                    source_id, ChannelLinkFile(batch_root, source_id)
                )
                history_wait_time = float(os.getenv("TELEGRAM_HISTORY_WAIT_TIME", "0.25"))
                if not math.isfinite(history_wait_time) or history_wait_time < 0:
                    raise ValueError("TELEGRAM_HISTORY_WAIT_TIME must be a non-negative number.")
                route_worker = ChannelRouteWorker(
                    client, source_entity, source_id, target_entity, target_id, route_writer,
                    dashboard_queue=dashboard_queue,
                    checkpoint_dir=base_dir,
                    start_from=args.from_id, rescan=args.rescan,
                    wait_time=history_wait_time,
                    preparation_barrier=barrier,
                    channel_link_file=channel_link_file,
                    link_report_sender=all_links_sender,
                )
                new_handler = route_worker.notify
                edit_handler = route_worker.save_edited_links
                new_event = events.NewMessage(chats=source_entity)
                edit_event = events.MessageEdited(chats=source_entity)
                client.add_event_handler(new_handler, new_event)
                client.add_event_handler(edit_handler, edit_event)
                handlers.extend([(new_handler, new_event), (edit_handler, edit_event)])
                workers.append(asyncio.create_task(
                    route_worker.run(FloodWaitError, interval=args.poll_interval),
                    name=f"route-{source_id}-to-{target_id}",
                ))
            print(
                f"Started {len(workers)} route workers. Route batch output: {batch_root}; "
                f"{args.batch_size} links per file; "
                f"{sum(writer.count for writer in batch_writers)} route URL entries already saved "
                "(summed per route; cross-route duplicates count more than once).",
                flush=True,
            )
            disconnected = asyncio.ensure_future(client.disconnected)
            try:
                done, _pending = await asyncio.wait(
                    [*workers, disconnected], return_when=asyncio.FIRST_COMPLETED,
                )
                for worker in workers:
                    if worker in done:
                        await worker
            finally:
                for handler, event_type in handlers:
                    client.remove_event_handler(handler, event_type)
                for worker in workers:
                    worker.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
                await dashboard_queue.drain()
                print(f"Workers stopped. {sum(writer.count for writer in batch_writers)} route URL entries saved "
                      "(summed per route; cross-route duplicates count more than once).", flush=True)
        finally:
            for writer in batch_writers:
                writer.close()
    finally:
        await client.disconnect()
