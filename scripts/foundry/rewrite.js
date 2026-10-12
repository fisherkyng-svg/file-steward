/**
 * File Steward — apply reference rewrites to world documents, log them, and undo them.
 */
import { buildDocUpdate, getPath } from "../core/rewrite.js";
import { MODULE_ID, resolveUuid, FilePickerClass, listFiles, currentNormalizer } from "./world.js";

const HISTORY_KEY = "history";
const HISTORY_MAX = 10;

/** Source data the way the walker saw it (Setting values JSON-parsed). */
function sourceOf(doc) {
  const src = doc.toObject();
  if (doc.documentName === "Setting" && typeof src.value === "string") {
    try { src.value = JSON.parse(src.value); } catch { /* plain string */ }
  }
  return src;
}

/** Convert an update built against parsed Setting data back into what Setting.update expects. */
function toWireUpdate(doc, update, records) {
  if (doc.documentName !== "Setting") return { update, records };
  // Any change inside a Setting rewrites its whole JSON value.
  const parsedBefore = sourceOf(doc).value;
  let parsedAfter = JSON.parse(JSON.stringify(parsedBefore));
  for (const [key, val] of Object.entries(update)) {
    if (key === "value") parsedAfter = val;
    else {
      const rel = key.replace(/^value\./, "").split(".");
      let o = parsedAfter;
      for (let i = 0; i < rel.length - 1; i++) o = o[rel[i]];
      o[rel.at(-1)] = val;
    }
  }
  const before = doc.toObject().value;
  const after = JSON.stringify(parsedAfter);
  return { update: { value: after }, records: [{ key: "value", before, after }] };
}

/**
 * Apply planned changes. One update per document; every changed key is recorded for undo.
 * @param {object[]} changes  [{ref, newRaw}]
 * @returns {Promise<{records: object[], errors: {label: string, reason: string}[], applied: number}>}
 */
export async function applyChanges(changes) {
  const byUuid = new Map();
  const errors = [];
  for (const c of changes) {
    const uuid = c.ref.uuid;
    if (!uuid) {
      errors.push({ label: c.ref.rootLabel, reason: game.i18n.localize("FILESTEWARD.Skip.NoDocument") });
      continue;
    }
    if (!byUuid.has(uuid)) byUuid.set(uuid, []);
    byUuid.get(uuid).push(c);
  }

  const records = [];
  let applied = 0;
  for (const [uuid, group] of byUuid) {
    const label = [group[0].ref.rootLabel, ...(group[0].ref.chain ?? [])].join(" › ");
    let doc;
    try {
      doc = await resolveUuid(uuid);
    } catch { /* handled below */ }
    if (!doc?.update) {
      errors.push({ label, reason: game.i18n.localize("FILESTEWARD.Skip.NotFound") });
      continue;
    }
    const built = buildDocUpdate(sourceOf(doc), group);
    if (!Object.keys(built.update).length) {
      errors.push({ label, reason: game.i18n.localize("FILESTEWARD.Skip.Unchanged") });
      continue;
    }
    const wire = toWireUpdate(doc, built.update, built.records);
    try {
      await doc.update(wire.update, { fileSteward: true, diff: true });
      for (const r of wire.records) records.push({ uuid, label, ...r });
      applied += group.length - built.unchanged.length;
    } catch (err) {
      console.error(`${MODULE_ID} | update failed for ${uuid}`, err);
      errors.push({ label, reason: err.message ?? String(err) });
    }
  }
  return { records, errors, applied };
}

/**
 * Put every recorded key back to its "before" value — unless someone changed it since,
 * in which case that key is left alone and reported.
 */
export async function undoRecords(records) {
  let restored = 0;
  const conflicts = [];
  for (const r of records) {
    let doc;
    try { doc = await resolveUuid(r.uuid); } catch { /* below */ }
    if (!doc?.update) {
      conflicts.push({ label: r.label, reason: game.i18n.localize("FILESTEWARD.Skip.NotFound") });
      continue;
    }
    const current = getPath(doc.toObject(), r.key);
    if (JSON.stringify(current) !== JSON.stringify(r.after)) {
      conflicts.push({ label: r.label, reason: game.i18n.localize("FILESTEWARD.Skip.ChangedSince") });
      continue;
    }
    await doc.update({ [r.key]: r.before }, { fileSteward: true, diff: true });
    restored++;
  }
  return { restored, conflicts };
}

/* ---------- destination checks ---------- */

/** Normalized keys of every file under the given folders (non-recursive for files' parent dirs). */
export async function existingFiles(source, { files = [], folders = [] }) {
  const normalize = currentNormalizer();
  const FP = FilePickerClass();
  const keys = new Set();
  const dirs = new Set(files.map((f) => f.replace(/\/[^/]*$/, "")));
  for (const dir of dirs) {
    try {
      const res = await FP.browse(source, dir);
      for (const f of res.files ?? []) {
        const k = normalize(f, { requireExtension: false });
        if (k) keys.add(k);
      }
    } catch { /* dir doesn't exist: its files are missing */ }
  }
  for (const folder of folders) {
    const { files: all } = await listFiles(source, folder.replace(/\/+$/, ""));
    for (const f of all) {
      const k = normalize(f, { requireExtension: false });
      if (k) keys.add(k);
    }
  }
  return keys;
}

/* ---------- operation history ---------- */

export function getHistory() {
  return game.settings.get(MODULE_ID, HISTORY_KEY)?.ops ?? [];
}

export async function pushOperation(op) {
  const ops = [op, ...getHistory()].slice(0, HISTORY_MAX);
  await game.settings.set(MODULE_ID, HISTORY_KEY, { ops });
}

export async function markUndone(id) {
  const ops = getHistory().map((o) => (o.id === id ? { ...o, undone: true, undoneAt: Date.now() } : o));
  await game.settings.set(MODULE_ID, HISTORY_KEY, { ops });
}

export function registerHistorySetting() {
  game.settings.register(MODULE_ID, HISTORY_KEY, {
    scope: "world",
    config: false,
    type: Object,
    default: { ops: [] },
  });
}
