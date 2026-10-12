// Module ↔ real sidecar over HTTP, with real files on disk and a mock world whose documents update.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, ensureToken, createServer } from "../sidecar/server.mjs";

const lang = JSON.parse(await fsp.readFile(new URL("../lang/en.json", import.meta.url)));
const lookup = (k) => k.split(".").reduce((o, p) => o?.[p], lang) ?? k;

/* ---------- real sidecar in a temp Foundry folder ---------- */
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fs-flow-"));
const D = (...p) => path.join(root, "Data", ...p);
const exists = (p) => fsp.access(p).then(() => true, () => false);
await fsp.mkdir(D("1 - NYC"), { recursive: true });
for (const f of ["Estate Map.png", "Estate Map.webp", "Atrium.webp", "Old Sketch.png"]) await fsp.writeFile(D("1 - NYC", f), f);
await fsp.mkdir(path.join(root, "etc"));
await fsp.writeFile(path.join(root, "etc", "fs.json"), JSON.stringify({ userDataPath: root }));
const cfg = await loadConfig(path.join(root, "etc", "fs.json"));
const { token } = await ensureToken(cfg);
const server = await createServer(cfg, token, { log: {} });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

/* ---------- mock world ---------- */
const EMBEDDED = { Scene: { Level: "levels" } };
const setPath = (o, p, v) => {
  const parts = p.split(".");
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ??= {};
  o[parts.at(-1)] = v;
};
class Doc {
  constructor(documentName, src, parent = null) { Object.assign(this, { documentName, _src: src, parent }); }
  get id() { return this._src._id; }
  get name() { return this._src.name; }
  get uuid() { return this.parent ? `${this.parent.uuid}.${this.documentName}.${this.id}` : `${this.documentName}.${this.id}`; }
  toObject() { return structuredClone(this._src); }
  async update(data) { for (const [k, v] of Object.entries(data)) setPath(this._src, k, structuredClone(v)); return this; }
}
const scene = new Doc("Scene", {
  _id: "s1", name: "1.3 - Inside Mansion",
  levels: [
    { _id: "l1", name: "L-1", background: { src: "1%20-%20NYC/Estate%20Map.webp" } },
    { _id: "l2", name: "Main", background: { src: "1%20-%20NYC/Atrium.webp" } },
  ],
});
async function fromUuid(uuid) {
  const parts = uuid.split(".");
  let doc = parts[0] === "Scene" && parts[1] === "s1" ? scene : null;
  for (let i = 2; doc && i < parts.length; i += 2) {
    const child = doc._src[EMBEDDED[doc.documentName][parts[i]]]?.find((c) => c._id === parts[i + 1]);
    doc = child ? new Doc(parts[i], child, doc) : null;
  }
  return doc;
}

/* ---------- mock Foundry pointed at the real disk and the real sidecar ---------- */
class FakeFilePicker {
  static async browse(source, target) {
    const rel = decodeURIComponent(target).replace(/^\/+|\/+$/g, "");
    try {
      const entries = await fsp.readdir(D(rel), { withFileTypes: true });
      const enc = (n) => [...rel.split("/"), n].map(encodeURIComponent).join("/");
      return { dirs: entries.filter((e) => e.isDirectory()).map((e) => `${rel}/${e.name}`), files: entries.filter((e) => e.isFile()).map((e) => enc(e.name)) };
    } catch {
      return { dirs: [], files: [] };
    }
  }
}
class FakeAppV2 {
  static DEFAULT_OPTIONS = {};
  async render() {
    if (!this.rendered) { this.rendered = true; await this._onFirstRender?.(); }
    this.html = await this._renderHTML({}, {});
    this.element ??= { querySelector: () => null };
    return this;
  }
}
const answers = [];
const dialogs = [];
class FakeDialogV2 {
  static async confirm(o) { dialogs.push(o); return answers.length ? answers.shift() : true; }
  static async prompt(o) { dialogs.push(o); return answers.shift(); }
}
const store = new Map([["file-steward.caseSensitive", true]]);
const hooks = {};
globalThis.window = { location: { origin } };
globalThis.CONFIG = {};
globalThis.Hooks = { once: (n, f) => (hooks[n] = f), on: (n, f) => (hooks[n] = f) };
globalThis.ui = { notifications: { warn: (m) => (globalThis.lastWarn = m), error: (m) => { throw new Error(m); }, info: () => {} } };
globalThis.foundry = {
  applications: { api: { ApplicationV2: FakeAppV2, DialogV2: FakeDialogV2 }, apps: { FilePicker: { implementation: FakeFilePicker } } },
  utils: {
    getDocumentClass: (n) => ({ metadata: { label: n, embedded: EMBEDDED[n] ?? {} } }),
    getRoute: (p) => `/${p}`,
    fromUuid,
    randomID: () => Math.random().toString(36).slice(2, 10),
    saveDataToFile: () => {},
  },
};
globalThis.game = {
  user: { isGM: true, name: "GM" },
  world: { title: "Test" },
  i18n: { localize: lookup, format: (k, d) => lookup(k).replace(/\{(\w+)\}/g, (_, x) => d[x]) },
  settings: {
    register: (m, k, o) => { if (!store.has(`${m}.${k}`)) store.set(`${m}.${k}`, structuredClone(o.default)); },
    registerMenu: () => {},
    get: (m, k) => structuredClone(store.get(`${m}.${k}`)),
    set: async (m, k, v) => store.set(`${m}.${k}`, structuredClone(v)),
  },
  keybindings: { register: () => {} },
  collections: [Object.assign([scene], { documentName: "Scene" })],
  packs: [],
  modules: new Map([["file-steward", {}]]),
};

