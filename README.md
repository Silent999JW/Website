# Playerwatch

A local Roblox account dashboard for watching public profile details, online/game presence, and collectible RAP estimates.

## Run

1. Install Python 3.9 or later if it is not already installed.
2. In this folder, run `py main.py` (or `python main.py`).
3. Open [http://127.0.0.1:8989](http://127.0.0.1:8989).
4. Add accounts by Roblox username or numeric user ID. Stop the server with `Ctrl+C`.

The watchlist, favorites, and preferences are saved in `data\playerwatch.json` in the project folder (migrated from browser storage on first launch). Use the list/grid toggle to change the roster layout. Settings offers ten animated gradient previews and complete dashboard themes, including a Halloween-inspired spooky theme. It also lets you pause automatic status checks, set their interval, show or hide account IDs, enable compact roster rows, reduce animation, and configure Discord webhook alerts. Star accounts to add them to the offline-alert watchlist. While this server is running and automatic status checks are enabled, favorite accounts are checked for online-to-offline changes; alerts are sent as detailed Discord embeds with the account name, Roblox avatar, profile link, username/ID, profile description, join date, previous status, and available collectible/RAP estimate, and can ping a specific Discord user or role. Pausing automatic status checks also pauses background offline alerts; you can still manually refresh presence. The optional webhook test sends a branded test embed. The local JSON file contains the webhook URL, so keep it private. No Roblox passwords or cookies are used.

Add multiple accounts at once by separating usernames/IDs with commas or putting one on each line (up to 25 per batch).

## Data availability

Roblox controls whether presence and inventory endpoints are accessible and how often they can be queried. A profile or avatar may be public while presence or inventory is restricted. In those cases the dashboard reports unavailable data rather than guessing. Collectible RAP is an estimate from publicly accessible collectibles, not a valuation of limiteds or the full inventory; scans are capped at 1,000 items per account.
