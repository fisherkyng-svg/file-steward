#!/usr/bin/env node
/**
 * File Steward sidecar — the small server-side helper that does what a Foundry module can't:
 * move, rename, copy, trash and restore files inside Foundry's Data folder.
 *
 * Node standard library only. Listens on 127.0.0.1 by default; reach it through your reverse proxy.
 *
 *   node server.mjs                      run (config from $FILE_STEWARD_CONFIG or /etc/file-steward/file-steward.json)
 *   node server.mjs --init               create the token if missing, print it, exit
 *   node server.mjs --print-token        print the existing token, exit
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const VERSION = "1.0.0";
export const API_VERSION = 1;
const TRASH_ID = /^\d{13}-[a-f0-9]{8}$/;
const MAX_BODY = 64 * 1024;

/* ---------- errors ---------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);
const forbidden = (m) => new HttpError(403, m);

/* ---------- config ---------- */

export async function loadConfig(configPath) {
  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  const cfg = {
    host: "127.0.0.1",
    port: 30013,
    allowedRoots: ["*"],
    retentionDays: null,
    allowOrigin: null,
    tokenPath: path.join(path.dirname(configPath), "token"),
    ...raw,
  };
  if (!cfg.dataPath && cfg.userDataPath) cfg.dataPath = path.join(cfg.userDataPath, "Data");
  if (!cfg.dataPath) throw new Error("config needs dataPath (Foundry's Data folder) or userDataPath");
  cfg.dataPath = await fs.realpath(cfg.dataPath);
  cfg.trashPath ??= path.join(path.dirname(cfg.dataPath), "FileStewardTrash");
  await fs.mkdir(cfg.trashPath, { recursive: true });
  cfg.trashPath = await fs.realpath(cfg.trashPath);
  if (isInside(cfg.trashPath, cfg.dataPath) || cfg.trashPath === cfg.dataPath) {
    throw new Error("trashPath must be outside the Data folder");
  }
  if (!Array.isArray(cfg.allowedRoots) || !cfg.allowedRoots.length) throw new Error("allowedRoots must be a non-empty list");
  cfg.allowedRoots = cfg.allowedRoots.map((r) => (r === "*" ? "*" : cleanRel(r)));
  return cfg;
}

export async function ensureToken(cfg) {
  try {
    const t = (await fs.readFile(cfg.tokenPath, "utf8")).trim();
    if (t.length >= 32) return { token: t, created: false };
  } catch { /* create below */ }
  const token = crypto.randomBytes(32).toString("base64url");
  await fs.mkdir(path.dirname(cfg.tokenPath), { recursive: true });
  await fs.writeFile(cfg.tokenPath, token + "\n", { mode: 0o600 });
  return { token, created: true };
}

/* ---------- path jail ---------- */

const isInside = (child, parent) => child.startsWith(parent + path.sep);

/** A Data-relative path from client input: forward slashes, no leading slash, no "..", no trailing slash. */
export function cleanRel(input) {
  if (typeof input !== "string" || !input || input.length > 1024 || input.includes("\0")) throw bad("invalid path");
  const s = input.replace(/\\/g, "/").replace(/^\/+/, "");
  const norm = path.posix.normalize(s).replace(/\/+$/, "");
  if (!norm || norm === "." || norm === ".." || norm.startsWith("../")) throw bad("path escapes the Data folder");
  return norm;
}

/** Never touch package code or world databases, whatever the config says. */
export function checkPolicy(cfg, rel) {
  const parts = rel.split("/");
  if (parts[0] === "modules" || parts[0] === "systems") throw forbidden("modules/ and systems/ are off limits");
  if (parts[0] === "worlds") {
    if (parts.length <= 2) throw forbidden("a world folder itself can't be changed");
    if (["data", "packs", "world.json"].includes(parts[2])) throw forbidden("world databases are off limits");
  }
  if (!cfg.allowedRoots.includes("*") && !cfg.allowedRoots.some((r) => rel === r || rel.startsWith(r + "/"))) {
    throw forbidden("path is outside the allowed folders");
  }
}

/** Resolve an existing path, following symlinks, and make sure it really lives inside Data. */
async function resolveExisting(cfg, rel) {
  checkPolicy(cfg, rel);
  let real;
  try {
    real = await fs.realpath(path.join(cfg.dataPath, rel));
  } catch (e) {
    if (e.code === "ENOENT") throw new HttpError(404, `not found: ${rel}`);
    throw e;
  }
  if (!isInside(real, cfg.dataPath)) throw forbidden("path resolves outside the Data folder");
  // the resolved target must also pass policy (a symlink into modules/ is still modules/)
  checkPolicy(cfg, path.relative(cfg.dataPath, real).split(path.sep).join("/"));
  return real;
}

