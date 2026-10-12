/**
 * File Steward — entry point. Phase 1: read-only reference scanner (GM only).
 */
import { StewardApp } from "./app.js";
import { MODULE_ID, buildWorldIndex } from "./foundry/world.js";
import { normalizeFolder } from "./core/paths.js";

let app = null;

function open(path, options = {}) {
  if (!game.user?.isGM) {
    ui.notifications.warn(game.i18n.localize("FILESTEWARD.GMOnly"));
    return null;
  }
  app ??= new StewardApp();
  if (path !== undefined) app.setTarget(path, options);
  app.render(true);
  return app;
}

/** Wrapper so the settings menu opens the shared window instead of a second copy. */
class OpenStewardMenu extends StewardApp {
  static DEFAULT_OPTIONS = { id: "file-steward-menu" };
  render() {
    open(); // never shows itself; renders the shared window
    return this;
  }
}

/**
 * Macro API: game.modules.get("file-steward").api
 *   .open("assets/maps/")                         open the window on a target
 *   .findReferences("assets/maps/a.webp")         → reference list
 *   .findReferences("assets/maps/", {folder:true})
 */
const api = {
  open,
  async findReferences(path, { folder } = {}) {
    if (!game.user?.isGM) throw new Error("File Steward is GM-only");
    const { index, normalize } = await buildWorldIndex();
    const isFolder = folder ?? (path.endsWith("/") || !/\.[a-z0-9]{2,5}$/i.test(path));
    const key = isFolder ? normalizeFolder(normalize, path) : normalize(path, { requireExtension: false });
    return isFolder ? index.findFolder(key) : index.findFile(key);
  },
};

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "caseSensitive", {
    name: "FILESTEWARD.Settings.CaseSensitive.Name",
    hint: "FILESTEWARD.Settings.CaseSensitive.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.registerMenu(MODULE_ID, "openWindow", {
    name: "FILESTEWARD.Settings.Menu.Name",
    label: "FILESTEWARD.Settings.Menu.Label",
    hint: "FILESTEWARD.Settings.Menu.Hint",
    icon: "fa-solid fa-folder-tree",
    type: OpenStewardMenu,
    restricted: true,
  });

  game.keybindings.register(MODULE_ID, "openWindow", {
    name: "FILESTEWARD.Keybinding.Name",
    hint: "FILESTEWARD.Keybinding.Hint",
    editable: [],
    restricted: true,
    onDown: () => {
      open();
      return true;
    },
  });

  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
});
