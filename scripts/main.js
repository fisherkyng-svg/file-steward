/**
 * File Steward — entry point (GM only).
 */
import { StewardApp } from "./app.js";
import { MODULE_ID, buildWorldIndex } from "./foundry/world.js";
import { normalizeFolder } from "./core/paths.js";
import { registerHistorySetting, getHistory } from "./foundry/rewrite.js";
import { registerSidecarSettings, probe } from "./foundry/sidecar.js";

let app = null;

function open(path, options = {}) {
  if (!game.user?.isGM) {
    ui.notifications.warn(game.i18n.localize("FILESTEWARD.GMOnly"));
    return null;
  }
  app ??= new StewardApp();
  if (path !== undefined) app.setTarget(path, options);
  const wasRendered = app.rendered;
  app.render(true);
  if (wasRendered && app.state.sidecar.state !== "ok") app.refreshSidecar();
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
  /** Recent File Steward changes, newest first. */
  history: () => getHistory(),
  /** Is the server helper reachable with this browser's token? */
  sidecarStatus: () => probe(),
  async findReferences(path, { folder } = {}) {
    if (!game.user?.isGM) throw new Error("File Steward is GM-only");
    const { index, normalize } = await buildWorldIndex();
    const isFolder = folder ?? (path.endsWith("/") || !/\.[a-z0-9]{2,5}$/i.test(path));
    const key = isFolder ? normalizeFolder(normalize, path) : normalize(path, { requireExtension: false });
    return isFolder ? index.findFolder(key) : index.findFile(key);
  },
};

Hooks.once("init", () => {
  registerHistorySetting();
  registerSidecarSettings();
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

/**
 * Toolbar button for the GM, added to every control group (Tokens, Tiles, Walls, Lighting, …)
 * so it's visible whichever layer is active. v13+ passes controls as an object keyed by name;
 * v12 passed an array.
 */
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;
  const make = (order) => ({
    name: "file-steward",
    title: "FILESTEWARD.Toolbar",
    icon: "fa-solid fa-folder-tree",
    order,
    button: true,
    visible: true,
    onChange: () => open(),
    onClick: () => open(), // v12
  });
  const groups = Array.isArray(controls) ? controls : Object.values(controls ?? {});
  for (const group of groups) {
    if (!group?.tools) continue;
    if (Array.isArray(group.tools)) group.tools.push(make(group.tools.length));
    else group.tools["file-steward"] = make(Object.keys(group.tools).length);
  }
});
