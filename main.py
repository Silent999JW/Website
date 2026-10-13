import json
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
STATE_FILE = DATA_DIR / "playerwatch.json"
PORT = 8989
VALID_THEMES = {
    "aurora", "halloween", "midnight", "ocean", "sakura",
    "sunset", "forest", "cyberpunk", "arctic", "ember",
}
VALID_REFRESH_INTERVALS = {15, 30, 60, 300}
STATE_LOCK = threading.RLock()
ROBLOX_HEADERS = {
    "User-Agent": "RobloxAccountStatusDashboard/1.0 (localhost)",
    "Accept": "application/json",
}
presence_monitor = None


def read_state():
    with STATE_LOCK:
        if not STATE_FILE.exists():
            return {"accounts": [], "settings": {}, "initialized": False}
        try:
            state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise OSError(f"Could not read {STATE_FILE.name}: {error}") from error
        if not isinstance(state, dict) or not isinstance(state.get("accounts"), list) or not isinstance(state.get("settings"), dict):
            raise OSError(f"{STATE_FILE.name} has an invalid format.")
        return {"accounts": state["accounts"], "settings": state["settings"], "initialized": True}


def write_state(state):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp_file = STATE_FILE.with_suffix(".tmp")
    with STATE_LOCK:
        try:
            temp_file.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(temp_file, STATE_FILE)
        except OSError:
            if temp_file.exists():
                temp_file.unlink()
            raise


def clean_state(payload):
    if not isinstance(payload, dict):
        raise RobloxAPIError("Expected an object containing accounts and settings.", 400)
    accounts = payload.get("accounts", [])
    settings = payload.get("settings", {})
    if not isinstance(accounts, list) or len(accounts) > 1000:
        raise RobloxAPIError("The watchlist must contain at most 1,000 accounts.", 400)
    if not isinstance(settings, dict):
        raise RobloxAPIError("Settings must be an object.", 400)
    safe_accounts = []
    seen_ids = set()
    for account in accounts:
        if not isinstance(account, dict):
            raise RobloxAPIError("Each account must be an object.", 400)
        user_id = str(parse_user_id(account.get("id")))
        if user_id in seen_ids:
            continue
        seen_ids.add(user_id)
        safe_accounts.append({
            "id": int(user_id),
            "name": str(account.get("name", ""))[:64],
            "displayName": str(account.get("displayName", account.get("name", "")))[:64],
            "description": str(account.get("description", ""))[:10_000],
            "created": str(account.get("created", ""))[:64],
            "isBanned": account.get("isBanned") is True,
            "avatarUrl": str(account.get("avatarUrl", ""))[:2048],
            "favorite": account.get("favorite") is True,
            "presence": account.get("presence") if isinstance(account.get("presence"), dict) else None,
            "inventory": account.get("inventory") if isinstance(account.get("inventory"), dict) else None,
        })
    interval = settings.get("refreshInterval", 60)
    try:
        interval = int(interval)
    except (TypeError, ValueError) as error:
        raise RobloxAPIError("Choose a supported status-check interval.", 400) from error
    if interval not in VALID_REFRESH_INTERVALS:
        raise RobloxAPIError("Choose a supported status-check interval.", 400)
    theme = settings.get("theme", "aurora")
    if theme not in VALID_THEMES:
        raise RobloxAPIError("Choose a supported dashboard theme.", 400)
    view = settings.get("view", "list")
    if view not in ("list", "grid"):
        raise RobloxAPIError("Choose list or grid view.", 400)
    webhook_url = settings.get("webhookUrl", "")
    mention = settings.get("webhookMention", "")
    if not isinstance(webhook_url, str) or len(webhook_url) > 2048:
        raise RobloxAPIError("Webhook URL is invalid.", 400)
    if not isinstance(mention, str) or len(mention) > 40:
        raise RobloxAPIError("Webhook ping must be a Discord user or role mention.", 400)
    if mention and not re.fullmatch(r"<@!?[0-9]{5,25}>|<@&[0-9]{5,25}>", mention):
        raise RobloxAPIError("Enter a Discord user mention like <@123456789012345678> or role mention like <@&123456789012345678>.", 400)
    return {
        "accounts": safe_accounts,
        "settings": {
            "theme": theme,
            "view": view,
            "autoRefresh": settings.get("autoRefresh") is not False,
            "refreshInterval": interval,
            "showUserIds": settings.get("showUserIds") is not False,
            "compactRows": settings.get("compactRows") is True,
            "reduceMotion": settings.get("reduceMotion") is True,
            "webhookEnabled": settings.get("webhookEnabled") is True,
            "webhookUrl": webhook_url,
            "webhookMention": mention,
        },
    }


