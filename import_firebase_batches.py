"""Import Firebase URLs from firebase_batches into the dashboard rotation list."""
import argparse
import asyncio
import json
import os
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


BATCH_NAME = re.compile(r"batch_(\d{4,}) - (\d+) links\.txt$")


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
            if len(value) >= 2 and value[0] in "'\"" and value[-1] == value[0]:
                return value[1:-1]
            return value.split("#", 1)[0].strip()
    return ""


def canonical_url(value):
    value = value.strip().replace(r"\:", ":").replace(r"\/", "/")
    parts = urllib.parse.urlsplit(value)
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        return ""
    return urllib.parse.urlunsplit((
        parts.scheme.lower(), parts.netloc.lower(), parts.path or "/",
        parts.query, parts.fragment,
    ))


def read_urls(batch_dir):
    batch_dir = Path(batch_dir)
    database = batch_dir / "export.sqlite3"
    values = []
    if database.exists():
        with sqlite3.connect(database) as connection:
            values.extend(row[0] for row in connection.execute(
                "SELECT url FROM links ORDER BY number"
            ))
    else:
        files = sorted(
            (path for path in batch_dir.glob("batch_*.txt") if BATCH_NAME.fullmatch(path.name)),
            key=lambda path: int(BATCH_NAME.fullmatch(path.name)[1]),
        )
        for path in files:
            values.extend(path.read_text(encoding="utf-8").splitlines())
    urls = []
    seen = set()
    invalid = []
    for value in values:
        url = canonical_url(value)
        if not url:
            invalid.append(value.strip() or "<blank>")
        elif url not in seen:
            seen.add(url)
            urls.append(url)
    return urls, invalid


def submit(endpoint, api_key, url):
    parts = urllib.parse.urlsplit(endpoint)
    query = dict(urllib.parse.parse_qsl(parts.query))
    query["api_key"] = api_key
    request_url = urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))
    request = urllib.request.Request(
        request_url,
        data=json.dumps({"databaseUrl": url}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return {"url": url, "status": "duplicate" if not payload.get("added", True) else "added"}
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").strip()
        return {"url": url, "status": "error", "detail": f"HTTP {error.code}: {detail}"}
    except (OSError, ValueError) as error:
        return {"url": url, "status": "error", "detail": str(error)}


async def run(args):
    base_dir = Path(__file__).resolve().parent
    api_key = load_setting("DASHBOARD_API_KEY", base_dir)
    if not api_key:
        raise SystemExit("DASHBOARD_API_KEY is missing from the environment or .env.")
    urls, invalid = read_urls(args.batch_dir)
    print(f"Loaded {len(urls)} unique Firebase URLs from {args.batch_dir}.")
    if invalid:
        print(f"Skipped {len(invalid)} invalid batch entries.")
    if args.dry_run:
        return 0
    semaphore = asyncio.Semaphore(args.concurrency)

    async def one(url):
        async with semaphore:
            return await asyncio.to_thread(submit, args.endpoint, api_key, url)

    results = await asyncio.gather(*(one(url) for url in urls))
    added = sum(result["status"] == "added" for result in results)
    duplicates = sum(result["status"] == "duplicate" for result in results)
    failures = [result for result in results if result["status"] == "error"]
    print(f"Rotation import complete: {added} added; {duplicates} already present; {len(failures)} failed.")
    if failures or invalid:
        report = Path(args.failure_report)
        lines = [f"{item['url']}\t{item['detail']}\n" for item in failures]
        lines.extend(f"{value}\tinvalid batch entry\n" for value in invalid)
        report.write_text("".join(lines), encoding="utf-8")
        print(f"Failure report: {report}")
    return 1 if failures or invalid else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-dir", type=Path, default=Path("firebase_batches"))
    parser.add_argument("--endpoint", default=None)
    parser.add_argument("--concurrency", type=int, default=16)
    parser.add_argument("--failure-report", type=Path, default=Path("firebase_batch_import_failures.txt"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.concurrency < 1:
        parser.error("--concurrency must be positive")
    args.endpoint = args.endpoint or load_setting(
        "DASHBOARD_ADD_DATABASE_URL_ENDPOINT", Path(__file__).resolve().parent
    ) or "http://127.0.0.1:3000/api/addDatabaseUrl"
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
