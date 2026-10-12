/**
 * File Steward — client for the optional server helper (sidecar).
 * URL and token are client-scoped settings: they live in this browser only and are never
 * sent to players the way world settings are.
 */
import { MODULE_ID } from "./world.js";

export const SIDECAR_API = 1;

export class SidecarError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function defaultUrl() {
  let route = "/file-steward/api";
  try {
    route = foundry.utils.getRoute("file-steward/api");
  } catch { /* no prefix */ }
  return `${window.location.origin}${route.startsWith("/") ? "" : "/"}${route}`;
}

function config() {
  const url = (game.settings.get(MODULE_ID, "sidecarUrl") || defaultUrl()).replace(/\/+$/, "");
  const token = (game.settings.get(MODULE_ID, "sidecarToken") || "").trim();
  return { url, token };
}

async function call(method, route, body) {
  const { url, token } = config();
  if (!token) throw new SidecarError("no token set", 0);
  let res;
  try {
    res = await fetch(url + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (err) {
    throw new SidecarError(`can't reach the server helper (${err.message})`, 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new SidecarError(data.error ?? `${res.status} ${res.statusText}`, res.status);
  return data;
}

/**
 * How the helper looks from here.
 * @returns {Promise<{state: "ok"|"no-token"|"unauthorized"|"unreachable"|"incompatible", info?: object, message?: string}>}
 */
export async function probe() {
  const { url, token } = config();
  if (!token) return { state: "no-token" };
  try {
    const res = await fetch(`${url}/ping`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const info = await res.json().catch(() => null);
    if (!info || info.service !== "file-steward") return { state: "unreachable", message: `${url} isn't a File Steward helper` };
    if (info.api !== SIDECAR_API) return { state: "incompatible", info };
    if (!info.auth) return { state: "unauthorized", info };
    return { state: "ok", info };
  } catch (err) {
    return { state: "unreachable", message: err.message };
  }
}

/** Paths go to the helper decoded and Data-relative, the way they sit on disk. */
const rel = (p) => {
  let d = p;
  try { d = decodeURIComponent(p); } catch { /* keep */ }
  return d.replace(/^\/+/, "").replace(/\/+$/, "");
};

export const sidecar = {
  move: (from, to) => call("POST", "/move", { from: rel(from), to: rel(to) }),
  copy: (from, to) => call("POST", "/copy", { from: rel(from), to: rel(to) }),
  trash: (paths) => call("POST", "/trash", { paths: paths.map(rel) }),
  listTrash: () => call("GET", "/trash"),
  restore: (ids) => call("POST", "/restore", { ids }),
  purge: (opts) => call("POST", "/purge", opts),
};

export function registerSidecarSettings() {
  game.settings.register(MODULE_ID, "sidecarToken", {
    name: "FILESTEWARD.Settings.SidecarToken.Name",
    hint: "FILESTEWARD.Settings.SidecarToken.Hint",
    scope: "client",
    config: true,
    restricted: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, "sidecarUrl", {
    name: "FILESTEWARD.Settings.SidecarUrl.Name",
    hint: "FILESTEWARD.Settings.SidecarUrl.Hint",
    scope: "client",
    config: true,
    restricted: true,
    type: String,
    default: "",
  });
}
