"""Count route batch URLs and exact cross-route unique URLs without printing them."""
import argparse
from contextlib import closing
from pathlib import Path
import sqlite3


def audit(batch_root):
    batch_root = Path(batch_root).resolve()
    databases = []
    shared = batch_root / "export.sqlite3"
    if shared.is_file():
        databases.append(("legacy shared", shared))
    databases.extend(
        (directory.name, directory / "export.sqlite3")
        for directory in sorted(batch_root.glob("route_*"))
        if directory.is_dir() and (directory / "export.sqlite3").is_file()
    )
    if not databases:
        raise FileNotFoundError(f"No export.sqlite3 files found under {batch_root}")

    all_urls = set()
    per_route = []
    for label, path in databases:
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as connection:
            urls = {row[0] for row in connection.execute("SELECT url FROM links")}
        per_route.append((label, len(urls)))
        all_urls.update(urls)
    route_entries = sum(count for _label, count in per_route)
    return {
        "routes": per_route,
        "route_entries": route_entries,
        "global_unique": len(all_urls),
        "cross_route_duplicates": route_entries - len(all_urls),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-dir", type=Path, default=Path("firebase_batches"))
    args = parser.parse_args()
    result = audit(args.batch_dir)
    for route, count in result["routes"]:
        print(f"{route}: {count:,} unique URLs")
    print(f"Route entries summed: {result['route_entries']:,}")
    print(f"Unique across all route databases: {result['global_unique']:,}")
    print(f"Duplicates shared across routes: {result['cross_route_duplicates']:,}")


if __name__ == "__main__":
    main()
