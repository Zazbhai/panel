"""Compatibility entry point for the Firebase Telegram exporter."""
import asyncio
from pathlib import Path

from telegram_exporter import run


API_ID = 30236390
API_HASH = "81607d18a648614598a2198c6d860c5f"
SOURCE = -1004418505510


if __name__ == "__main__":
    base_dir = Path(__file__).resolve().parent
    try:
        asyncio.run(run(API_ID, API_HASH, SOURCE, base_dir))
    except KeyboardInterrupt:
        pass
