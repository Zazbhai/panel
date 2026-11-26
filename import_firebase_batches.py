"""Import Firebase URLs from firebase_batches into the dashboard rotation list."""
import argparse
import asyncio
from contextlib import closing
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
    batch_dir = Path(batch_dir).resolve()
    values = []
    # Include older shared output and the new route-specific folders.
    directories = [batch_dir] + sorted(path for path in batch_dir.glob("route_*") if path.is_dir())
    if not batch_dir.is_dir():
        raise ValueError(f"Batch directory does not exist: {batch_dir}")
    for directory in directories:
        database = directory / "export.sqlite3"
        if database.exists():
            with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
                values.extend(row[0] for row in connection.execute(
                    "SELECT url FROM links ORDER BY number"
                ))
            continue
        files = sorted(
            (path for path in directory.glob("batch_*.txt") if BATCH_NAME.fullmatch(path.name)),
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


def submit_batch(endpoint, api_key, urls):
    parts = urllib.parse.urlsplit(endpoint)
    query = dict(urllib.parse.parse_qsl(parts.query))
    query["api_key"] = api_key
    request_url = urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))
    request = urllib.request.Request(
        request_url,
        data=json.dumps({"databaseUrls": urls}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60 + 6 * len(urls)) as response:
            payload = json.loads(response.read().decode("utf-8"))
            if (not isinstance(payload, dict) or not isinstance(payload.get("results"), list)
                or len(payload["results"]) != len(urls)
                or any(not isinstance(item, dict) or item.get("status") not in
                       {"added", "duplicate", "error"} for item in payload["results"])):
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
                raise RuntimeError(
                    "The dashboard returned AUTH_REQUIRED for /api/addDatabaseUrls. "
                    "Deploy the updated server.js and restart the dashboard before importing."
                ) from error
            raise RuntimeError(
                f"Dashboard bulk endpoint authentication failed (HTTP {error.code}): {detail}"
            ) from error
        return [{"url": url, "status": "error", "reason": f"HTTP {error.code}: {detail}"} for url in urls]
    except (OSError, ValueError) as error:
        return [{"url": url, "status": "error", "reason": str(error)} for url in urls]


async def run(args):
    base_dir = Path(__file__).resolve().parent
    api_key = load_setting("DASHBOARD_API_KEY", base_dir)
    if not api_key:
        raise SystemExit("DASHBOARD_API_KEY is missing from the environment or .env.")
    urls, invalid = read_urls(args.batch_dir.resolve())
    print(f"Loaded {len(urls)} unique Firebase URLs from {args.batch_dir}.")
    if invalid:
        print(f"Skipped {len(invalid)} invalid batch entries.")
    if args.dry_run:
        return 0
    endpoint_parts = urllib.parse.urlsplit(args.endpoint)
    if endpoint_parts.path.endswith("/api/addDatabaseUrl"):
        endpoint_parts = endpoint_parts._replace(path=endpoint_parts.path + "s")
    elif endpoint_parts.path.endswith("addDatabaseUrl"):
        endpoint_parts = endpoint_parts._replace(path=endpoint_parts.path + "s")
    bulk_endpoint = urllib.parse.urlunsplit(endpoint_parts)
    batches = [urls[index:index + 1000] for index in range(0, len(urls), 1000)]
    semaphore = asyncio.Semaphore(args.concurrency)

    async def one(batch):
        async with semaphore:
            print(f"Checking batch of {len(batch)} database URLs in parallel...", flush=True)
            results = await asyncio.to_thread(submit_batch, bulk_endpoint, api_key, batch)
            print(f"Batch complete: {len(results)} results received.", flush=True)
            return results

    batches_results = await asyncio.gather(*(one(batch) for batch in batches))
    results = [item for batch_result in batches_results for item in batch_result]
    added = sum(result.get("status") == "added" for result in results)
    duplicates = sum(result.get("status") == "duplicate" for result in results)
    failures = [result for result in results if result["status"] == "error"]
    print(f"Rotation import complete: {added} added; {duplicates} already present; {len(failures)} failed.")
    if failures or invalid:
        report = Path(args.failure_report)
        lines = [f"{item['url']}\t{item.get('reason', item.get('detail', 'Unknown failure'))}\n" for item in failures]
        lines.extend(f"{value}\tinvalid batch entry\n" for value in invalid)
        report.write_text("".join(lines), encoding="utf-8")
        print(f"Failure report: {report}")
    return 1 if failures or invalid else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-dir", type=Path, default=Path("firebase_batches"))
    parser.add_argument("--endpoint", default=None)
    parser.add_argument("--concurrency", type=int, default=1,
                        help="Number of 1,000-URL batches to submit concurrently")
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