class RobloxAPIError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def roblox_request(url, method="GET", payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = dict(ROBLOX_HEADERS)
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise RobloxAPIError("Roblox could not find that user.", 404) from error
        if error.code in (401, 403):
            raise RobloxAPIError(
                "Roblox restricted this data. Presence or inventory may require "
                "an authenticated Roblox account or public inventory settings.",
                403,
            ) from error
        if error.code == 429:
            raise RobloxAPIError("Roblox is rate-limiting requests. Try again shortly.", 429) from error
        raise RobloxAPIError(f"Roblox returned HTTP {error.code}.", 502) from error
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RobloxAPIError(f"Could not reach Roblox: {error}") from error


def lookup_user(username):
    result = roblox_request(
        "https://users.roblox.com/v1/usernames/users",
        "POST",
        {"usernames": [username], "excludeBannedUsers": False},
    )
    users = result.get("data", [])
    if not users:
        raise RobloxAPIError("Roblox could not find that username.", 404)
    return users[0]


def parse_user_id(value):
    try:
        user_id = int(value)
    except (TypeError, ValueError) as error:
        raise RobloxAPIError("A valid numeric Roblox user ID is required.", 400) from error
    if user_id < 1:
        raise RobloxAPIError("A valid numeric Roblox user ID is required.", 400)
    return user_id


def fetch_account(user_id):
    details = roblox_request(f"https://users.roblox.com/v1/users/{user_id}")
    query = urllib.parse.urlencode(
        {"userIds": user_id, "size": "150x150", "format": "Png", "isCircular": "false"}
    )
    thumbnail = roblox_request(f"https://thumbnails.roblox.com/v1/users/avatar?{query}")
    avatar = next(iter(thumbnail.get("data", [])), {})
    return {
        "id": details["id"],
        "name": details["name"],
        "displayName": details.get("displayName", details["name"]),
        "description": details.get("description", ""),
        "created": details.get("created"),
        "isBanned": details.get("isBanned", False),
        "avatarUrl": avatar.get("imageUrl"),
        "avatarState": avatar.get("state"),
    }


def fetch_presence(user_ids):
    result = roblox_request(
        "https://presence.roblox.com/v1/presence/users",
        "POST",
        {"userIds": user_ids[:100]},
    )
    presences = {}
    for presence in result.get("userPresences", []):
        user_id = str(presence.get("userId"))
        kind = presence.get("userPresenceType")
        presences[user_id] = {
            "type": kind,
            "lastOnline": presence.get("lastOnline"),
            "placeId": presence.get("placeId"),
            "rootPlaceId": presence.get("rootPlaceId"),
            "gameId": presence.get("gameId"),
            "gameName": presence.get("lastLocation") if kind in (2, 3) else None,
            "universeId": presence.get("universeId"),
        }
    return presences


def validated_webhook_url(value):
    try:
        parsed = urllib.parse.urlparse(value)
        parts = parsed.path.strip("/").split("/")
        valid_host = parsed.hostname in ("discord.com", "discordapp.com")
        valid_path = (
            len(parts) == 4 and parts[0] == "api" and parts[1] == "webhooks"
            and parts[2].isdigit() and bool(re.fullmatch(r"[A-Za-z0-9._-]+", parts[3]))
        )
        if (
            parsed.scheme != "https" or not valid_host or not valid_path
            or parsed.username or parsed.password or parsed.port not in (None, 443)
            or parsed.fragment
        ):
            raise ValueError
    except (TypeError, ValueError) as error:
        raise RobloxAPIError("Enter a valid Discord webhook URL.", 400) from error
    return value


def send_discord_webhook(settings, account, test=False):
    webhook_url = validated_webhook_url(settings.get("webhookUrl", ""))
    mention = settings.get("webhookMention", "")
    if mention and not re.fullmatch(r"<@!?[0-9]{5,25}>|<@&[0-9]{5,25}>", mention):
        raise RobloxAPIError("Enter a Discord user or role mention.", 400)
    if test:
        embed = {
            "title": "Playerwatch alerts are connected",
            "description": "Your Roblox offline notifications are ready. Favorite accounts will appear here when their status changes to offline.",
            "color": 0x8B7CFF,
            "footer": {"text": "Playerwatch · Roblox account monitor"},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    else:
        display_name = str(account.get("displayName") or account.get("name") or "A watched account")[:80]
        username = str(account.get("name") or "Unknown")[:64]
        user_id = str(account.get("id", ""))
        profile_url = f"https://www.roblox.com/users/{urllib.parse.quote(user_id, safe='')}/profile"
        presence = account.get("presence") if isinstance(account.get("presence"), dict) else {}
        previous_type = presence.get("type")
        previous_status = {
            1: "Online on Roblox",
            2: f"In-game · {presence.get('gameName') or 'Playing a game'}",
            3: "Using Roblox Studio",
        }.get(previous_type, "Online")
        description = str(account.get("description") or "").strip()
        created = str(account.get("created") or "")
        try:
            created = datetime.fromisoformat(created.replace("Z", "+00:00")).strftime("%B %d, %Y")
        except ValueError:
            created = created[:64] or "Unknown"
        fields = [
            {"name": "Status", "value": f"**Offline**\nPreviously: {previous_status[:180]}", "inline": False},
            {"name": "Roblox user ID", "value": f"`{user_id}`", "inline": True},
            {"name": "Joined Roblox", "value": created, "inline": True},
        ]
        inventory = account.get("inventory")
        if isinstance(inventory, dict) and inventory.get("available") is True:
            rap = inventory.get("rap", 0)
            collectibles = inventory.get("collectibles", 0)
            fields.append({
                "name": "Collectibles · estimated RAP",
                "value": f"{collectibles:,} collectibles  ·  R$ {rap:,}" if isinstance(collectibles, int) and isinstance(rap, int) else "Public estimate available",
                "inline": False,
            })
        embed = {
            "title": f"{display_name}  (@{username})"[:256],
            "url": profile_url,
            "description": (description[:900] + ("…" if len(description) > 900 else "")) if description else "No public profile description.",
            "color": 0xF29B62,
            "fields": fields,
            "footer": {"text": "Playerwatch · Roblox account monitor"},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        avatar_url = account.get("avatarUrl")
        try:
            parsed_avatar = urllib.parse.urlparse(avatar_url)
            if (
                parsed_avatar.scheme == "https"
                and parsed_avatar.hostname
                and parsed_avatar.hostname.lower().endswith(".rbxcdn.com")
                and not parsed_avatar.username
                and not parsed_avatar.password
            ):
                embed["thumbnail"] = {"url": avatar_url}
        except (TypeError, ValueError):
            pass
    payload = {
        "content": mention,
        "embeds": [embed],
        "allowed_mentions": {"parse": [], "users": [], "roles": []},
    }
    if mention.startswith("<@&"):
        payload["allowed_mentions"]["roles"] = [mention[3:-1]]
    elif mention.startswith("<@"):
        payload["allowed_mentions"]["users"] = [mention[2:-1].lstrip("!")]
    request = urllib.request.Request(
        webhook_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "Playerwatch/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10):
            return
    except urllib.error.HTTPError as error:
        raise RobloxAPIError(f"Discord rejected the webhook (HTTP {error.code}).", 502) from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise RobloxAPIError("Could not reach the Discord webhook.", 502) from error


class PresenceMonitor:
    def __init__(self):
        self._lock = threading.Lock()
        state = read_state()
        self._known_presence = {
            str(account["id"]): account["presence"].get("type")
            for account in state["accounts"]
            if str(account.get("id", "")).isdigit() and isinstance(account.get("presence"), dict)
        }
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread = None

    def wake(self):
        self._wake.set()

    def check(self, user_ids):
        if not user_ids:
            return {}
        alerts = []
        with self._lock:
            presences = {}
            for start in range(0, len(user_ids), 100):
                presences.update(fetch_presence(user_ids[start:start + 100]))
            with STATE_LOCK:
                state = read_state()
                accounts_by_id = {str(account["id"]): account for account in state["accounts"]}
                for user_id in user_ids:
                    key = str(user_id)
                    presence = presences.get(key)
                    if presence is None:
                        continue
                    previous_type = self._known_presence.get(key)
                    new_type = presence.get("type")
                    account = accounts_by_id.get(key)
                    if (
                        account and account.get("favorite") is True
                        and state["settings"].get("webhookEnabled") is True
                        and previous_type in (1, 2, 3) and new_type == 0
                    ):
                        alerts.append((dict(state["settings"]), dict(account)))
                    self._known_presence[key] = new_type
                    account = accounts_by_id.get(key)
                    if account:
                        account["presence"] = presence
                if presences:
                    write_state({"accounts": state["accounts"], "settings": state["settings"]})
        for settings, account in alerts:
            try:
                send_discord_webhook(settings, account)
                print(f"Offline alert sent for watched account {account['id']}.")
            except RobloxAPIError as error:
                print(f"Offline alert failed for watched account {account['id']}: {error}")
        return presences

    def run(self):
        while not self._stop.is_set():
            try:
                state = read_state()
                settings = state["settings"]
                interval = settings.get("refreshInterval", 60)
                if settings.get("autoRefresh") is True:
                    favorite_ids = [
                        int(account["id"]) for account in state["accounts"]
                        if account.get("favorite") is True
                    ]
                    if favorite_ids:
                        try:
                            self.check(favorite_ids)
                        except (RobloxAPIError, OSError) as error:
                            print(f"Favorite presence check failed: {error}")
                else:
                    interval = min(interval, 5)
            except OSError as error:
                print(f"Presence monitor could not read saved state: {error}")
                interval = 5
            self._wake.wait(interval)
            self._wake.clear()

    def start(self):
        self._thread = threading.Thread(target=self.run, name="playerwatch-presence", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=2)


def fetch_inventory(user_id):
    url = (
        f"https://inventory.roblox.com/v1/users/{user_id}/assets/collectibles"
        "?limit=100&sortOrder=Asc"
    )
    total_rap = 0
    count = 0
    cursor = None
    pages = 0
    while pages < 10:
        page_url = url
        if cursor:
            page_url += "&cursor=" + urllib.parse.quote(cursor, safe="")
        page = roblox_request(page_url)
        for item in page.get("data", []):
            count += 1
            total_rap += item.get("recentAveragePrice") or 0
        cursor = page.get("nextPageCursor")
        pages += 1
        if not cursor:
            break
    return {
        "collectibles": count,
        "rap": total_rap,
        "estimated": bool(cursor),
        "available": True,
    }


class Handler(BaseHTTPRequestHandler):
    def send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/state":
            try:
                self.send_json(read_state())
            except OSError as error:
                self.send_json({"error": str(error)}, 500)
            return
        if parsed.path == "/api/lookup":
            username = urllib.parse.parse_qs(parsed.query).get("username", [""])[0].strip()
            if not username or len(username) > 20:
                self.send_json({"error": "Enter a Roblox username (up to 20 characters)."}, 400)
                return
            try:
                self.send_json(lookup_user(username))
            except RobloxAPIError as error:
                self.send_json({"error": str(error)}, error.status)
            return

        match = re.fullmatch(r"/api/users/(\d+)", parsed.path)
        if match:
            try:
                self.send_json(fetch_account(parse_user_id(match.group(1))))
            except RobloxAPIError as error:
                self.send_json({"error": str(error)}, error.status)
            return

        if parsed.path == "/":
            file_path = ROOT / "index.html"
        elif parsed.path in ("/styles.css", "/app.js"):
            file_path = ROOT / parsed.path.lstrip("/")
        else:
            self.send_error(404)
            return
        try:
            content = file_path.read_bytes()
        except OSError:
            self.send_error(404)
            return
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
        }.get(file_path.suffix, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path not in ("/api/presence", "/api/inventory", "/api/webhook/test"):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 1_048_576:
                raise RobloxAPIError("Request is too large.", 413)
            raw_body = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw_body)
            if parsed.path == "/api/presence":
                user_ids = [parse_user_id(value) for value in payload.get("userIds", [])]
                if not user_ids or len(user_ids) > 100:
                    raise RobloxAPIError("Check between 1 and 100 accounts at a time.", 400)
                if presence_monitor is None:
                    self.send_json({"error": "Presence monitoring is not initialized."}, 503)
                    return
                self.send_json(presence_monitor.check(user_ids))
            elif parsed.path == "/api/inventory":
                user_id = parse_user_id(payload.get("userId"))
                self.send_json(fetch_inventory(user_id))
            else:
                state = read_state()
                if not state["settings"].get("webhookUrl"):
                    raise RobloxAPIError("Save a Discord webhook URL in Settings first.", 400)
                send_discord_webhook(state["settings"], {}, test=True)
                self.send_json({"message": "Test message sent to Discord."})
        except RobloxAPIError as error:
            self.send_json({"error": str(error)}, error.status)
        except (json.JSONDecodeError, AttributeError, TypeError) as error:
            self.send_json({"error": f"Invalid request: {error}"}, 400)

    def do_PUT(self):
        if urllib.parse.urlparse(self.path).path != "/api/state":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 1_048_576:
                raise RobloxAPIError("Saved watchlist is too large.", 413)
            payload = json.loads(self.rfile.read(length))
            state = clean_state(payload)
            write_state(state)
            if presence_monitor is not None:
                presence_monitor.wake()
            self.send_json({"saved": True})
        except RobloxAPIError as error:
            self.send_json({"error": str(error)}, error.status)
        except (json.JSONDecodeError, TypeError) as error:
            self.send_json({"error": f"Invalid state: {error}"}, 400)
        except OSError as error:
            print(f"Could not write {STATE_FILE.name}: {error}")
            self.send_json({"error": f"Could not save {STATE_FILE.name} in the project data folder."}, 500)

    def log_message(self, format_string, *args):
        print(f"{self.address_string()} - {format_string % args}")


if __name__ == "__main__":
    presence_monitor = PresenceMonitor()
    presence_monitor.start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Roblox account dashboard: http://127.0.0.1:{PORT}")
    print(f"Watchlist and settings are saved locally in {STATE_FILE}.")
    print("Offline alerts run while this server is running; no Roblox passwords or cookies are used.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping dashboard.")
    finally:
        server.server_close()
        presence_monitor.stop()
