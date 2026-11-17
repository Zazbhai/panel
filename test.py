"""
Telegram Userbot - purane + naye posts auto forward.
Aapke apne Telegram account se chalta hai (Telethon).

Setup:
  1. https://my.telegram.org -> API development tools -> api_id aur api_hash lo
  2. pip install telethon
  3. Neeche CONFIG bharo, phir:  python forward_userbot.py
  Pehli baar phone number + OTP maangega.
"""
import asyncio
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from telethon import TelegramClient, events
from telethon.errors import FloodWaitError, ChatForwardsRestrictedError

# ===== CONFIG =====
API_ID = 30236390            # my.telegram.org se
API_HASH = "81607d18a648614598a2198c6d860c5f"  # my.telegram.org se
SOURCE = -1004418505510     # Fury SMS source channel from the current Telegram account
TARGET = "@zazchutiyaj"    # aapka channel (@username ya -100... id)
START_FROM = 1              # purane posts kis number se shuru
FORWARD_OLD = True          # purane posts bhejne hain?
DELAY = 0.25                # har post ke beech seconds (flood control)
ADD_DATABASE_URL_ENDPOINT = os.getenv(
    "DASHBOARD_ADD_DATABASE_URL_ENDPOINT",
    "http://127.0.0.1:3000/api/addDatabaseUrl",
)
DASHBOARD_API_KEY = "bc0704a582dddf6f684b51591cfa79242a8b16fa4a7d1af00dbb059f01c905b6"
# ==================

client = TelegramClient("userbot_session", API_ID, API_HASH)
DONE_FILE = "last_done.txt"
pending_database_tasks = set()
queued_database_urls = set()


def last_done():
    try:
        return int(open(DONE_FILE).read().strip())
    except Exception:
        return START_FROM - 1


def save_done(mid):
    open(DONE_FILE, "w").write(str(mid))


DATABASE_URL_RE = re.compile(
    r"https?://[A-Za-z0-9.-]+\.(?:firebaseio\.com|firebasedatabase\.app)(?:/[^\s]*)?",
    re.IGNORECASE,
)


def extract_database_url(msg):
    text = (msg.text or "").replace("\\:", ":")
    match = DATABASE_URL_RE.search(text)
    return match.group(0).rstrip(".,;:!?\u201d\u2019)") if match else None


def print_message(msg):
    """Print only the Firebase database URL found in the message."""
    url = extract_database_url(msg)
    print(url or "[No Firebase database URL found]", flush=True)
    return url


def _add_database_url(url):
    endpoint = f"{ADD_DATABASE_URL_ENDPOINT}?{urllib.parse.urlencode({'api_key': DASHBOARD_API_KEY})}"
    request = urllib.request.Request(
        endpoint,
        data=json.dumps({"databaseUrl": url}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        body = response.read().decode("utf-8")
        return json.loads(body) if body else {}


async def add_database_url(url):
    """Persist a discovered database URL through the dashboard API."""
    if not DASHBOARD_API_KEY:
        print("DASHBOARD_API_KEY is not set; database URL was not added.", flush=True)
        return
    try:
        await asyncio.to_thread(_add_database_url, url)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace").strip()
        if error.code == 401 and "AUTH_REQUIRED" in detail:
            print("Dashboard server is using the old API code; restart node server.js and try again.", flush=True)
            return
        print(f"Could not add database URL (HTTP {error.code}): {detail}", flush=True)
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        print(f"Could not add database URL: {error}", flush=True)


def queue_database_url(url):
    """Persist URLs in the background so API writes do not delay forwarding."""
    if not url or not DASHBOARD_API_KEY or url in queued_database_urls:
        return
    queued_database_urls.add(url)
    task = asyncio.create_task(add_database_url(url))
    pending_database_tasks.add(task)
    task.add_done_callback(pending_database_tasks.discard)


async def wait_for_database_updates():
    if pending_database_tasks:
        await asyncio.gather(*tuple(pending_database_tasks), return_exceptions=True)


async def send(msg):
    """Forward karo; agar channel ne forward band kiya hai to copy karke bhejo."""
    database_url = print_message(msg)
    queue_database_url(database_url)
    while True:
        try:
            try:
                await client.forward_messages(TARGET, msg)
            except ChatForwardsRestrictedError:
                if msg.media:
                    path = await msg.download_media(file="tmp_media/")
                    await client.send_file(TARGET, path, caption=msg.text or "")
                    if path and os.path.exists(path):
                        os.remove(path)
                elif msg.text:
                    await client.send_message(TARGET, msg.text)
            return
        except FloodWaitError as e:
            print(f"Telegram ne rukne ko kaha: {e.seconds}s wait...")
            await asyncio.sleep(e.seconds + 1)


async def forward_old():
    start = last_done() + 1
    print(f"Purane posts #{start} se forward ho rahe hain...")
    async for msg in client.iter_messages(SOURCE, min_id=start - 1, reverse=True):
        if msg.action:  # service messages skip
            continue
        await send(msg)
        save_done(msg.id)
        print(f"Forwarded #{msg.id}")
        await asyncio.sleep(DELAY)
    await wait_for_database_updates()
    print("Purane posts complete.")


@client.on(events.NewMessage(chats=SOURCE))
async def on_new(event):
    await send(event.message)
    save_done(event.message.id)
    print(f"Naya post forwarded #{event.message.id}")


async def main():
    phone = input("Apna phone number daalo (+91XXXXXXXXXX), bot token NAHI: ").strip()
    if ":" in phone:
        print("Ye bot token hai! Userbot sirf phone number se chalta hai.")
        return
    await client.start(phone=phone)
    me = await client.get_me()
    if me.bot:
        print("Session bot ka hai. 'userbot_session.session' file delete karke dubara chalao.")
        return
    print("Login:", me.first_name, "- channels load ho rahe hain...")
    global SOURCE
    dialogs = await client.get_dialogs()  # private channel pehchanne ke liye zaroori
    found = None
    for d in dialogs:
        if d.id == SOURCE or str(abs(d.id)).endswith(str(abs(SOURCE))[-10:]):
            found = d
            break
    if not found:
        print("Source channel aapke account me nahi mila! Aapke channels/groups:")
        for d in dialogs:
            if d.is_channel or d.is_group:
                print("  ", d.id, "-", d.name)
        print("Upar se sahi ID copy karke SOURCE me daalo, ya pehle channel join karo.")
        return
    SOURCE = found.entity
    print("Source mila:", found.name)
    if FORWARD_OLD:
        await forward_old()
    print("Ab naye posts ka wait... (band karne ke liye Ctrl+C)")
    await client.run_until_disconnected()


if __name__ == "__main__":
    asyncio.run(main())
