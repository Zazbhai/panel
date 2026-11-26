"""Offline export regressions: no Telegram login, provider or dashboard calls."""
import asyncio
import io
from pathlib import Path
import sys
import tempfile
import threading
import time
import urllib.error
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from firebase_batches import FirebaseBatchWriter
import import_firebase_batches as batch_importer
import audit_firebase_batches as batch_audit
from telegram_exporter import (
    ChannelRouteWorker, DashboardDatabaseQueue, HistoryExporter,
    DashboardAuthenticationError, IncompleteHistoryError, RoutePreparationBarrier,
    extract_database_urls, resolve_route_entity, take_failure_report_items,
)


def message(number, text=None, **kwargs):
    return SimpleNamespace(
        id=number,
        text=text if text is not None else f"https://fixture-{number}.firebaseio.com/",
        **kwargs,
    )


class FakeClient:
    def __init__(self, messages):
        self.messages = list(messages)
        self.pages = 0
        self.interrupt_at = None
        self.during = None
        self.iterations = 0
        self.connected = True

    async def get_messages(self, _source, limit):
        assert limit == 1
        return sorted(self.messages, key=lambda msg: msg.id, reverse=True)[:1]

    async def iter_messages(self, _source, *, limit, offset_id, min_id, reverse, wait_time):
        assert limit is None
        assert wait_time >= 0
        self.iterations += 1
        snapshot = sorted(self.messages, key=lambda msg: msg.id, reverse=not reverse)
        eligible = [msg for msg in snapshot if min_id < msg.id < offset_id]
        for index, msg in enumerate(eligible):
            if index % 100 == 0:
                self.pages += 1
            if self.interrupt_at == index:
                raise SyntheticFloodWait(0)
            if self.during is not None:
                callback, self.during = self.during, None
                callback()
            yield msg

    def is_connected(self):
        return self.connected


class SyntheticFloodWait(Exception):
    def __init__(self, seconds):
        self.seconds = seconds


class ExtractionTests(unittest.TestCase):
    def test_all_urls_markdown_escapes_hidden_links_and_buttons(self):
        msg = message(
            1, r"**https\://ONE.firebaseio.com/** and "
            "https://two.europe-west1.firebasedatabase.app/path.json?x=1.",
            entities=[SimpleNamespace(url="https://hidden.firebaseio.com")],
            buttons=[[SimpleNamespace(url="https://button.firebaseio.com/")]],
        )
        self.assertEqual(extract_database_urls(msg), [
            "https://one.firebaseio.com/",
            "https://two.europe-west1.firebasedatabase.app/path.json?x=1",
            "https://hidden.firebaseio.com/",
            "https://button.firebaseio.com/",
        ])

    def test_duplicate_plain_root_and_trailing_slash(self):
        self.assertEqual(extract_database_urls(message(
            1, "https://one.firebaseio.com https://one.firebaseio.com/"
        )), ["https://one.firebaseio.com/"])

    def test_punctuation_no_urls_and_non_firebase_domains(self):
        self.assertEqual(extract_database_urls(message(
            1, "https://one.firebaseio.com. https://foo.firebaseio.com.evil/ "
            "https://notfirebase.com"
        )), ["https://one.firebaseio.com/"])
        self.assertEqual(extract_database_urls(message(1, "")), [])


class EntityResolutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_numeric_id_falls_back_to_visible_dialogs(self):
        entity = SimpleNamespace(id=123, title="Source")

        class Client:
            async def get_entity(self, _reference):
                raise ValueError("not cached")

            async def iter_dialogs(self, limit=None):
                yield SimpleNamespace(entity=entity)

        class Utils:
            @staticmethod
            def get_peer_id(value):
                return value.id

        resolved = await resolve_route_entity(Client(), 123, role="source channel", utils=Utils)
        self.assertIs(resolved, entity)

    async def test_missing_channel_has_actionable_error(self):
        class Client:
            async def get_entity(self, _reference):
                raise ValueError("not cached")

            async def iter_dialogs(self, limit=None):
                if False:
                    yield None

        class Utils:
            @staticmethod
            def get_peer_id(value):
                return value.id

        with self.assertRaisesRegex(RuntimeError, "must be a member"):
            await resolve_route_entity(Client(), -100123, role="source channel", utils=Utils)

    async def test_route_setup_can_skip_one_unresolved_route(self):
        routes = [("missing", "target"), ("source", "target")]
        resolved = []
        skipped = []

        async def resolve(reference, role):
            if reference == "missing":
                raise RuntimeError(f"Could not resolve {role} {reference!r}")
            return reference

        for source, target in routes:
            try:
                resolved.append((await resolve(source, "source channel"),
                                 await resolve(target, "target channel")))
            except Exception as error:
                skipped.append((source, target, str(error)))
        self.assertEqual(resolved, [("source", "target")])
        self.assertEqual(len(skipped), 1)


