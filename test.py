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
import os
from telethon import TelegramClient, events
from telethon.errors import FloodWaitError, ChatForwardsRestrictedError

# ===== CONFIG =====
API_ID = 30236390            # my.telegram.org se
API_HASH = "81607d18a648614598a2198c6d860c5f"  # my.telegram.org se
SOURCE = -1004418505510     # source channel (t.me/c/4418505510 -> -1004418505510)
TARGET = "@zazchutiyaj"    # aapka channel (@username ya -100... id)
START_FROM = 1              # purane posts kis number se shuru
FORWARD_OLD = True          # purane posts bhejne hain?
DELAY = 2                   # har post ke beech seconds (ban se bachne ke liye)
# ==================

client = TelegramClient("userbot_session", API_ID, API_HASH)
DONE_FILE = "last_done.txt"


def last_done():
    try:
        return int(open(DONE_FILE).read().strip())
    except Exception:
        return START_FROM - 1


def save_done(mid):
    open(DONE_FILE, "w").write(str(mid))


async def send(msg):
    """Forward karo; agar channel ne forward band kiya hai to copy karke bhejo."""
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
    print("Purane posts complete.")


@client.on(events.NewMessage(chats=SOURCE))
async def on_new(event):
    await send(event.message)
    save_done(event.message.id)
    print(f"Naya post forwarded #{event.message.id}")


async def main():
    await client.start()
    if FORWARD_OLD:
        await forward_old()
    print("Ab naye posts ka wait... (band karne ke liye Ctrl+C)")
    await client.run_until_disconnected()


if __name__ == "__main__":
    asyncio.run(main())
