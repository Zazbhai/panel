"""Run one Telegram forwarding/export worker for each configured route."""
import asyncio
from pathlib import Path

from telegram_exporter import run


API_ID = 30236390
API_HASH = "81607d18a648614598a2198c6d860c5f"
ROUTES = [
    # Add one entry per source/target pair. Repeat a source to forward it to
    # multiple targets; every pair gets its own history cursor and worker.
    {"source": -1004492989164, "target": -1005794536077},
    # {"source": "@another_source", "target": "@another_target"},
]


if __name__ == "__main__":
    base_dir = Path(__file__).resolve().parent
    try:
        asyncio.run(run(API_ID, API_HASH, ROUTES, base_dir))
    except KeyboardInterrupt:
        pass