const { StewardApp } = await import("../scripts/app.js");
await import("../scripts/main.js");
hooks.init();
const act = StewardApp.DEFAULT_OPTIONS.actions;
const level = (id) => scene._src.levels.find((l) => l._id === id).background.src;

after(async () => {
  await new Promise((r) => server.close(r));
  await fsp.rm(root, { recursive: true, force: true });
});

test("without a token the helper is off and its buttons are hidden", async () => {
  const app = new StewardApp();
  await app.render();
  assert.equal(app.state.sidecar.state, "no-token");
  assert.doesNotMatch(app.html, /data-action="move"/);
  assert.match(app.html, /Server helper not set up/);
});

test("wrong token is reported as rejected", async () => {
  store.set("file-steward.sidecarToken", "wrong-token-wrong-token-wrong-token-xx");
  const app = new StewardApp();
  await app.render();
  await app.refreshSidecar();
  assert.equal(app.state.sidecar.state, "unauthorized");
});

let app;
test("with the token: connected, buttons shown", async () => {
  store.set("file-steward.sidecarToken", token);
  app = new StewardApp();
  await app.render();
  await app.refreshSidecar();
  assert.equal(app.state.sidecar.state, "ok");
  assert.match(app.html, /data-action="move"/);
  assert.match(app.html, /Server helper connected \(v1\.0\.0\)/);
});

test("trash one unused file from the report, then undo restores it on disk", async () => {
  app.setTarget("1 - NYC", { isFolder: true });
  await act.unused.call(app);
  assert.deepEqual(app.state.unused.map((f) => f.display).sort(), ["1 - NYC/Estate Map.png", "1 - NYC/Old Sketch.png"]);
  assert.match(app.html, /Move all to trash \(2\)/);
  await act.trashFile.call(app, null, { dataset: { path: "1%20-%20NYC/Old%20Sketch.png" } });
  assert.ok(!(await exists(D("1 - NYC", "Old Sketch.png"))));
  assert.match(app.state.status, /Moved 1 item\(s\) to trash/);
  assert.deepEqual(app.state.unused.map((f) => f.display), ["1 - NYC/Estate Map.png"], "report refreshed");
  await act.undo.call(app);
  assert.ok(await exists(D("1 - NYC", "Old Sketch.png")), "restored on disk");
  assert.match(app.state.status, /Undone: Trashed 1 - NYC\/Old Sketch.png/);
});

test("bulk trash skips anything that became used since the report", async () => {
  app.setTarget("1 - NYC", { isFolder: true });
  await act.unused.call(app); // Estate Map.png and Old Sketch.png unused
  scene._src.levels[1].background.src = "1%20-%20NYC/Old%20Sketch.png"; // GM uses one meanwhile
  await act.trashAllUnused.call(app);
  assert.ok(await exists(D("1 - NYC", "Old Sketch.png")), "in-use file kept");
  assert.ok(!(await exists(D("1 - NYC", "Estate Map.png"))), "unused file trashed");
  assert.match(app.state.notes[0], /became used since the report/);
  scene._src.levels[1].background.src = "1%20-%20NYC/Atrium.webp";
  await act.undo.call(app);
  assert.ok(await exists(D("1 - NYC", "Estate Map.png")));
});

