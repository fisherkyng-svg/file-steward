// End-to-end relink + undo against a mock world whose documents really update.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const lang = JSON.parse(fs.readFileSync(new URL("../lang/en.json", import.meta.url)));
const lookup = (k) => k.split(".").reduce((o, p) => o?.[p], lang) ?? k;

/* ---------- mock documents ---------- */
const EMBEDDED = {
  Scene: { Level: "levels", Token: "tokens" },
  JournalEntry: { JournalEntryPage: "pages" },
  Actor: { Item: "items" },
};
const setPath = (o, path, v) => {
  const p = path.split(".");
  for (let i = 0; i < p.length - 1; i++) o = o[p[i]] ??= {};
  o[p.at(-1)] = v;
};
class Doc {
  constructor(documentName, src, parent = null) {
    this.documentName = documentName;
    this._src = src;
    this.parent = parent;
    this.updates = 0;
  }
  get id() { return this._src._id; }
  get name() { return this._src.name; }
  get key() { return this._src.key; }
  get value() { return this._src.value; }
  get uuid() { return this.parent ? `${this.parent.uuid}.${this.documentName}.${this.id}` : `${this.documentName}.${this.id}`; }
  toObject() { return structuredClone(this._src); }
  async update(data) {
    for (const [k, v] of Object.entries(data)) setPath(this._src, k, structuredClone(v));
    this.updates++;
    return this;
  }
}
const coll = (documentName, docs) => Object.assign(docs, { documentName });

const scene = new Doc("Scene", {
  _id: "s1", name: "1.3 - Inside Mansion",
  levels: [
    { _id: "l1", name: "L-1 Victorian Underground", background: { src: "1%20-%20NYC/Estate%20Map.png" } },
    { _id: "l2", name: "Main", background: { src: "1%20-%20NYC/Atrium.webp" } },
  ],
  tokens: [],
});
const journal = new Doc("JournalEntry", {
  _id: "j1", name: "Handouts",
  pages: [{ _id: "p1", name: "Map", text: { content: '<p><img src="1%20-%20NYC/Estate%20Map.png"> and <a href="1%20-%20NYC/Estate%20Map.png">link</a></p>' } }],
});
const actor = new Doc("Actor", {
  _id: "a1", name: "Zsolt", img: "tokens/zsolt.webp",
  flags: { gallery: { images: [{ src: "tokens/zsolt-old.png" }, { src: "1 - NYC/Estate Map.png" }] } },
  items: [],
});
const setting = new Doc("Setting", { _id: "x1", key: "mymod.bg", value: JSON.stringify({ bg: "1 - NYC/Estate Map.png", n: 3 }) });
const roots = { Scene: [scene], JournalEntry: [journal], Actor: [actor], Setting: [setting] };

async function fromUuid(uuid) {
  const parts = uuid.split(".");
  let doc = roots[parts[0]]?.find((d) => d.id === parts[1]);
  for (let i = 2; doc && i < parts.length; i += 2) {
    const field = EMBEDDED[doc.documentName]?.[parts[i]];
    const child = doc._src[field]?.find((c) => c._id === parts[i + 1]);
    doc = child ? new Doc(parts[i], child, doc) : null;
  }
  return doc ?? null;
}

/* ---------- mock Foundry ---------- */
const files = {
  "1 - NYC": ["1%20-%20NYC/Estate%20Map.png", "1%20-%20NYC/Estate%20Map.webp", "1%20-%20NYC/Atrium.webp", "1%20-%20NYC/Atrium.png"],
};
class FakeFilePicker {
  static async browse(source, target) {
    const t = decodeURIComponent(target);
    return { dirs: [], files: files[t] ?? [] };
  }
}
class FakeAppV2 {
  static DEFAULT_OPTIONS = {};
  async render() {
    this.html = await this._renderHTML({}, {});
    this.element ??= { querySelector: () => null };
    return this;
  }
}
let confirmAnswer = true;
const dialogs = [];
class FakeDialogV2 {
  static async confirm(opts) { dialogs.push(opts); return confirmAnswer; }
}

const store = new Map([["file-steward.caseSensitive", true]]);
const registered = {};
const hooks = {};
globalThis.window = { location: { origin: "https://vtm.example.net" } };
globalThis.CONFIG = {};
globalThis.Hooks = { once: (n, fn) => (hooks[n] = fn), on: (n, fn) => (hooks[n] = fn) };
globalThis.ui = { notifications: { warn: (m) => (globalThis.lastWarn = m), error: (m) => { throw new Error(m); }, info: () => {} } };
globalThis.foundry = {
  applications: { api: { ApplicationV2: FakeAppV2, DialogV2: FakeDialogV2 }, apps: { FilePicker: { implementation: FakeFilePicker } } },
  utils: {
    getDocumentClass: (n) => ({ metadata: { label: n, embedded: Object.fromEntries(Object.entries(EMBEDDED[n] ?? {})) } }),
    getRoute: (p) => p,
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
    register: (m, k, o) => { registered[`${m}.${k}`] = o; if (!store.has(`${m}.${k}`)) store.set(`${m}.${k}`, structuredClone(o.default)); },
    registerMenu: () => {},
    get: (m, k) => structuredClone(store.get(`${m}.${k}`)),
    set: async (m, k, v) => store.set(`${m}.${k}`, structuredClone(v)),
  },
  keybindings: { register: () => {} },
  collections: [coll("Scene", [scene]), coll("JournalEntry", [journal]), coll("Actor", [actor]), coll("Setting", [setting])],
  packs: [],
  modules: new Map([["file-steward", {}]]),
};

const { StewardApp } = await import("../scripts/app.js");
await import("../scripts/main.js");
hooks.init();
const act = StewardApp.DEFAULT_OPTIONS.actions;

