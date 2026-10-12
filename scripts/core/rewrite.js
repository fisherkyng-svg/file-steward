/**
 * File Steward — pure rewrite logic. No Foundry globals.
 *
 * A "change" says: in document `ref.uuid`, field `ref.field`, replace the stored string `ref.raw`
 * with `newRaw`. Changes are grouped into one update per document and top-level key, and each
 * update records the before/after value of that key so it can be undone.
 */

const encodeSegments = (p) => p.split("/").map((s) => encodeURIComponent(s)).join("/");
const escapeHtml = (s) => s.replace(/&/g, "&amp;");

/** Encoders a stored path may have gone through: none, encodeURI, per-segment encodeURIComponent. */
const ENCODERS = [(p) => p, encodeURI, encodeSegments];

/**
 * Rewrite the path inside one stored value, keeping its spelling (encoded or not) and anything
 * around it (leading "/", origin, query string).
 * @param {string} raw        the stored candidate, e.g. "/maps/Old%20Manor/a.png?v=2"
 * @param {string} oldPath    decoded old path; a folder ends in "/"
 * @param {string} newPath    decoded new path; a folder ends in "/"
 * @returns {string|null}     null when the old path isn't found cleanly (caller skips, never guesses)
 */
export function transformRaw(raw, oldPath, newPath, { caseSensitive = true } = {}) {
  const isFolder = oldPath.endsWith("/");
  const hay = caseSensitive ? raw : raw.toLowerCase();
  const tried = new Set();
  for (const enc of ENCODERS) {
    const o = enc(oldPath);
    if (tried.has(o)) continue;
    tried.add(o);
    const needle = caseSensitive ? o : o.toLowerCase();
    for (let idx = hay.indexOf(needle); idx !== -1; idx = hay.indexOf(needle, idx + 1)) {
      const startOk = idx === 0 || raw[idx - 1] === "/";
      const next = raw[idx + o.length];
      const endOk = isFolder || next === undefined || next === "?" || next === "#";
      if (startOk && endOk) return raw.slice(0, idx) + enc(newPath) + raw.slice(idx + o.length);
    }
  }
  return null;
}

/**
 * Plan a relink for a set of references.
 * @param {object[]} refs        from the reference index
 * @param {object} o
 * @param {string} o.oldPath     decoded, folder ends in "/"
 * @param {string} o.newPath     decoded, folder ends in "/"
 * @param {(raw:string)=>string|null} o.normalize
 * @param {Set<string>} o.existing   normalized keys of files that exist at the destination
 * @returns {{changes: object[], missing: object[], failed: object[]}}
 */
export function planRelink(refs, { oldPath, newPath, normalize, existing, caseSensitive = true }) {
  const changes = [];
  const missing = [];
  const failed = [];
  for (const ref of refs) {
    const newRaw = transformRaw(ref.raw, oldPath, newPath, { caseSensitive });
    if (newRaw === null) {
      failed.push(ref);
      continue;
    }
    const key = normalize(newRaw, { requireExtension: false });
    if (!key || !existing.has(key)) {
      missing.push({ ...ref, newRaw, newKey: key });
      continue;
    }
    changes.push({ ref, newRaw });
  }
  return { changes, missing, failed };
}

/* ---------- object paths ---------- */

export function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] == null || typeof o[parts[i]] !== "object") o[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    o = o[parts[i]];
  }
  o[parts.at(-1)] = value;
}

/**
 * The key an update must set for a field. Foundry's update() can't address an array element by
 * index, so a field inside an array is updated by replacing the whole array (its top key).
 */
export function updateKey(field) {
  const parts = field.split(".");
  const i = parts.findIndex((p) => /^\d+$/.test(p));
  return i === -1 ? field : parts.slice(0, i).join(".");
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Replace every occurrence of `raw` (and its HTML-escaped form) in a string. */
export function replaceIn(str, raw, newRaw) {
  let out = str.split(raw).join(newRaw);
  const er = escapeHtml(raw);
  if (er !== raw) out = out.split(er).join(escapeHtml(newRaw));
  return out;
}

/**
 * Turn changes for ONE document into update data plus undo records.
 * @param {object} source        the document's toObject() data (Setting: value already JSON-parsed)
 * @param {object[]} changes     changes whose ref.uuid is this document
 * @returns {{update: object, records: {key: string, before: any, after: any}[], unchanged: object[]}}
 */
export function buildDocUpdate(source, changes) {
  const pending = new Map(); // key → working copy
  const originals = new Map();
  const unchanged = [];
  for (const c of changes) {
    const key = updateKey(c.ref.field);
    if (!pending.has(key)) {
      originals.set(key, clone(getPath(source, key)));
      pending.set(key, clone(getPath(source, key)));
    }
    const rel = c.ref.field === key ? null : c.ref.field.slice(key.length + 1);
    const holder = { v: pending.get(key) };
    const path = rel ? `v.${rel}` : "v";
    const cur = getPath(holder, path);
    if (typeof cur !== "string") {
      unchanged.push(c);
      continue;
    }
    const next = replaceIn(cur, c.ref.raw, c.newRaw);
    if (next === cur) {
      unchanged.push(c);
      continue;
    }
    setPath(holder, path, next);
    pending.set(key, holder.v);
  }
  const update = {};
  const records = [];
  for (const [key, after] of pending) {
    const before = originals.get(key);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    update[key] = after;
    records.push({ key, before, after });
  }
  return { update, records, unchanged };
}

/* ---------- twins ---------- */

const stripExt = (p) => p.replace(/\.[a-z0-9]{2,5}$/i, "");

/**
 * Find unused files that have a used "twin": same folder and name, different extension.
 * @param {string[]} files     every file in the folder (as listed)
 * @param {(f:string)=>boolean} isUsed
 * @returns {Map<string, string>} unused file → its used twin
 */
export function findTwins(files, isUsed) {
  const byBase = new Map();
  for (const f of files) {
    let d = f;
    try { d = decodeURIComponent(f); } catch { /* keep */ }
    const base = stripExt(d).toLowerCase();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(f);
  }
  const twins = new Map();
  for (const group of byBase.values()) {
    if (group.length < 2) continue;
    const used = group.filter(isUsed);
    if (!used.length) continue;
    for (const f of group) if (!isUsed(f)) twins.set(f, used[0]);
  }
  return twins;
}