/** Resolve a path that must NOT exist yet; create its parent folders safely. */
async function resolveNew(cfg, rel) {
  checkPolicy(cfg, rel);
  const abs = path.join(cfg.dataPath, rel);
  try {
    await fs.lstat(abs);
    throw new HttpError(409, `already exists: ${rel}`);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e.code !== "ENOENT") throw e;
  }
  // walk up to the nearest existing ancestor and check it is really inside Data
  let anc = path.dirname(abs);
  for (;;) {
    try {
      const real = await fs.realpath(anc);
      if (real !== cfg.dataPath && !isInside(real, cfg.dataPath)) throw forbidden("destination resolves outside the Data folder");
      break;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e.code !== "ENOENT") throw e;
      anc = path.dirname(anc);
    }
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  return abs;
}

/** rename, falling back to copy+remove across file systems. */
async function moveAbs(src, dst) {
  try {
    await fs.rename(src, dst);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    await fs.cp(src, dst, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

async function sizeOf(p) {
  const st = await fs.lstat(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of await fs.readdir(p)) total += await sizeOf(path.join(p, e));
  return total;
}

/* ---------- operations ---------- */

export function makeOps(cfg) {
  const trashDir = (id) => {
    if (!TRASH_ID.test(id)) throw bad("invalid trash id");
    return path.join(cfg.trashPath, id);
  };
  const readMeta = async (id) => {
    try {
      return JSON.parse(await fs.readFile(path.join(trashDir(id), "meta.json"), "utf8"));
    } catch {
      throw new HttpError(404, `no such trash item: ${id}`);
    }
  };

  const ops = {
    async move({ from, to }) {
      const f = cleanRel(from), t = cleanRel(to);
      if (f === t) throw bad("source and destination are the same");
      if (t.startsWith(f + "/")) throw bad("can't move a folder inside itself");
      const src = await resolveExisting(cfg, f);
      const dst = await resolveNew(cfg, t);
      await moveAbs(src, dst);
      return { from: f, to: t };
    },

    async copy({ from, to }) {
      const f = cleanRel(from), t = cleanRel(to);
      if (t.startsWith(f + "/")) throw bad("can't copy a folder inside itself");
      const src = await resolveExisting(cfg, f);
      const dst = await resolveNew(cfg, t);
      await fs.cp(src, dst, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      return { from: f, to: t };
    },

    async trash({ paths }) {
      if (!Array.isArray(paths) || !paths.length || paths.length > 1000) throw bad("paths must be a list of 1–1000 paths");
      const items = [];
      const errors = [];
      for (const p of paths) {
        try {
          const rel = cleanRel(p);
          const src = await resolveExisting(cfg, rel);
          const st = await fs.lstat(src);
          const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
          const dir = path.join(cfg.trashPath, id);
          await fs.mkdir(dir);
          const size = await sizeOf(src);
          const meta = { id, path: rel, name: path.basename(src), isDir: st.isDirectory(), size, trashedAt: Date.now() };
          await fs.mkdir(path.join(dir, "item"));
          await moveAbs(src, path.join(dir, "item", meta.name));
          await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
          items.push(meta);
        } catch (e) {
          errors.push({ path: p, error: e.message, status: e.status ?? 500 });
        }
      }
      return { items, errors };
    },

    async listTrash() {
      const items = [];
      for (const id of await fs.readdir(cfg.trashPath)) {
        if (!TRASH_ID.test(id)) continue;
        try {
          items.push(await readMeta(id));
        } catch { /* half-written entry: skip */ }
      }
      items.sort((a, b) => b.trashedAt - a.trashedAt);
      return { items, retentionDays: cfg.retentionDays ?? null };
    },

    async restore({ ids }) {
      if (!Array.isArray(ids) || !ids.length) throw bad("ids must be a non-empty list");
      const restored = [];
      const errors = [];
      for (const id of ids) {
        try {
          const meta = await readMeta(id);
          const dst = await resolveNew(cfg, meta.path);
          await moveAbs(path.join(trashDir(id), "item", meta.name), dst);
          await fs.rm(trashDir(id), { recursive: true, force: true });
          restored.push({ id, path: meta.path });
        } catch (e) {
          errors.push({ id, error: e.message, status: e.status ?? 500 });
        }
      }
      return { restored, errors };
    },

    async purge({ ids, all, olderThanDays }) {
      let targets;
      if (all === true) targets = (await ops.listTrash()).items.map((i) => i.id);
      else if (typeof olderThanDays === "number" && olderThanDays >= 0) {
        const cutoff = Date.now() - olderThanDays * 864e5;
        targets = (await ops.listTrash()).items.filter((i) => i.trashedAt < cutoff).map((i) => i.id);
      } else if (Array.isArray(ids) && ids.length) targets = ids;
      else throw bad("give ids, all: true, or olderThanDays");
      for (const id of targets) await fs.rm(trashDir(id), { recursive: true, force: true });
      return { purged: targets.length };
    },
  };
  return ops;
}

/* ---------- case sensitivity of the Data volume ---------- */

async function detectCaseSensitive(dir) {
  const name = `.fs-case-${crypto.randomBytes(4).toString("hex")}`;
  const probe = path.join(dir, name);
  try {
    await fs.writeFile(probe, "");
    try {
      await fs.access(path.join(dir, name.toUpperCase()));
      return false; // found it under a different case: case-insensitive volume
    } catch {
      return true;
    } finally {
      await fs.rm(probe, { force: true });
    }
  } catch {
    return true;
  }
}

/* ---------- HTTP ---------- */

export async function createServer(cfg, token, { log = console } = {}) {
  const ops = makeOps(cfg);
  const caseSensitive = await detectCaseSensitive(cfg.trashPath);
  const tokenHash = crypto.createHash("sha256").update(token).digest();
  const failures = new Map(); // ip → [timestamps]
  const auditPath = path.join(cfg.trashPath, "audit.jsonl");

  const audit = (entry) =>
    fs.appendFile(auditPath, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n").catch(() => {});

  const authorized = (req) => {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) return false;
    const given = crypto.createHash("sha256").update(m[1]).digest();
    return crypto.timingSafeEqual(given, tokenHash);
  };

  const rateLimited = (ip) => {
    const now = Date.now();
    const list = (failures.get(ip) ?? []).filter((t) => now - t < 10 * 60e3);
    failures.set(ip, list);
    return list.length >= 10;
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, "request too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(bad("body must be JSON"));
        }
      });
      req.on("error", reject);
    });

  const ROUTES = {
    "POST /move": (b) => ops.move(b),
    "POST /copy": (b) => ops.copy(b),
    "POST /trash": (b) => ops.trash(b),
    "GET /trash": () => ops.listTrash(),
    "POST /restore": (b) => ops.restore(b),
    "POST /purge": (b) => ops.purge(b),
  };

  const server = http.createServer(async (req, res) => {
    // The proxy's own entry is the trustworthy one: X-Real-IP, else the LAST X-Forwarded-For hop.
    const ip = req.headers["x-real-ip"] || req.headers["x-forwarded-for"]?.split(",").at(-1).trim() || req.socket.remoteAddress;
    const send = (status, body) => {
      const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
      if (cfg.allowOrigin) {
        headers["Access-Control-Allow-Origin"] = cfg.allowOrigin;
        headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
        headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        headers["Vary"] = "Origin";
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };

    // Accept both "/file-steward/api/x" (proxied as-is) and "/x" (proxy stripped the prefix).
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname.replace(/^.*\/file-steward\/api(?=\/)/, "").replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") return send(204, {});
    if (req.method === "GET" && route === "/ping") {
      const ok = authorized(req);
      return send(200, ok
        ? { service: "file-steward", version: VERSION, api: API_VERSION, auth: true, caseSensitive, allowedRoots: cfg.allowedRoots, retentionDays: cfg.retentionDays ?? null }
        : { service: "file-steward", api: API_VERSION, auth: false });
    }

    const handler = ROUTES[`${req.method} ${route}`];
    if (!handler) return send(404, { error: "unknown endpoint" });
    if (rateLimited(ip)) return send(429, { error: "too many failed attempts; wait 10 minutes" });
    if (!authorized(req)) {
      failures.get(ip)?.push(Date.now()) ?? failures.set(ip, [Date.now()]);
      audit({ ip, op: route, ok: false, error: "unauthorized" });
      return send(401, { error: "missing or wrong token" });
    }

    let body = {};
    try {
      if (req.method === "POST") body = await readBody(req);
      const result = await handler(body);
      if (req.method === "POST") audit({ ip, op: route, args: body, ok: true });
      send(200, result);
    } catch (e) {
      const status = e.status ?? 500;
      if (status >= 500) log.error?.(`file-steward: ${route} failed`, e);
      audit({ ip, op: route, args: body, ok: false, error: e.message });
      send(status, { error: e.message });
    }
  });

  let timer = null;
  if (cfg.retentionDays > 0) {
    const sweep = () => ops.purge({ olderThanDays: cfg.retentionDays }).catch((e) => log.error?.("file-steward: retention sweep failed", e));
    sweep();
    timer = setInterval(sweep, 6 * 3600e3);
    timer.unref?.();
  }
  server.on("close", () => timer && clearInterval(timer));
  return server;
}

/* ---------- CLI ---------- */

async function main() {
  const configPath = process.env.FILE_STEWARD_CONFIG || "/etc/file-steward/file-steward.json";
  const cfg = await loadConfig(configPath);
  const { token, created } = await ensureToken(cfg);
  const args = process.argv.slice(2);
  if (args.includes("--init") || args.includes("--print-token")) {
    if (created) console.log("Created a new token.");
    console.log(token);
    return;
  }
  if (created) console.log(`File Steward: created a new token in ${cfg.tokenPath}. Paste it into File Steward's settings in Foundry:\n${token}`);
  const server = await createServer(cfg, token);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`File Steward sidecar ${VERSION} listening on ${cfg.host}:${cfg.port}`);
    console.log(`  Data:  ${cfg.dataPath}`);
    console.log(`  Trash: ${cfg.trashPath}${cfg.retentionDays ? ` (purged after ${cfg.retentionDays} days)` : " (kept until emptied)"}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.mjs")) {
  main().catch((e) => {
    console.error(`File Steward sidecar failed to start: ${e.message}`);
    process.exit(1);
  });
}
