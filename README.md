# File Steward

GM-only file housekeeping for Foundry VTT v13–v14.

- **Find references:** pick a file or folder and see every scene, scene level, token, tile, actor, item, journal page, playlist sound, macro, table, chat message and world setting that points at it. Click a document name to open its sheet.
- **Find unused files:** pick a folder and list the files nothing in this world uses. Files with a used twin (same name, different type, e.g. `map.webp` next to a used `map.png`) are marked.
- **Relink** *(0.2)*: point everything that uses a file or folder at another one. Preview first, then one confirmation.
- **Switch all to WebP** *(0.2)*: from the unused report, relink every used `.png`/`.jpg` to its `.webp` twin in one step. It never switches the other way in bulk.
- **Undo** *(0.2)*: puts back every field the last change touched. A field edited by hand since then is left alone and reported.
- **Export CSV** of either report.
- **With the server helper** *(0.3)*: **Move / rename** a file or folder and update everything that uses it, **Move to trash** (blocked while the file is still used), a **Trash** view to restore or permanently delete, and bulk **Move all to trash** from the unused report.

Relink, move and trash never change scene size, padding, walls or lights; they only change file paths.

> **Before your first relink,** back up the world folder (`Data/worlds/<world>`). Undo covers the operations File Steward logs, but a backup covers everything.

## Install

In Foundry: **Add-on Modules → Install Module**, paste this manifest URL, and install:

```
https://github.com/fisherkyng-svg/file-steward/releases/latest/download/module.json
```

Enable **File Steward** in the world's Manage Modules. Updates arrive through **Check for Updates**.

## Releasing

Bump `"version"` in `module.json` and push to `main`. The Release workflow runs the tests, tags `v<version>`, and publishes `module.json` plus `file-steward.zip`. It skips versions already released, and can be run by hand from the Actions tab.

## Open it

- **Toolbar:** the folder-tree icon in the left-hand controls, on the Token and Tile layers (GM only)
- **Game Settings → Configure Settings → File Steward → Open File Steward**
- **Controls → Configure Controls → File Steward**: assign a key (unbound by default)
- **Macro:**
  ```js
  game.modules.get("file-steward").api.open("assets/maps/");
  ```

## Server helper (optional, self-hosted Linux)

Foundry doesn't let modules move or delete files, so those features need a small helper process next to Foundry: one Node file, no dependencies, listening only on `127.0.0.1`. Without it, everything above the "With the server helper" line still works.

**Install** (Ubuntu/Debian with systemd; needs Node 18+, which Foundry already requires):

```bash
curl -fsSLO https://github.com/fisherkyng-svg/file-steward/releases/latest/download/install.sh
curl -fsSLO https://github.com/fisherkyng-svg/file-steward/releases/latest/download/server.mjs
less install.sh        # read it before running it as root
sudo bash install.sh
```

The installer finds Foundry's data folder and the user Foundry runs as (it asks if it can't), installs a sandboxed `file-steward` systemd service, and prints two things:

1. **One proxy line.** It detects Caddy or nginx and prints the exact route to add, but never edits your proxy itself. For Caddy it's
   `reverse_proxy /file-steward/api/* 127.0.0.1:30013` inside your Foundry site block, then `sudo systemctl reload caddy`.
2. **A token.** Paste it into **Configure Settings → File Steward → Server helper token**. It's stored only in that browser; players never receive it.

Then open File Steward and click the server line under the buttons; it should say *connected*.

**Upgrade:** download both files again and rerun `sudo bash install.sh`; config and token are kept.
**Uninstall:** `sudo bash install.sh --uninstall` (keeps the trash folder, config and token).

### Docker setup (Foundry and the proxy in containers)

If Foundry runs in Docker (for example `felddy/foundryvtt`), run the helper as one more service in the same compose file, so your proxy container can reach it by name. `install.sh` detects this and prints these steps with your real paths and file owner filled in.

```yaml
  file-steward:
    image: node:20-alpine
    user: "1000:1000"            # owner of your Data folder: stat -c '%u:%g' <data>/Data
    restart: unless-stopped
    read_only: true
    security_opt: ["no-new-privileges:true"]
    command: ["node", "/app/server.mjs"]
    environment:
      FILE_STEWARD_CONFIG: /config/file-steward.json
    volumes:
      - /opt/foundry/vtm/data/Data:/foundrydata/Data
      - /opt/foundry/vtm/data/FileStewardTrash:/foundrydata/FileStewardTrash
      - /opt/foundry/file-steward/server.mjs:/app/server.mjs:ro
      - /opt/foundry/file-steward/config:/config
```

