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
scope = {"re": re, "asyncio": asyncio, "json": json, "urllib": urllib, "DASHBOARD_API_KEY": "synthetic-key"}
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

asyncio.run(main())
print("PASS: escaped/Markdown URL extraction and retry eligibility after submission failure; no Telegram or network access.")
