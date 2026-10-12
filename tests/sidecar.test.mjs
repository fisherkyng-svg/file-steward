// Real HTTP tests against the sidecar in a temporary Foundry-like folder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, ensureToken, createServer, cleanRel } from "../sidecar/server.mjs";

let root, cfg, token, server, base;

const req = async (method, route, body, { auth = true, tok = token } = {}) => {
  const res = await fetch(base + route, {
    method,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const exists = (p) => fs.access(p).then(() => true, () => false);
const D = (...p) => path.join(root, "Data", ...p);

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-sidecar-"));
  await fs.mkdir(D("1 - NYC"), { recursive: true });
  await fs.writeFile(D("1 - NYC", "Estate Map.png"), "png-bytes");
  await fs.writeFile(D("1 - NYC", "Estate Map.webp"), "webp");
  await fs.writeFile(D("1 - NYC", "meta.json"), "a file literally named meta.json");
  await fs.mkdir(D("modules", "x"), { recursive: true });
  await fs.writeFile(D("modules", "x", "module.json"), "{}");
  await fs.mkdir(D("worlds", "w", "data"), { recursive: true });
  await fs.mkdir(D("worlds", "w", "assets"), { recursive: true });
  await fs.writeFile(D("worlds", "w", "assets", "a.webp"), "a");
  await fs.writeFile(path.join(root, "secret.txt"), "outside Data");
  await fs.symlink(path.join(root, "secret.txt"), D("1 - NYC", "escape.txt"));
  await fs.symlink(D("modules"), D("sneaky"));
  await fs.mkdir(path.join(root, "etc"));
  const configPath = path.join(root, "etc", "file-steward.json");
  await fs.writeFile(configPath, JSON.stringify({ userDataPath: root, port: 0 }));
  cfg = await loadConfig(configPath);
  ({ token } = await ensureToken(cfg));
  server = await createServer(cfg, token, { log: {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/file-steward/api`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fs.rm(root, { recursive: true, force: true });
});

test("token is created once, 0600, and reused", async () => {
  const st = await fs.stat(cfg.tokenPath);
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal((await ensureToken(cfg)).token, token);
  assert.equal(cfg.trashPath, await fs.realpath(path.join(root, "FileStewardTrash")));
});

test("ping tells the module whether the token works, without leaking anything", async () => {
  const anon = await req("GET", "/ping", null, { auth: false });
  assert.deepEqual(anon.body, { service: "file-steward", api: 1, auth: false });
  const ok = await req("GET", "/ping");
  assert.equal(ok.body.auth, true);
  assert.equal(ok.body.caseSensitive, true);
});

test("no token, wrong token → 401 and nothing happens", async () => {
  const r1 = await req("POST", "/trash", { paths: ["1 - NYC/Estate Map.png"] }, { auth: false });
  const r2 = await req("POST", "/trash", { paths: ["1 - NYC/Estate Map.png"] }, { tok: "nope" });
  assert.equal(r1.status, 401);
  assert.equal(r2.status, 401);
  assert.ok(await exists(D("1 - NYC", "Estate Map.png")));
});

test("path jail: traversal, symlinks out, modules/, world databases", async () => {
  assert.throws(() => cleanRel("../secret.txt"), /escapes/);
  const cases = [
    ["../secret.txt", 400],
    ["1 - NYC/../../secret.txt", 400],
    ["1 - NYC/escape.txt", 403], // symlink pointing outside Data
    ["sneaky/x/module.json", 403], // symlink into modules/
    ["modules/x/module.json", 403],
    ["worlds/w", 403],
    ["worlds/w/data", 403],
  ];
  for (const [p, status] of cases) {
    const r = await req("POST", "/trash", { paths: [p] });
    assert.equal(r.body.items.length, 0, p);
    assert.equal(r.body.errors[0].status, status, p);
  }
  const mv = await req("POST", "/move", { from: "1 - NYC/Estate Map.webp", to: "modules/x/stolen.webp" });
  assert.equal(mv.status, 403);
  assert.ok(await exists(path.join(root, "secret.txt")));
  assert.ok(await exists(D("1 - NYC", "Estate Map.webp")));
});

test("move refuses to overwrite and refuses moving a folder into itself", async () => {
  const r = await req("POST", "/move", { from: "1 - NYC/Estate Map.png", to: "1 - NYC/Estate Map.webp" });
  assert.equal(r.status, 409);
  const r2 = await req("POST", "/move", { from: "1 - NYC", to: "1 - NYC/inner" });
  assert.equal(r2.status, 400);
});

test("copy then move (rename) a folder, creating parents", async () => {
  const c = await req("POST", "/copy", { from: "worlds/w/assets", to: "maps/copied" });
  assert.equal(c.status, 200);
  assert.ok(await exists(D("maps", "copied", "a.webp")));
  const m = await req("POST", "/move", { from: "maps/copied", to: "maps/renamed" });
  assert.equal(m.status, 200);
  assert.ok(await exists(D("maps", "renamed", "a.webp")));
  assert.ok(!(await exists(D("maps", "copied"))));
});

test("trash → list → restore round trip, including a file named meta.json", async () => {
  const t = await req("POST", "/trash", { paths: ["1 - NYC/Estate Map.png", "1 - NYC/meta.json"] });
  assert.equal(t.body.items.length, 2);
  assert.ok(!(await exists(D("1 - NYC", "Estate Map.png"))));
  const list = await req("GET", "/trash");
  assert.equal(list.body.items.length, 2);
  assert.equal(list.body.retentionDays, null);
  const ids = t.body.items.map((i) => i.id);
  const r = await req("POST", "/restore", { ids });
  assert.equal(r.body.restored.length, 2);
  assert.equal(await fs.readFile(D("1 - NYC", "Estate Map.png"), "utf8"), "png-bytes");
  assert.equal(await fs.readFile(D("1 - NYC", "meta.json"), "utf8"), "a file literally named meta.json");
  assert.equal((await req("GET", "/trash")).body.items.length, 0);
});

test("restore refuses when something now occupies the path", async () => {
  const t = await req("POST", "/trash", { paths: ["1 - NYC/Estate Map.webp"] });
  await fs.writeFile(D("1 - NYC", "Estate Map.webp"), "new one");
  const r = await req("POST", "/restore", { ids: [t.body.items[0].id] });
  assert.equal(r.body.errors[0].status, 409);
  assert.equal(await fs.readFile(D("1 - NYC", "Estate Map.webp"), "utf8"), "new one");
  await req("POST", "/purge", { ids: [t.body.items[0].id] });
});

test("purge validates ids and empties trash", async () => {
  const bad = await req("POST", "/purge", { ids: ["../../Data"] });
  assert.equal(bad.status, 400);
  await req("POST", "/trash", { paths: ["maps/renamed"] });
  const p = await req("POST", "/purge", { all: true });
  assert.equal(p.body.purged, 1);
  assert.ok(await exists(D("1 - NYC")), "Data untouched");
});

test("audit log records operations", async () => {
  const log = await fs.readFile(path.join(cfg.trashPath, "audit.jsonl"), "utf8");
  assert.match(log, /"op":"\/trash"/);
  assert.match(log, /"error":"unauthorized"/);
});

test("prefix-stripping proxies work too", async () => {
  const res = await fetch(base.replace("/file-steward/api", "") + "/ping");
  assert.equal((await res.json()).service, "file-steward");
});

test("rate limit after repeated bad tokens", async () => {
  for (let i = 0; i < 10; i++) await req("GET", "/trash", null, { tok: "wrong" });
  const r = await req("GET", "/trash");
  assert.equal(r.status, 429, "even the right token waits once an IP is locked out");
});