test("trashing a file that is in use needs a second, explicit yes", async () => {
  app.setTarget("1%20-%20NYC/Atrium.webp", { isFolder: false });
  dialogs.length = 0;
  answers.push(false); // "Keep it"
  await act.trashTarget.call(app);
  assert.ok(await exists(D("1 - NYC", "Atrium.webp")));
  assert.equal(dialogs[0].window.title, "Still in use");
  assert.match(app.state.status, /Cancelled/);
});

test("move a used file: copied, Level relinked, original trashed; undo reverses all of it", async () => {
  app.setTarget("1%20-%20NYC/Estate%20Map.webp", { isFolder: false });
  answers.push("maps/zanatosa/L-1 Estate.webp", true); // prompt, then confirm
  await act.move.call(app);
  assert.ok(await exists(D("maps", "zanatosa", "L-1 Estate.webp")), "copy exists");
  assert.ok(!(await exists(D("1 - NYC", "Estate Map.webp"))), "original trashed");
  assert.equal(level("l1"), "maps/zanatosa/L-1%20Estate.webp", "relinked in the stored (encoded) spelling");
  assert.match(app.state.status, /^Moved to maps\/zanatosa\/L-1 Estate.webp; 1 reference updated/);
  assert.equal(app.state.display, "maps/zanatosa/L-1 Estate.webp", "window follows the file");

  await act.undo.call(app);
  assert.equal(level("l1"), "1%20-%20NYC/Estate%20Map.webp");
  assert.ok(await exists(D("1 - NYC", "Estate Map.webp")), "original back");
  assert.ok(!(await exists(D("maps", "zanatosa", "L-1 Estate.webp"))), "copy moved to trash, not deleted");
});

test("move refuses to overwrite an existing file and changes nothing", async () => {
  const before = level("l1");
  app.setTarget("1%20-%20NYC/Estate%20Map.webp", { isFolder: false });
  answers.push("1 - NYC/Atrium.webp", true);
  await assert.rejects(act.move.call(app), /already exists/);
  assert.equal(level("l1"), before);
  assert.ok(await exists(D("1 - NYC", "Estate Map.webp")));
});

test("trash view: list, restore one, empty the rest", async () => {
  await act.showTrash.call(app);
  assert.equal(app.state.mode, "trash");
  assert.ok(app.state.trash.length >= 1);
  assert.match(app.html, /Empty trash/);
  const copy = app.state.trash.find((t) => t.path === "maps/zanatosa/L-1 Estate.webp");
  await act.restoreItem.call(app, null, { dataset: { id: copy.id } });
  assert.ok(await exists(D("maps", "zanatosa", "L-1 Estate.webp")));
  assert.match(app.state.status, /Restored to maps\/zanatosa\/L-1 Estate.webp/);
  await act.trashFile.call(app, null, { dataset: { path: "1%20-%20NYC/Old%20Sketch.png" } });
  await act.showTrash.call(app);
  assert.equal(app.state.trash.length, 1);
  dialogs.length = 0;
  await act.purgeAll.call(app);
  assert.equal(dialogs[0].window.title, "Delete forever");
  assert.equal(app.state.trash.length, 0);
  assert.match(app.html, /The trash is empty/);
  assert.ok(!(await exists(D("1 - NYC", "Old Sketch.png"))), "purged for real");
});

test("toolbar button in v13 object shape and v12 array shape, GM only", () => {
  const v13 = { tokens: { tools: { select: {} } }, tiles: { tools: { select: {} } }, walls: { tools: {} } };
  hooks.getSceneControlButtons(v13);
  assert.equal(v13.tokens.tools["file-steward"].icon, "fa-solid fa-folder-tree");
  assert.ok(v13.tiles.tools["file-steward"].button);
  assert.equal(v13.walls.tools["file-steward"], undefined);
  const v12 = [{ name: "token", tools: [] }, { name: "tiles", tools: [] }];
  hooks.getSceneControlButtons(v12);
  assert.equal(v12[0].tools[0].name, "file-steward");
  game.user.isGM = false;
  const p = { tokens: { tools: {} } };
  hooks.getSceneControlButtons(p);
  assert.equal(p.tokens.tools["file-steward"], undefined, "players don't get the button");
  game.user.isGM = true;
});