const levelSrc = (id) => scene._src.levels.find((l) => l._id === id).background.src;
const pageHtml = () => journal._src.pages[0].text.content;
const snapshot = () => JSON.stringify([scene._src, journal._src, actor._src, setting._src]);

test("unused report marks the .webp as twin of the used .png", async () => {
  const app = new StewardApp();
  app.setTarget("1 - NYC", { isFolder: true });
  await act.unused.call(app);
  const row = app.state.unused.find((f) => f.display === "1 - NYC/Estate Map.webp");
  assert.ok(row, "webp listed as unused");
  assert.equal(row.twin, "1%20-%20NYC/Estate%20Map.png");
  assert.match(app.html, /Switch all to WebP \(1\)/); // Atrium.png is a twin too, but not a WebP upgrade
});

test("cancelling the confirm changes nothing", async () => {
  const before = snapshot();
  const app = new StewardApp();
  confirmAnswer = false;
  await act.relinkTwin.call(app, null, { dataset: { from: "1%20-%20NYC/Estate%20Map.png", to: "1%20-%20NYC/Estate%20Map.webp" } });
  confirmAnswer = true;
  assert.equal(snapshot(), before);
  assert.match(app.state.status, /Cancelled/);
});

test("relink rewrites Level, journal HTML, actor flag array and setting JSON, keeping spelling", async () => {
  const app = new StewardApp();
  app.setTarget("1 - NYC", { isFolder: true });
  await act.unused.call(app);
  dialogs.length = 0;
  await act.relinkTwin.call(app, null, { dataset: { from: "1%20-%20NYC/Estate%20Map.png", to: "1%20-%20NYC/Estate%20Map.webp" } });

  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].content, /Change 4 references in 4 documents/);
  assert.equal(levelSrc("l1"), "1%20-%20NYC/Estate%20Map.webp", "encoded spelling kept");
  assert.equal(levelSrc("l2"), "1%20-%20NYC/Atrium.webp", "other level untouched");
  assert.equal(pageHtml(), '<p><img src="1%20-%20NYC/Estate%20Map.webp"> and <a href="1%20-%20NYC/Estate%20Map.webp">link</a></p>');
  assert.deepEqual(actor._src.flags.gallery.images, [{ src: "tokens/zsolt-old.png" }, { src: "1 - NYC/Estate Map.webp" }]);
  assert.deepEqual(JSON.parse(setting._src.value), { bg: "1 - NYC/Estate Map.webp", n: 3 });
  assert.match(app.state.status, /^Relinked 4 references in 4 documents/);
  assert.equal(app.state.notes.length, 0, "no skips, nothing remaining");

  // report refreshed: now the .png is the unused twin
  const png = app.state.unused.find((f) => f.display === "1 - NYC/Estate Map.png");
  assert.equal(png?.twin, "1%20-%20NYC/Estate%20Map.webp");
  assert.match(app.html, /Last change: 1 - NYC\/Estate Map.png → 1 - NYC\/Estate Map.webp/);
});

test("undo puts every field back exactly", async () => {
  const app = new StewardApp();
  await act.undo.call(app);
  assert.equal(levelSrc("l1"), "1%20-%20NYC/Estate%20Map.png");
  assert.equal(pageHtml(), '<p><img src="1%20-%20NYC/Estate%20Map.png"> and <a href="1%20-%20NYC/Estate%20Map.png">link</a></p>');
  assert.deepEqual(actor._src.flags.gallery.images[1], { src: "1 - NYC/Estate Map.png" });
  assert.deepEqual(JSON.parse(setting._src.value), { bg: "1 - NYC/Estate Map.png", n: 3 });
  assert.match(app.state.status, /Undo restored 4 field/);
  assert.equal(game.modules.get("file-steward").api.history()[0].undone, true);
  await app.render();
  assert.doesNotMatch(app.html, /Last change:/);
});

test("undo leaves a field alone if it was edited after the relink", async () => {
  const app = new StewardApp();
  await act.relinkTwin.call(app, null, { dataset: { from: "1%20-%20NYC/Estate%20Map.png", to: "1%20-%20NYC/Estate%20Map.webp" } });
  scene._src.levels[0].background.src = "somewhere/else.webp"; // GM edits it by hand
  await act.undo.call(app);
  assert.equal(levelSrc("l1"), "somewhere/else.webp", "hand edit kept");
  assert.match(pageHtml(), /Estate%20Map\.png/, "others restored");
  assert.match(app.state.notes[0], /1 field\(s\) were edited after the relink/);
  scene._src.levels[0].background.src = "1%20-%20NYC/Estate%20Map.png";
});

test("missing destination: nothing written, reasons listed", async () => {
  const before = snapshot();
  const app = new StewardApp();
  dialogs.length = 0;
  await act.relinkTwin.call(app, null, { dataset: { from: "1%20-%20NYC/Estate%20Map.png", to: "1%20-%20NYC/Nope.webp" } });
  assert.equal(dialogs.length, 0, "no confirm when there is nothing to do");
  assert.equal(snapshot(), before);
  assert.match(app.state.status, /Nothing was changed: 4 reference/);
  assert.match(app.state.notes[0], /destination file not found/);
});

test("Switch all to WebP only moves toward .webp", async () => {
  const app = new StewardApp();
  app.setTarget("1 - NYC", { isFolder: true });
  await act.unused.call(app);
  await act.relinkAllTwins.call(app);
  assert.equal(levelSrc("l1"), "1%20-%20NYC/Estate%20Map.webp");
  assert.equal(levelSrc("l2"), "1%20-%20NYC/Atrium.webp", "never downgrades webp to png");
  const op = game.modules.get("file-steward").api.history()[0];
  assert.equal(op.pairs.length, 1);
});
