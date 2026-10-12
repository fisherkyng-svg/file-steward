// Smoke test of the Foundry layer against a minimal mock of v13/v14 globals.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const lang = JSON.parse(fs.readFileSync(new URL("../lang/en.json", import.meta.url)));
const lookup = (k) => k.split(".").reduce((o, p) => o?.[p], lang) ?? k;

const hooks = {};
const settings = new Map([["file-steward.caseSensitive", true]]);
const embedded = {
  Scene: { Token: "tokens", Tile: "tiles", AmbientSound: "sounds" },
  Token: { ActorDelta: "delta" },
  ActorDelta: { Item: "items" },
  Actor: { Item: "items" },
  JournalEntry: { JournalEntryPage: "pages" },
};
const cls = (name) => ({ metadata: { label: `DOCUMENT.${name}`, embedded: embedded[name] ?? {} } });
const doc = (docName, data) => ({ ...data, id: data._id, uuid: `${docName}.${data._id}`, toObject: () => structuredClone(data), sheet: { render() { this.opened = true; } } });
const coll = (documentName, docs) => Object.assign(docs, { documentName });

const scenes = coll("Scene", [doc("Scene", {
  _id: "s1", name: "Old Manor L1", background: { src: "assets/maps/old%20manor/L1.webp" },
  tokens: [{ _id: "t1", name: "Guard", texture: { src: "assets/tokens/guard.webp" } }],
  tiles: [], sounds: [],
})]);
const actors = coll("Actor", [doc("Actor", {
  _id: "a1", name: "Guard", img: "assets/tokens/guard.webp", prototypeToken: { texture: { src: "assets/tokens/guard.webp" } }, items: [],
})]);
const journal = coll("JournalEntry", [doc("JournalEntry", {
  _id: "j1", name: "Handouts",
  pages: [{ _id: "p1", name: "Letter", text: { content: '<p><img src="/assets/maps/old%20manor/L1.webp"></p>' } }],
})]);
const settingsColl = coll("Setting", [doc("Setting", { _id: "x1", key: "core.logo", value: '"assets/ui/logo.webp"' })]);
settingsColl[0].key = "core.logo";

const fileTree = {
  "assets/maps/old manor": { dirs: [], files: ["assets/maps/old%20manor/L1.webp", "assets/maps/old%20manor/L2.webp"] },
  assets: { dirs: ["assets/maps/old manor", "assets/ui"], files: ["assets/readme.txt"] },
  "assets/ui": { dirs: [], files: ["assets/ui/logo.webp", "assets/ui/old-logo.webp"] },
};

class FakeFilePicker {
  static async browse(source, target) { return fileTree[target] ?? { dirs: [], files: [] }; }
}
class FakeAppV2 {
  static DEFAULT_OPTIONS = {};
  constructor() { this.element = null; }
  async render() {
    const html = await this._renderHTML({}, {});
    this.element ??= { querySelector: () => null };
    this.html = html;
    return this;
  }
}

globalThis.window = { location: { origin: "https://vtm.example.net" } };
globalThis.CONFIG = {};
globalThis.Hooks = { once: (n, fn) => (hooks[n] = fn), on: (n, fn) => (hooks[n] = fn) };
globalThis.ui = { notifications: { warn: (m) => (globalThis.lastWarn = m), error: (m) => { throw new Error(m); }, info: () => {} } };
globalThis.foundry = {
  applications: { api: { ApplicationV2: FakeAppV2 }, apps: { FilePicker: { implementation: FakeFilePicker } } },
  utils: {
    getDocumentClass: cls,
    getRoute: (p) => p,
    fromUuid: async (u) => [...scenes, ...actors, ...journal].find((d) => d.uuid === u) ?? null,
    saveDataToFile: (data, type, name) => (globalThis.saved = { data, type, name }),
  },
};
const registered = {};
globalThis.game = {
  user: { isGM: true },
  world: { title: "Test", background: "assets/ui/logo.webp" },
  i18n: {
    localize: lookup,
    format: (k, d) => lookup(k).replace(/\{(\w+)\}/g, (_, x) => d[x]),
  },
  settings: {
    register: (m, k, o) => (registered[`${m}.${k}`] = o),
    registerMenu: (m, k, o) => (registered[`menu:${m}.${k}`] = o),
    get: (m, k) => settings.get(`${m}.${k}`),
  },
  keybindings: { register: (m, k, o) => (registered[`key:${m}.${k}`] = o) },
  collections: [scenes, actors, journal, settingsColl],
  packs: [],
  modules: new Map([["file-steward", {}]]),
};

