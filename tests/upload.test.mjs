// Upload: core planning, plus the window flow against a mock of Foundry's uploader.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { planUploads, joinPath } from "../scripts/core/upload.js";

const f = (name, size = 1000) => ({ name, size });

test("planUploads sorts new, existing, wrong type and duplicates", () => {
  const plan = planUploads(
    [f("Theme.mp3"), f("Rain Loop.ogg"), f("notes.exe"), f("Theme.mp3"), f("Combat.MP3")],
    ["music/Rain%20Loop.ogg", "music/old.mp3"],
    { allowed: new Set(["mp3", "ogg"]) }
  );
  assert.deepEqual(plan.upload.map((x) => x.name), ["Theme.mp3", "Combat.MP3"]);
  assert.deepEqual(plan.conflicts.map((x) => x.name), ["Rain Loop.ogg"]);
  assert.deepEqual(plan.skipped, [{ name: "notes.exe", reason: "type" }, { name: "Theme.mp3", reason: "duplicate" }]);
});

test("planUploads respects case sensitivity and an unknown allow-list", () => {
  const existing = ["music/theme.mp3"];
  assert.equal(planUploads([f("Theme.mp3")], existing, { caseSensitive: true }).conflicts.length, 0);
  assert.equal(planUploads([f("Theme.mp3")], existing, { caseSensitive: false }).conflicts.length, 1);
  assert.equal(planUploads([f("anything.xyz")], [], { allowed: null }).upload.length, 1);
});

test("joinPath decodes and trims the folder", () => {
  assert.equal(joinPath("/assets/My%20Music/", "a.mp3"), "assets/My Music/a.mp3");
  assert.equal(joinPath("", "a.mp3"), "a.mp3");
});

/* ---------- window flow ---------- */
const lang = JSON.parse(fs.readFileSync(new URL("../lang/en.json", import.meta.url)));
const lookup = (k) => k.split(".").reduce((o, p) => o?.[p], lang) ?? k;

const disk = { "assets/My Music": ["assets/My%20Music/Rain%20Loop.ogg"] };
const uploads = [];
class FakeFilePicker {
  static async browse(source, target) { return { dirs: [], files: disk[target] ?? [] }; }
  static async upload(source, folder, file, body, opts) {
    uploads.push({ source, folder, name: file.name, notify: opts?.notify });
    if (file.name === "Broken.mp3") return { status: "error", message: "Disk full" };
    const path = `${folder.replace(/ /g, "%20")}/${encodeURIComponent(file.name)}`;
    (disk[folder] ??= []).push(path);
    return { status: "success", path, message: "uploaded" };
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
let waitAnswer = "skip";
const dialogs = [];
class FakeDialogV2 {
  static async wait(opts) { dialogs.push(opts); return waitAnswer; }
  static async confirm() { return true; }
}
const store = new Map([["file-steward.caseSensitive", true], ["file-steward.history", { ops: [] }]]);
globalThis.window = { location: { origin: "https://vtm.example.net" } };
globalThis.CONFIG = {};
globalThis.CONST = { UPLOADABLE_FILE_EXTENSIONS: { mp3: "audio/mpeg", ogg: "audio/ogg", webp: "image/webp" } };
globalThis.Hooks = { once: () => {}, on: () => {} };
const notes = [];
globalThis.ui = { notifications: { warn: (m) => notes.push(["warn", m]), info: (m) => notes.push(["info", m]), error: (m) => { throw new Error(m); } } };
globalThis.foundry = {
  applications: { api: { ApplicationV2: FakeAppV2, DialogV2: FakeDialogV2 }, apps: { FilePicker: { implementation: FakeFilePicker } } },
  utils: { getRoute: (p) => p },
};
globalThis.game = {
  user: { isGM: true },
  i18n: { localize: lookup, format: (k, d) => lookup(k).replace(/\{(\w+)\}/g, (_, x) => d[x]) },
  settings: { get: (m, k) => structuredClone(store.get(`${m}.${k}`)), register: () => {} },
};

const { StewardApp } = await import("../scripts/app.js");
const act = StewardApp.DEFAULT_OPTIONS.actions;

test("upload needs a folder first", async () => {
  const app = new StewardApp();
  app.setTarget("assets/My Music/Rain Loop.ogg");
  await app.render();
  act.upload.call(app);
  assert.equal(notes.at(-1)[1], lookup("FILESTEWARD.NeedUploadFolder"));
});

test("button shows, new files upload into the decoded folder, existing ones are skipped", async () => {
  const app = new StewardApp();
  app.setTarget("assets/My%20Music/", { isFolder: true });
  await app.render();
  assert.match(app.html, /data-action="upload"/);
  assert.match(app.html, /class="fs-upload-input" multiple/);

  waitAnswer = "skip";
  const files = [f("Theme.mp3"), f("Rain Loop.ogg"), f("readme.exe"), f("Broken.mp3")];
  await app.uploadFiles(files);

  assert.deepEqual(uploads.map((u) => [u.folder, u.name, u.notify]), [
    ["assets/My Music", "Theme.mp3", false],
    ["assets/My Music", "Broken.mp3", false],
  ]);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].content, /Rain Loop\.ogg/);
  assert.equal(app.state.mode, "uploads");
  const byName = Object.fromEntries(app.state.uploads.map((u) => [u.display.split("/").pop(), u.result]));
  assert.deepEqual(byName, { "Theme.mp3": "added", "Broken.mp3": "failed", "Rain Loop.ogg": "skipped", "readme.exe": "skipped" });
  assert.equal(app.state.uploads[0].result, "failed"); // failures listed first
  assert.match(app.state.status, /Uploaded 1 file\(s\) to assets\/My Music\. Failed: 1\. Skipped: 2\./);
  assert.match(app.html, /Disk full/);
  assert.equal(notes.at(-1)[0], "warn");
});

test("replace re-uploads existing files; cancel uploads nothing", async () => {
  const app = new StewardApp();
  app.setTarget("assets/My Music", { isFolder: true });
  await app.render();
  uploads.length = 0;

  waitAnswer = "cancel";
  await app.uploadFiles([f("Rain Loop.ogg"), f("New.mp3")]);
  assert.equal(uploads.length, 0);
  assert.equal(app.state.status, lookup("FILESTEWARD.Cancelled"));

  waitAnswer = "replace";
  await app.uploadFiles([f("Rain Loop.ogg"), f("New.mp3")]);
  assert.deepEqual(uploads.map((u) => u.name), ["New.mp3", "Rain Loop.ogg"]);
  const results = Object.fromEntries(app.state.uploads.map((u) => [u.display.split("/").pop(), u.result]));
  assert.deepEqual(results, { "New.mp3": "added", "Rain Loop.ogg": "replaced" });
  assert.equal(notes.at(-1)[0], "info");
});