class RoutePreparationBarrierTests(unittest.IsolatedAsyncioTestCase):
    async def test_notification_failure_does_not_hold_batch_delivery_barrier(self):
        async def fail_summary():
            raise RuntimeError("Telegram FloodWait")

        barrier = RoutePreparationBarrier(2, log=lambda *_args, **_kwargs: None,
                                          on_complete=fail_summary)
        await barrier.mark_ready()
        self.assertFalse(barrier.event.is_set())
        await barrier.mark_ready()
        await asyncio.wait_for(barrier.wait(), timeout=0.1)
        self.assertTrue(barrier.event.is_set())

    async def test_failure_report_list_is_drained_without_dict_assumption(self):
        state = {"items": [("https://bad.firebaseio.com/", "HTTP 423") ]}
        self.assertEqual(take_failure_report_items(state), [("https://bad.firebaseio.com/", "HTTP 423")])
        self.assertEqual(state, {})


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.directory = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def files(self):
        return sorted(p.name for p in self.directory.glob("batch_*.txt"))

    def test_exact_batch_names_counts_and_custom_size(self):
        with FirebaseBatchWriter(self.directory, 1000) as writer:
            urls = [f"https://fixture-{i}.firebaseio.com/" for i in range(2505)]
            self.assertEqual(writer.add_urls(urls), 2505)
            self.assertEqual(self.files(), [
                "batch_0001 - 1000 links.txt",
                "batch_0002 - 1000 links.txt",
                "batch_0003 - 505 links.txt",
            ])
            all_lines = []
            for file_path in sorted(self.directory.glob("batch_*.txt")):
                all_lines.extend(file_path.read_text(encoding="utf-8").splitlines())
            self.assertEqual(all_lines, urls)

    def test_deduplicates_and_continues_partial_batch_after_restart(self):
        with FirebaseBatchWriter(self.directory, 2) as writer:
            self.assertEqual(writer.add_urls(["a", "b", "b", "c"]), 3)
        with FirebaseBatchWriter(self.directory, 2) as writer:
            self.assertEqual(writer.add_urls(["c", "d", "e"]), 2)
            self.assertEqual(writer.count, 5)
            self.assertEqual(self.files(), [
                "batch_0001 - 2 links.txt", "batch_0002 - 2 links.txt",
                "batch_0003 - 1 links.txt",
            ])

    def test_missing_txt_is_rebuilt_and_wrong_batch_size_is_rejected(self):
        with FirebaseBatchWriter(self.directory, 2) as writer:
            writer.add_urls(["a", "b", "c"])
        (self.directory / "batch_0001 - 2 links.txt").unlink()
        with FirebaseBatchWriter(self.directory, 2):
            self.assertTrue((self.directory / "batch_0001 - 2 links.txt").exists())
        with self.assertRaises(ValueError):
            FirebaseBatchWriter(self.directory, 1000)

    def test_failed_txt_write_rolls_back_url_and_does_not_advance_checkpoint(self):
        with FirebaseBatchWriter(self.directory, 2) as writer:
            with patch("firebase_batches.atomic_text", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    writer.add_urls(["a"])
            self.assertEqual(writer.count, 0)
            self.assertEqual(writer.cursor("source"), 0)
            writer.add_urls(["a"])
            self.assertEqual(writer.count, 1)

    def test_cursors_are_channel_specific_monotonic_and_can_explicitly_reset(self):
        with FirebaseBatchWriter(self.directory) as writer:
            writer.save_cursor("a", 100)
            writer.save_cursor("a", 2)
            self.assertEqual(writer.cursor("a"), 100)
            self.assertEqual(writer.cursor("b"), 0)
            writer.save_cursor("a", 0, reset=True)
            self.assertEqual(writer.cursor("a"), 0)


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asyncio.get_running_loop().slow_callback_duration = 10
        self.folder = tempfile.TemporaryDirectory()
        self.directory = Path(self.folder.name)
        self.writer = FirebaseBatchWriter(self.directory, 1000)

    async def asyncTearDown(self):
        self.writer.close()
        self.folder.cleanup()

    def exporter(self, client, **kwargs):
        return HistoryExporter(
            client, "source", "source-id", self.writer,
            wait_time=0, log=lambda *_args, **_kwargs: None, **kwargs,
        )

    async def test_all_pages_beyond_3861_are_saved_and_resume_skips_no_ids(self):
        client = FakeClient([message(i) for i in range(1, 4206)])
        self.writer.save_cursor("source-id", 3860)
        exporter = self.exporter(client)
        self.assertEqual(await exporter.scan(), 345)
        self.assertEqual(self.writer.count, 345)
        self.assertEqual(self.writer.cursor("source-id"), 4205)
        self.assertEqual(client.pages, 4)
        self.assertEqual(await self.exporter(client).scan(), 0)
        client.messages.extend([message(4210), message(4220)])  # deleted/sparse IDs
        self.assertEqual(await self.exporter(client).scan(), 2)
        self.assertEqual(self.writer.count, 347)

    async def test_fresh_export_does_not_inherit_forwarding_checkpoint(self):
        (self.directory / "last_done.txt").write_text("9999", encoding="utf-8")
        client = FakeClient([message(1), message(3861), message(4001)])
        await self.exporter(client).scan()
        self.assertEqual(self.writer.count, 3)

    async def test_flood_wait_replays_incomplete_pass_without_skipping_or_duplicates(self):
        client = FakeClient([message(i) for i in range(1, 206)])
        client.interrupt_at = 100
        exporter = self.exporter(client)
        with self.assertRaises(SyntheticFloodWait):
            await exporter.scan()
        self.assertEqual(self.writer.count, 100)
        self.assertEqual(self.writer.cursor("source-id"), 0)
        client.interrupt_at = None
        await self.exporter(client).scan()
        self.assertEqual(self.writer.count, 205)
        self.assertEqual(self.writer.cursor("source-id"), 205)

    async def test_live_event_during_history_does_not_advance_checkpoint_past_backlog(self):
        client = FakeClient([message(i) for i in range(1, 201)])
        exporter = self.exporter(client)

        def new_message():
            client.messages.append(message(201))
            exporter.wake.set()
            self.assertEqual(self.writer.cursor("source-id"), 0)

        client.during = new_message
        await exporter.scan()
        self.assertEqual(self.writer.cursor("source-id"), 200)
        self.assertEqual(self.writer.count, 200)
        self.assertTrue(exporter.wake.is_set())
        await exporter.scan()
        self.assertEqual(self.writer.count, 201)

    async def test_empty_inconsistent_history_does_not_claim_completion(self):
        client = FakeClient([message(4000)])

        async def empty(*_args, **_kwargs):
            if False:
                yield

        client.iter_messages = empty
        with self.assertRaises(IncompleteHistoryError):
            await self.exporter(client).scan()
        self.assertEqual(self.writer.cursor("source-id"), 0)

    async def test_service_posts_and_multiple_links_advance_only_after_complete_scan(self):
        client = FakeClient([
            message(1, "", action="joined"),
            message(2, "https://one.firebaseio.com/ https://two.firebaseio.com/"),
            message(3, "no links"),
        ])
        await self.exporter(client).scan()
        self.assertEqual(self.writer.count, 2)
        self.assertEqual(self.writer.cursor("source-id"), 3)

    async def test_rescan_recovers_older_missing_links_without_duplicate_output(self):
        client = FakeClient([message(100), message(200)])
        await self.exporter(client).scan()
        client.messages.append(message(50))
        self.assertEqual(await self.exporter(client).scan(), 0)
        await self.exporter(client, rescan=True).scan()
        self.assertEqual(self.writer.count, 3)

    async def test_polling_catches_posts_without_a_live_notification(self):
        client = FakeClient([message(1)])
        exporter = self.exporter(client)
        original_scan = exporter.scan
        passes = 0

        async def scan():
            nonlocal passes
            await original_scan()
            passes += 1
            if passes == 1:
                client.messages.append(message(2))
            else:
                client.connected = False

        exporter.scan = scan
        await exporter.run(SyntheticFloodWait, interval=0.001)
        self.assertEqual(self.writer.count, 2)
        self.assertEqual(self.writer.cursor("source-id"), 2)


class RouteWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.writer = FirebaseBatchWriter(Path(self.folder.name), 1000)

    async def asyncTearDown(self):
        self.writer.close()
        self.folder.cleanup()

    async def test_multiple_targets_run_independently_with_route_cursors(self):
        source = "source"
        messages = [message(1, "https://one.firebaseio.com https://two.firebaseio.com"),
                    message(2, "no URL")]
        messages[0].entities = [SimpleNamespace(url="https://hidden.three.firebaseio.com")]

        class RecordingDashboardQueue:
            def __init__(self):
                self.submissions = []

            def enqueue(self, urls, target):
                self.submissions.append((target, list(urls)))

            async def drain(self):
                return None

        class RouteClient(FakeClient):
            def __init__(self):
                super().__init__(messages)
                self.deliveries = []
                self.sent_files = []
                self.active_forwards = 0
                self.peak_forwards = 0

            async def forward_messages(self, target, msg):
                self.active_forwards += 1
                self.peak_forwards = max(self.peak_forwards, self.active_forwards)
                await asyncio.sleep(0.001)
                self.deliveries.append((target, msg.id))
                self.active_forwards -= 1

            async def send_file(self, target, files):
                self.sent_files.append((target, [Path(file).name for file in files]))

            async def iter_messages(self, entity, **kwargs):
                assert entity == source
                async for item in super().iter_messages(entity, **kwargs):
                    yield item

        client = RouteClient()
        dashboard = RecordingDashboardQueue()
        first = ChannelRouteWorker(client, source, "source-id", "target-a", "target-a-id", self.writer,
                                   dashboard_queue=dashboard, checkpoint_dir=self.folder.name, wait_time=0,
                                   log=lambda *_args, **_kwargs: None)
        second = ChannelRouteWorker(client, source, "source-id", "target-b", "target-b-id", self.writer,
                                    dashboard_queue=dashboard, checkpoint_dir=self.folder.name, wait_time=0,
                                    log=lambda *_args, **_kwargs: None)
        await asyncio.gather(first.scan(), second.scan())
        self.assertEqual(client.deliveries, [], "Prepared history should be sent as files, not forwarded message-by-message")
        self.assertEqual({target for target, _files in client.sent_files}, {"target-a", "target-b"})
        self.assertTrue(all(files for _target, files in client.sent_files))
        self.assertEqual(self.writer.cursor("route:source-id:target-a-id"), 2)
        self.assertEqual(self.writer.cursor("route:source-id:target-b-id"), 2)
        self.assertEqual((Path(self.folder.name) / "last_done_source-id_target-a-id.txt").read_text(), "2")
        self.assertEqual((Path(self.folder.name) / "last_done_source-id_target-b-id.txt").read_text(), "2")
        self.assertEqual(self.writer.count, 3, "Every link in a message should be exported")
        expected_urls = [
            "https://one.firebaseio.com/",
            "https://two.firebaseio.com/",
            "https://hidden.three.firebaseio.com/",
        ]
        self.assertEqual(extract_database_urls(messages[0]), expected_urls)
        self.assertCountEqual(dashboard.submissions, [
            ("target-a", expected_urls), ("target-b", expected_urls),
            ("target-a", []), ("target-b", []),
        ], "Every message URL should be submitted for every configured route")
        self.assertEqual(len(client.sent_files), 2, "Each route should deliver its own batch files")

    async def test_all_links_register_before_first_forward(self):
        source = "source"
        messages = [message(1, "https://one.firebaseio.com"), message(2, "https://two.firebaseio.com")]
        events = []

        class OrderedDashboardQueue:
            def enqueue(self, urls, target):
                events.append(("enqueue", target, list(urls)))

            async def drain(self):
                events.append(("drain",))

        class OrderedClient(FakeClient):
            async def send_file(self, target, files):
                events.append(("send_files", len(files)))

        client = OrderedClient(messages)
        worker = ChannelRouteWorker(client, source, "source-id", "target", "target-id", self.writer,
                                    dashboard_queue=OrderedDashboardQueue(), checkpoint_dir=self.folder.name,
                                    wait_time=0, log=lambda *_args, **_kwargs: None)
        await worker.scan()
        self.assertEqual([item[0] for item in events],
                         ["enqueue", "enqueue", "drain", "send_files"])

    async def test_new_message_updates_each_route_batch_after_registration(self):
        source = "source"
        client = FakeClient([message(1, "https://initial.firebaseio.com/")])
        client.sent_files = []
        client.send_file = lambda target, files: None

        async def send_file(target, files):
            client.sent_files.append((target, [Path(path).name for path in files]))

        client.send_file = send_file

        class Dashboard:
            def __init__(self):
                self.registered = []
                self.events = []

            def enqueue(self, urls, target):
                self.events.extend(("enqueue", target, url) for url in urls)

            async def drain(self):
                self.events.append(("drain",))

        dashboard = Dashboard()
        first_writer = FirebaseBatchWriter(Path(self.folder.name) / "route-a", 1000)
        second_writer = FirebaseBatchWriter(Path(self.folder.name) / "route-b", 1000)
        try:
            first = ChannelRouteWorker(client, source, "source-id", "target-a", "target-a-id", first_writer,
                                       dashboard_queue=dashboard, checkpoint_dir=self.folder.name,
                                       wait_time=0, log=lambda *_args, **_kwargs: None)
            second = ChannelRouteWorker(client, source, "source-id", "target-b", "target-b-id", second_writer,
                                        dashboard_queue=dashboard, checkpoint_dir=self.folder.name,
                                        wait_time=0, log=lambda *_args, **_kwargs: None)
            await asyncio.gather(first.scan(), second.scan())
            initial_send_count = len(client.sent_files)
            new_post = message(2, "Fresh database: https://future.firebaseio.com/")
            client.messages.append(new_post)
            first.notify(new_post)
            second.notify(new_post)
            self.assertTrue(first.wake.is_set() and second.wake.is_set())
            dashboard.events.clear()
            await asyncio.gather(first.scan(), second.scan())
            self.assertEqual(first_writer.count, 2)
            self.assertEqual(second_writer.count, 2)
            self.assertEqual(first.cursor, 2)
            self.assertEqual(second.cursor, 2)
            self.assertEqual(len(client.sent_files), initial_send_count + 2)
            for target in ("target-a", "target-b"):
                route_sends = [entry for entry in client.sent_files if entry[0] == target]
                self.assertEqual(len(route_sends), 2)
                database_events = [i for i, event in enumerate(dashboard.events)
                                   if event[0] == "enqueue" and event[1] == target]
                file_events = [i for i, event in enumerate(dashboard.events) if event[0] == "drain"]
                self.assertTrue(database_events and file_events)
                self.assertGreater(file_events[-1], max(database_events),
                                   "Database registration must complete before updated route files send")
        finally:
            first_writer.close()
            second_writer.close()

    async def test_route_checkpoints_only_messages_successfully_forwarded(self):
        source = "source"
        messages = [message(1), message(2), message(3)]

        class FlakyRouteClient(FakeClient):
            def __init__(self):
                super().__init__(messages)
                self.fail_once = True
                self.deliveries = []

            async def send_file(self, target, files):
                if self.fail_once:
                    self.fail_once = False
                    raise SyntheticFloodWait(0)
                self.deliveries.append((target, [Path(file).name for file in files]))

        client = FlakyRouteClient()
        worker = ChannelRouteWorker(client, source, "source-id", "target", "target-id", self.writer,
                                    checkpoint_dir=self.folder.name, wait_time=0,
                                    log=lambda *_args, **_kwargs: None)
        with self.assertRaises(SyntheticFloodWait):
            await worker.scan()
        self.assertEqual(worker.cursor, 0)
        self.assertEqual(self.writer.cursor(worker.cursor_key), 0)
        checkpoint = Path(self.folder.name) / "last_done_source-id_target-id.txt"
        self.assertFalse(checkpoint.exists(), "A failed batch upload must not create a completed checkpoint")
        await worker.scan()
        self.assertEqual(len(client.deliveries), 1)
        self.assertEqual(worker.cursor, 3)
        self.assertEqual(checkpoint.read_text(), "3")

    async def test_route_uses_reliable_history_order_when_reverse_slice_is_empty(self):
        source = "source"
        messages = [message(1), message(2), message(3)]

        class ReverseBrokenClient(FakeClient):
            def __init__(self, messages):
                super().__init__(messages)
                self.deliveries = []

            async def forward_messages(self, target, msg):
                self.deliveries.append((target, msg.id))

            async def iter_messages(self, entity, **kwargs):
                if kwargs["reverse"]:
                    if False:
                        yield None
                    return
                async for item in super().iter_messages(entity, **kwargs):
                    yield item

        client = ReverseBrokenClient(messages)
        worker = ChannelRouteWorker(client, source, "source-id", "target", "target-id", self.writer,
                                    checkpoint_dir=self.folder.name, wait_time=0,
                                    log=lambda *_args, **_kwargs: None)
        await worker.scan()
        self.assertEqual(worker.cursor, 3)
        self.assertEqual([item[1] for item in client.deliveries], [1, 2, 3])

    async def test_route_skips_service_messages_and_continues_checkpoint(self):
        source = "source"
        # Use a named type so the production type-name guard matches Telethon.
        ServiceMessage = type("MessageService", (), {})
        service = ServiceMessage()
        service.id = 2
        service.text = ""
        messages = [message(1), service, message(3)]

        class RouteClient(FakeClient):
            def __init__(self, items):
                super().__init__(items)
                self.deliveries = []

            async def forward_messages(self, target, msg):
                self.deliveries.append((target, msg.id))

        client = RouteClient(messages)
        worker = ChannelRouteWorker(client, source, "source-id", "target", "target-id", self.writer,
                                    checkpoint_dir=self.folder.name, wait_time=0,
                                    log=lambda *_args, **_kwargs: None)
        await worker.scan()
        self.assertEqual(worker.cursor, 3)
        self.assertEqual([item[1] for item in client.deliveries], [1, 3])


class DashboardQueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_bulk_http_payload_and_per_url_errors(self):
        requests = []
        queue = DashboardDatabaseQueue("http://fixture/api/addDatabaseUrl", "synthetic-key",
                                       log=lambda *_args, **_kwargs: None)
        urls = ["https://good.firebaseio.com/", "https://locked.firebaseio.com/"]
        results = [{"url": urls[0].rstrip("/"), "status": "added"},
                   {"url": urls[1].rstrip("/"), "status": "error", "reason": "Firebase HTTP 423"}]

        def respond(request, timeout):
            import json
            requests.append(request)
            self.assertEqual(json.loads(request.data), {"databaseUrls": urls})
            self.assertIn("/api/addDatabaseUrls?api_key=synthetic-key", request.full_url)
            return io.BytesIO(json.dumps({"results": results}).encode())

        failures = []

        async def notify(url, reason, targets):
            failures.append((url, reason, targets))

        queue.on_failure = notify
        queue.enqueue(urls, "target")
        with patch("urllib.request.urlopen", side_effect=respond):
            await queue.drain()
        self.assertEqual(len(requests), 1)
        self.assertEqual(failures, [(urls[1], "Firebase HTTP 423", ("target",))])
        self.assertIn(urls[0], queue.seen)
        self.assertNotIn(urls[1], queue.seen)

    async def test_old_dashboard_bulk_auth_error_is_fatal_not_per_url(self):
        queue = DashboardDatabaseQueue("http://fixture/api/addDatabaseUrl", "key",
                                       log=lambda *_args, **_kwargs: None)
        queue.enqueue(["https://firebase.firebaseio.com/"])

        def reject(_request, timeout):
            error = urllib.error.HTTPError("http://fixture", 401, "unauthorized", {},
                io.BytesIO(b'{"error":"Admin login is required.","code":"AUTH_REQUIRED"}'))
            raise error

        with self.assertRaisesRegex(DashboardAuthenticationError, "older server.js"):
            with patch("urllib.request.urlopen", side_effect=reject):
                await queue.drain()
        self.assertTrue(queue.authentication_error)

    async def test_dashboard_url_checks_are_deduplicated_and_bounded(self):
        queue = DashboardDatabaseQueue("http://fixture/api/addDatabaseUrl", "key",
                                       log=lambda *_args, **_kwargs: None)
        batches = []

        def request(urls):
            batches.append(list(urls))
            return [{"url": url.rstrip("/"), "status": "added"} for url in urls]

        queue._request_batch = request
        urls = [f"https://db-{index}.firebaseio.com/" for index in range(2501)]
        queue.enqueue(urls[:3])
        queue.enqueue(urls[1:])
        await asyncio.gather(queue.drain(), queue.drain())
        self.assertEqual([len(batch) for batch in batches], [1000, 1000, 501])
        self.assertEqual([url for batch in batches for url in batch], urls)
        self.assertEqual(len(queue.seen), len(urls), "Normalized response URLs must match their inputs")
        self.assertEqual(queue._bulk_endpoint(), "http://fixture/api/addDatabaseUrls")

    async def test_failed_database_notifies_all_route_targets(self):
        notifications = []

        async def notify(url, detail, targets):
            notifications.append((url, detail, targets))

        queue = DashboardDatabaseQueue(
            "http://fixture/api/addDatabaseUrl", "key", on_failure=notify,
            log=lambda *_args, **_kwargs: None,
        )

        def reject(_url):
            raise urllib.error.HTTPError(
                "http://fixture", 502, "rejected", {},
                io.BytesIO(b'{"error":"Firebase returned HTTP 423"}'),
            )

        queue._request_batch = reject
        url = "https://failed.firebaseio.com/"
        queue.enqueue([url], "target-a")
        queue.enqueue([url], "target-b")
        await asyncio.sleep(0.02)
        await queue.drain()
        self.assertEqual(len(notifications), 1)
        self.assertEqual(notifications[0][0], url)
        self.assertIn("502", notifications[0][1])
        self.assertCountEqual(notifications[0][2], ["target-a", "target-b"])

    async def test_failed_database_accepts_unhashable_telethon_targets(self):
        notifications = []

        async def notify(_url, _detail, targets):
            notifications.append(targets)

        queue = DashboardDatabaseQueue("http://fixture/api", "key", on_failure=notify,
                                       log=lambda *_args, **_kwargs: None)
        target = SimpleNamespace(id=123, title="channel")

        def reject(_url):
            raise urllib.error.HTTPError("http://fixture", 423, "locked", {}, io.BytesIO(b"locked"))

        queue._request_batch = reject
        url = "https://fixture.firebaseio.com/"
        queue.enqueue([url], target)
        queue.enqueue([url], target)
        await queue.drain()
        self.assertEqual(notifications, [(target,)])


class BatchImporterTests(unittest.IsolatedAsyncioTestCase):
    async def test_batch_audit_counts_cross_route_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with FirebaseBatchWriter(root / "route_one", 1000) as writer:
                writer.add_urls(["https://shared.firebaseio.com/", "https://one.firebaseio.com/"])
            with FirebaseBatchWriter(root / "route_two", 1000) as writer:
                writer.add_urls(["https://shared.firebaseio.com/", "https://two.firebaseio.com/"])
            result = batch_audit.audit(root)
            self.assertEqual(result["route_entries"], 4)
            self.assertEqual(result["global_unique"], 3)
            self.assertEqual(result["cross_route_duplicates"], 1)

    async def test_auth_required_is_not_reported_as_each_database_failure(self):
        def reject(_request, timeout):
            raise urllib.error.HTTPError("http://fixture", 401, "unauthorized", {},
                io.BytesIO(b'{"error":"Admin login is required.","code":"AUTH_REQUIRED"}'))

        with self.assertRaisesRegex(RuntimeError, "updated server.js"):
            with patch("urllib.request.urlopen", side_effect=reject):
                batch_importer.submit_batch("http://fixture/api/addDatabaseUrls", "key",
                                             ["https://firebase.firebaseio.com/"])

    async def test_saved_route_folders_and_mixed_bulk_results(self):
        import json
        from argparse import Namespace
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with FirebaseBatchWriter(root, 1000) as writer:
                writer.add_urls(["https://shared.firebaseio.com/"])
            with FirebaseBatchWriter(root / "route_a_b", 1000) as writer:
                writer.add_urls(["https://shared.firebaseio.com/", "https://new.firebaseio.com/"])
            route = root / "route_c_d"
            route.mkdir()
            (route / "batch_0001 - 1 links.txt").write_text("https://locked.firebaseio.com/\n")
            self.assertEqual(len(batch_importer.read_urls(root)[0]), 3)
            args = Namespace(batch_dir=root, endpoint="http://fixture/api/addDatabaseUrl",
                             concurrency=1, failure_report=root / "failures.txt", dry_run=False)
            requests = []

            def respond(request, timeout):
                requests.append(request)
                self.assertIn("/api/addDatabaseUrls?", request.full_url)
                urls = json.loads(request.data)["databaseUrls"]
                statuses = ["duplicate", "added", "error"]
                return io.BytesIO(json.dumps({"results": [
                    {"url": url, "status": status, "reason": "HTTP 423"}
                    for url, status in zip(urls, statuses)
                ]}).encode())

            with patch.object(batch_importer, "load_setting", return_value="synthetic-key"), \
                 patch("urllib.request.urlopen", side_effect=respond):
                self.assertEqual(await batch_importer.run(args), 1)
            self.assertEqual(len(requests), 1)
            self.assertIn("locked.firebaseio.com/\tHTTP 423", args.failure_report.read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
