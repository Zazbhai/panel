"""Offline export regressions: no Telegram login, provider or dashboard calls."""
import asyncio
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from firebase_batches import FirebaseBatchWriter
from telegram_exporter import HistoryExporter, IncompleteHistoryError, extract_database_urls


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
        assert reverse is False
        assert wait_time >= 0
        self.iterations += 1
        snapshot = sorted(self.messages, key=lambda msg: msg.id, reverse=True)
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