Config (`/opt/foundry/file-steward/config/file-steward.json`):
`{"userDataPath": "/foundrydata", "trashPath": "/foundrydata/FileStewardTrash", "host": "0.0.0.0", "port": 30013}`

It mounts only `Data/` and the trash, not Foundry's `Config/` or license. It publishes no port, so only containers on the compose network can reach it. Start it with `docker compose up -d file-steward`; the first log line shows the token (`docker compose logs file-steward`). In Caddy, add `reverse_proxy /file-steward/api/* file-steward:30013` to the Foundry site block and reload.

### How the helper is locked down

| Protection | Detail |
| --- | --- |
| Token | 256-bit, compared in constant time; 10 bad tries from one address locks it out for 10 minutes |
| Network | Binds to `127.0.0.1`; reachable only through your proxy, over the same HTTPS as Foundry |
| Path jail | Every path is resolved (symlinks too) and must stay inside `Data/`; `../` tricks are refused |
| Off limits | `modules/`, `systems/`, world folders themselves, and world databases (`data/`, `packs/`, `world.json`) |
| No overwrite | Move, copy and restore refuse to replace an existing file |
| Trash, not delete | Trashed items go to `FileStewardTrash/` beside `Data/` (not served by Foundry); only "Delete forever" removes them |
| Sandbox | systemd `ProtectSystem=strict`; writable paths are only `Data/`, the trash and its config folder |
| Audit | Every operation is appended to `FileStewardTrash/audit.jsonl` |

### Config (`/etc/file-steward/file-steward.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `userDataPath` | detected | Foundry's User Data Path (contains `Data/`) |
| `trashPath` | `<userDataPath>/FileStewardTrash` | Must be outside `Data/` |
| `port` / `host` | `30013` / `127.0.0.1` | Where the helper listens |
| `allowedRoots` | `["*"]` | Limit to folders, e.g. `["assets", "1 - New York City"]` |
| `retentionDays` | `null` | Purge trash older than N days automatically; `null` keeps it until you empty it |
| `allowOrigin` | `null` | Only for running without a proxy (see below) |

After editing: `sudo systemctl restart file-steward`.

**Without a proxy** (Foundry on your own desktop): set `"allowOrigin": "http://localhost:30000"` and in Foundry set **Server helper URL** to `http://localhost:30013`.

### How move stays safe

1. Scan references to the old path, show the count, and confirm.
2. **Copy** the file or folder to the new path on the server (refuses if something is already there).
3. Relink every reference to the copy, keeping each stored spelling.
4. Rescan. Only if nothing points at the original does it go to trash; otherwise it's kept and the leftovers are listed.
5. Log it. **Undo** restores the fields, brings the original back from trash, and sends the copy to trash.

## How relink stays safe

1. It scans the world and finds every reference to the old path.
2. It checks each destination file exists. References whose destination is missing are skipped, never pointed at nothing.
3. It rewrites the path in the spelling it was stored in (`floor%202.webp` stays encoded, `floor 2.webp` stays plain) and refuses values it can't match cleanly.
4. You confirm the preview. Nothing is written before that.
5. It records the before and after value of every changed field (last 10 operations, kept in the world).
6. It rescans and reports any reference still pointing at the old path.

Not rewritten: the world background in world.json (change it in the world's configuration), compendium packs, and paths in module or system code.

## Macro API

```js
const fs = game.modules.get("file-steward").api;
const refs = await fs.findReferences("assets/tokens/guard.webp");
const folderRefs = await fs.findReferences("assets/maps/old-manor/", { folder: true });
// each ref: { rootLabel, rootType, rootUuid, uuid, chain, field, kind, raw, normalized }
fs.history(); // recent relinks, newest first
```

## What it scans

Every world document and its embedded documents (tokens and their actor deltas, tiles, sounds, notes, regions, items, effects, journal pages, playlist sounds), the world background, and world settings. It matches:

| Match | Example |
| --- | --- |
| Field | `texture.src = "assets/tokens/guard.webp"` |
| In HTML | `<img src="assets/handouts/letter.webp">` in a journal page |
| In text | `"assets/sfx/door.ogg"` inside a macro's code |

Paths are matched with and without URL encoding (`floor 2.webp` = `floor%202.webp`), as relative or absolute URLs on this server, and with Foundry's route prefix removed.

## Limits

- Only the open world is scanned. Another world on the same server may use a "unused" file.
- Compendium packs are not scanned.
- Files used only by module or system code, CSS, or hard-coded paths show as unused.
- "Find unused files" stops at 20,000 files and does not support S3.

Treat the unused list as candidates to review, not a delete list.

## Development

Core logic in `scripts/core/` is free of Foundry globals and covered by Node tests:

```bash
npm test
```
