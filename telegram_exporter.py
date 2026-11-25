"""Export every Firebase database URL in Telegram history to local TXT batches."""
import argparse
import asyncio
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
            if url not in urls:
                urls.append(url)
    return urls


class IncompleteHistoryError(RuntimeError):
    pass


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
    def __init__(self, endpoint, api_key, *, concurrency=4, on_failure=None, log=print):
        self.endpoint = endpoint
        self.api_key = api_key
        self.slots = asyncio.Semaphore(concurrency)
        self.log = log
        self.seen = set()
        self.pending = set()
        self.targets = {}
        self.on_failure = on_failure

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
            task = asyncio.create_task(self._submit(url))
            self.pending.add(task)
            task.add_done_callback(self.pending.discard)

    def _request(self, url):
        parts = urllib.parse.urlsplit(self.endpoint)
        query = dict(urllib.parse.parse_qsl(parts.query))
        query["api_key"] = self.api_key
        endpoint = urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))
        request = urllib.request.Request(
            endpoint,
            data=json.dumps({"databaseUrl": url}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            response.read()

    async def _submit(self, url):
        try:
            async with self.slots:
                await asyncio.to_thread(self._request, url)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace").strip()
            self.log(f"Dashboard rejected {url} (HTTP {error.code}): {detail}", flush=True)
            self.seen.discard(url)
            await self._notify_failure(url, f"HTTP {error.code}: {detail}")
        except (OSError, ValueError) as error:
            self.log(f"Could not add database URL {url}: {error}", flush=True)
            self.seen.discard(url)
            await self._notify_failure(url, str(error))

    async def _notify_failure(self, url, detail):
        if self.on_failure:
            try:
                await self.on_failure(url, detail, tuple(self.targets.get(url, ())))
            except Exception as error:
                self.log(f"Could not send failure notification for {url}: {error}", flush=True)

    async def drain(self):
        if self.pending:
            await asyncio.gather(*tuple(self.pending), return_exceptions=True)


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
                 rescan=False, wait_time=1, log=print):
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
                return 0
            latest = newest[0].id
            if latest < self.cursor:
                raise IncompleteHistoryError(
                    f"Source {self.source_id} newest ID #{latest} is below route "
                    f"checkpoint #{self.cursor}."
                )
            if latest == self.cursor:
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
                f"{len(history)} posts; forwarding oldest-first...", flush=True,
            )
            delivered = 0
            for message in reversed(history):
                urls = extract_database_urls(message)
                self.writer.add_urls(urls)
                if self.dashboard_queue:
                    self.dashboard_queue.enqueue(urls, self.target)
                if is_unforwardable_message(message):
                    self.log(
                        f"Route {self.source_id} -> {self.target_id}: skipped "
                        f"unforwardable Telegram {type(message).__name__} #{message.id}.",
                        flush=True,
                    )
                else:
                    await self.client.forward_messages(self.target, message)
                self.writer.save_cursor(self.cursor_key, message.id)
                self._save_checkpoint(message.id)
                self.cursor = message.id
                delivered += 1
            self.log(
                f"Route {self.source_id} -> {self.target_id}: delivered "
                f"{delivered}; checkpoint #{self.cursor}; {self.writer.count} "
                "unique Firebase URLs saved.", flush=True,
            )
            return delivered

    def notify(self, _event=None):
        self.wake.set()

    async def save_edited_links(self, event):
        urls = extract_database_urls(event.message)
        self.writer.add_urls(urls)
        if self.dashboard_queue:
            self.dashboard_queue.enqueue(urls, self.target)
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

    async def notify_database_failure(url, detail, targets):
        nonlocal bot_last_alert_at, bot_alert_disabled
        message = f"Database registration failed.\n{url}\n{detail[:2000]}"
        for target in targets:
            try:
                await client.send_message(target, message)
            except Exception as error:
                print(f"Could not notify target {target} about {url}: {error}", flush=True)
        if bot_token and bot_chat_id and not bot_alert_disabled:
            try:
                async with bot_alert_lock:
                    if bot_last_alert_at:
                        delay = bot_alert_interval - (asyncio.get_running_loop().time() - bot_last_alert_at)
                        if delay > 0:
                            await asyncio.sleep(delay)
                    await asyncio.to_thread(send_bot_message, bot_token, bot_chat_id, message)
                    bot_last_alert_at = asyncio.get_running_loop().time()
            except RuntimeError as error:
                error_text = str(error)
                print(f"Could not send database failure to configured bot: {error_text}", flush=True)
                if " HTTP 400:" in error_text or " HTTP 401:" in error_text or " HTTP 403:" in error_text:
                    bot_alert_disabled = True
            except Exception as error:
                print("Could not send database failure to configured bot: "
                      f"{type(error).__name__}: {error}", flush=True)
        else:
            print("Bot failure alerts disabled; set DATABASE_FAILURE_BOT_TOKEN and "
                  "DATABASE_FAILURE_BOT_CHAT_ID in .env.", flush=True)

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
        for route in routes:
            source_ref = route["source"]
            target_ref = route["target"]
            source_entity = await resolve_route_entity(
                client, source_ref, role="source channel", utils=utils
            )
            target_entity = await resolve_route_entity(
                client, target_ref, role="target channel", utils=utils
            )
            source_id = utils.get_peer_id(source_entity)
            target_id = utils.get_peer_id(target_entity)
            resolved_routes.append((source_entity, source_id, target_entity, target_id))
            print(
                f"Route ready: {getattr(source_entity, 'title', source_id)} "
                f"({source_id}) -> {getattr(target_entity, 'title', target_id)} "
                f"({target_id})", flush=True,
            )
        with FirebaseBatchWriter(args.output_dir, args.batch_size) as writer:
            workers = []
            handlers = []
            for source_entity, source_id, target_entity, target_id in resolved_routes:
                history_wait_time = float(os.getenv("TELEGRAM_HISTORY_WAIT_TIME", "0.25"))
                if not math.isfinite(history_wait_time) or history_wait_time < 0:
                    raise ValueError("TELEGRAM_HISTORY_WAIT_TIME must be a non-negative number.")
                route_worker = ChannelRouteWorker(
                    client, source_entity, source_id, target_entity, target_id, writer,
                    dashboard_queue=dashboard_queue,
                    checkpoint_dir=base_dir,
                    start_from=args.from_id, rescan=args.rescan,
                    wait_time=history_wait_time,
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
                f"Started {len(workers)} route workers. Output: {writer.output_dir}; "
                f"{args.batch_size} links per batch; {writer.count} unique links already saved.",
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
                print(f"Workers stopped. {writer.count} unique links saved.", flush=True)
    finally:
        await client.disconnect()
