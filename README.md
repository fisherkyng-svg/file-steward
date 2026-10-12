# File Steward

GM-only file housekeeping for Foundry VTT v13–v14.

- **Find references:** pick a file or folder and see every scene, scene level, token, tile, actor, item, journal page, playlist sound, macro, table, chat message and world setting that points at it. Click a document name to open its sheet.
- **Find unused files:** pick a folder and list the files nothing in this world uses. Files with a used twin (same name, different type, e.g. `map.webp` next to a used `map.png`) are marked.
- **Relink** *(0.2)*: point everything that uses a file or folder at another one. Preview first, then one confirmation.
- **Switch all to WebP** *(0.2)*: from the unused report, relink every used `.png`/`.jpg` to its `.webp` twin in one step. It never switches the other way in bulk.
- **Undo** *(0.2)*: puts back every field the last change touched. A field edited by hand since then is left alone and reported.
- **Export CSV** of either report.

File Steward never deletes, moves or uploads files yet. Relink only rewrites paths stored in documents; it does not change scene size, padding, walls or lights.

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

- **Game Settings → Configure Settings → File Steward → Open File Steward**
- **Controls → Configure Controls → File Steward**: assign a key (unbound by default)
- **Macro:**
  ```js
  game.modules.get("file-steward").api.open("assets/maps/");
  ```

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
