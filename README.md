# File Steward

GM-only file housekeeping for Foundry VTT v13–v14.

**Phase 1 (0.1.x) is read-only.** It never changes a file or a document.

- **Find references:** pick a file or folder and see every scene, token, tile, actor, item, journal page, playlist sound, macro, table, chat message and world setting that points at it. Click a document name to open its sheet.
- **Find unused files:** pick a folder and list the files nothing in this world uses.
- **Export CSV** of either report.

Move, rename, delete-to-trash and reference rewriting arrive in later phases.

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

## Macro API

```js
const fs = game.modules.get("file-steward").api;
const refs = await fs.findReferences("assets/tokens/guard.webp");
const folderRefs = await fs.findReferences("assets/maps/old-manor/", { folder: true });
// each ref: { rootLabel, rootType, rootUuid, uuid, chain, field, kind, raw, normalized }
```

## What it scans

Every world document and its embedded documents (tokens and their actor deltas, tiles, sounds, notes, regions, items, effects, journal pages, playlist sounds), the world background, and world settings. It matches:

| Match | Example |
| --- | --- |
| Field | `texture.src = "assets/tokens/guard.webp"` |
| In HTML | `<img src="assets/handouts/letter.webp">` in a journal page |
| In text | `"assets/sfx/door.ogg"` inside a macro's code |

Paths are matched with and without URL encoding (`floor 2.webp` = `floor%202.webp`), as relative or absolute URLs on this server, and with Foundry's route prefix removed.

## Limits (Phase 1)

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