const { StewardApp } = await import("../scripts/app.js");
await import("../scripts/main.js");
hooks.init();

test("init registers setting, GM-only menu, keybinding and API", () => {
  assert.equal(registered["file-steward.caseSensitive"].default, true);
  assert.equal(registered["menu:file-steward.openWindow"].restricted, true);
  assert.equal(registered["key:file-steward.openWindow"].restricted, true);
  assert.equal(typeof game.modules.get("file-steward").api.findReferences, "function");
});

test("API finds a file across token, actor img and prototype token", async () => {
  const refs = await game.modules.get("file-steward").api.findReferences("assets/tokens/guard.webp");
  assert.deepEqual(refs.map((r) => `${r.uuid}|${r.field}`).sort(), [
    "Actor.a1|img", "Actor.a1|prototypeToken.texture.src", "Scene.s1.Token.t1|texture.src",
  ]);
});

test("encoded folder match includes the journal HTML reference", async () => {
  const refs = await game.modules.get("file-steward").api.findReferences("assets/maps/old manor/");
  assert.equal(refs.length, 2);
  assert.ok(refs.some((r) => r.kind === "html" && r.uuid === "JournalEntry.j1.JournalEntryPage.p1"));
});

test("window: scan, unused, export, open sheet", async () => {
  const app = new StewardApp();
  const act = StewardApp.DEFAULT_OPTIONS.actions;
  app.setTarget("assets/maps/old manor/L1.webp");
  await app.render();
  await act.scan.call(app);
  assert.equal(app.state.refs.length, 2);
  assert.match(app.state.status, /^2 references in 2 documents/);

  // a single hit reads in the singular, and an encoded picker path is shown decoded
  app.setTarget("assets/tokens/guard.webp".replace("guard", "gu%61rd"));
  assert.equal(app.state.display, "assets/tokens/guard.webp");
  app.setTarget("assets/maps/old%20manor/L1.webp");
  await app.render();
  assert.match(app.html, /value="assets\/maps\/old manor\/L1.webp"/);
  journal[0].pages = [];
  const j = journal[0]; const orig = j.toObject; j.toObject = () => ({ ...orig(), pages: [] });
  await act.scan.call(app);
  assert.match(app.state.status, /^1 reference in 1 document \(/);
  j.toObject = orig;
  assert.match(app.html, /Old Manor L1/);

  app.setTarget("assets", { isFolder: true });
  await act.unused.call(app);
  const unused = app.state.unused.map((f) => f.display);
  // logo.webp is used by the world background and a setting; L1 by scene + journal
  assert.deepEqual(unused, ["assets/maps/old manor/L2.webp", "assets/readme.txt", "assets/ui/old-logo.webp"]);

  act.exportCsv.call(app);
  assert.equal(globalThis.saved.type, "text/csv");
  assert.match(globalThis.saved.data, /^file,used_twin\n"assets\/maps\/old manor\/L2.webp",""/);

  await act.openRef.call(app, null, { dataset: { uuid: "Scene.s1", root: "Scene.s1" } });
  assert.equal(scenes[0].sheet.opened, true);
});

test("unused requires a folder", async () => {
  const app = new StewardApp();
  app.setTarget("assets/ui/logo.webp");
  await StewardApp.DEFAULT_OPTIONS.actions.unused.call(app);
  assert.match(globalThis.lastWarn, /works on a folder/);
});
