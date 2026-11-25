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
from telegram_exporter import (
    ChannelRouteWorker, DashboardDatabaseQueue, HistoryExporter,
    IncompleteHistoryError, extract_database_urls, resolve_route_entity,
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

        class RouteClient(FakeClient):
            def __init__(self):
                super().__init__(messages)
                self.deliveries = []
                self.active_forwards = 0
                self.peak_forwards = 0

            async def forward_messages(self, target, msg):
                self.active_forwards += 1
                self.peak_forwards = max(self.peak_forwards, self.active_forwards)
                await asyncio.sleep(0.001)
                self.deliveries.append((target, msg.id))
                self.active_forwards -= 1

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
        self.assertCountEqual(client.deliveries, [
            ("target-a", 1), ("target-a", 2), ("target-b", 1), ("target-b", 2),
        ])
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
        self.assertEqual(dashboard.submissions, [
            ("target-a", expected_urls), ("target-b", expected_urls),
            ("target-a", []), ("target-b", []),
        ], "Every message URL should be submitted for every configured route")
        self.assertEqual(client.peak_forwards, 2, "Source-target workers must run concurrently")

    async def test_route_checkpoints_only_messages_successfully_forwarded(self):
        source = "source"
        messages = [message(1), message(2), message(3)]

        class FlakyRouteClient(FakeClient):
            def __init__(self):
                super().__init__(messages)
                self.fail_once = True
                self.deliveries = []

            async def forward_messages(self, target, msg):
                if msg.id == 2 and self.fail_once:
                    self.fail_once = False
                    raise SyntheticFloodWait(0)
                self.deliveries.append((target, msg.id))

        client = FlakyRouteClient()
        worker = ChannelRouteWorker(client, source, "source-id", "target", "target-id", self.writer,
                                    checkpoint_dir=self.folder.name, wait_time=0,
                                    log=lambda *_args, **_kwargs: None)
        with self.assertRaises(SyntheticFloodWait):
            await worker.scan()
        self.assertEqual(worker.cursor, 1)
        self.assertEqual(self.writer.cursor(worker.cursor_key), 1)
        checkpoint = Path(self.folder.name) / "last_done_source-id_target-id.txt"
        self.assertEqual(checkpoint.read_text(), "1")
        await worker.scan()
        self.assertEqual(client.deliveries, [("target", 1), ("target", 2), ("target", 3)])
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
    async def test_dashboard_url_checks_are_deduplicated_and_bounded(self):
        queue = DashboardDatabaseQueue("http://fixture/api/addDatabaseUrl", "key", concurrency=2,
                                       log=lambda *_args, **_kwargs: None)
        lock = threading.Lock()
        active = 0
        peak = 0
        added = []

        def request(url):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.01)
            added.append(url)
            with lock:
                active -= 1

        queue._request = request
        urls = [f"https://db-{index}.firebaseio.com/" for index in range(5)]
        queue.enqueue(urls[:3])
        queue.enqueue(urls[1:])
        await queue.drain()
        self.assertCountEqual(added, urls)
        self.assertGreater(peak, 1, "Dashboard checks should run in parallel")
        self.assertLessEqual(peak, 2, "Dashboard checks must honor configured concurrency")

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

        queue._request = reject
        url = "https://failed.firebaseio.com/"
        queue.enqueue([url], "target-a")
        queue.enqueue([url], "target-b")
        await asyncio.sleep(0.02)
        await queue.drain()
        self.assertEqual(len(notifications), 1)
        self.assertEqual(notifications[0][0], url)
        self.assertIn("HTTP 502", notifications[0][1])
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

        queue._request = reject
        url = "https://fixture.firebaseio.com/"
        queue.enqueue([url], target)
        queue.enqueue([url], target)
        await queue.drain()
        self.assertEqual(notifications, [(target,)])


if __name__ == "__main__":
    unittest.main(verbosity=2)
