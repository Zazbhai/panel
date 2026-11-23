"""Offline userbot regressions; load function definitions without Telethon/session startup."""
import ast
import asyncio
import contextlib
import io
import json
from pathlib import Path
import re
from types import SimpleNamespace
from unittest.mock import AsyncMock
import urllib.error

ROOT = Path(__file__).resolve().parent.parent
tree = ast.parse((ROOT / "test.py").read_text(encoding="utf-8"))
functions = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))], type_ignores=[])
for node in functions.body:
    node.decorator_list = []
class SyntheticFloodWaitError(Exception):
    def __init__(self, seconds):
        self.seconds = seconds


scope = {"re": re, "asyncio": asyncio, "json": json, "urllib": urllib,
         "DASHBOARD_API_KEY": "synthetic-key", "FloodWaitError": SyntheticFloodWaitError}
regex_node = next(node for node in tree.body if isinstance(node, ast.Assign)
                  and any(isinstance(target, ast.Name) and target.id == "DATABASE_URL_RE" for target in node.targets))
exec(compile(ast.Module(body=[regex_node], type_ignores=[]), "test.py", "exec"), scope)
exec(compile(functions, "test.py", "exec"), scope)
assert scope["extract_database_url"](SimpleNamespace(text="**https\\://fixture.firebaseio.com/**")) == "https://fixture.firebaseio.com/"

async def main():
    url = "https://fixture.firebaseio.com"
    scope["queued_database_urls"] = {url}
    scope["add_database_url"] = AsyncMock(return_value=False)
    await scope["submit_database_url"](url)
    assert url not in scope["queued_database_urls"], "Failed URL must be eligible for resubmission"
    scope["queued_database_urls"] = {url}
    scope["add_database_url"] = AsyncMock(return_value=True)
    await scope["submit_database_url"](url)
    assert url in scope["queued_database_urls"], "Successful URLs should stay deduplicated"

    saved = []
    forwarded = []
    waits = []
    calls = 0
    messages = [SimpleNamespace(id=2, action=None), SimpleNamespace(id=3, action=None)]

    class HistoryClient:
        async def iter_messages(self, _source, min_id, reverse):
            nonlocal calls
            assert reverse is True
            if calls == 0:
                calls += 1
                assert min_id == 1
                raise SyntheticFloodWaitError(3179)
            assert min_id == 1, "History must resume from the last saved message ID"
            for message in messages:
                yield message

    scope.update({
        "client": HistoryClient(), "SOURCE": "source", "FORWARD_OLD": True,
        "last_done": lambda: saved[-1] if saved else 1,
        "save_done": saved.append,
        "send": AsyncMock(side_effect=lambda msg: forwarded.append(msg.id)),
        "wait_for_database_updates": AsyncMock(),
        "DELAY": 0,
        "asyncio": asyncio,
    })
    async def immediate_sleep(_seconds):
        waits.append(_seconds)
    scope["asyncio"].sleep = immediate_sleep
    scope["print"] = lambda *args, **kwargs: None
    await scope["forward_old"]()
    assert forwarded == [2, 3], "All old messages after the checkpoint must be forwarded"
    assert saved == [2, 3], "Each forwarded message must advance the durable checkpoint"
    assert sum(waits) == 3180, "Flood wait must be observed before resuming history"

asyncio.run(main())
print("PASS: escaped/Markdown URL extraction and retry eligibility after submission failure; no Telegram or network access.")
