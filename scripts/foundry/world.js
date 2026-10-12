/**
 * File Steward — Foundry adapter. Everything that touches Foundry globals lives here,
 * so a v15 API change touches one file.
 */
import { makeNormalizer } from "../core/paths.js";
import { walkDocument, ReferenceIndex } from "../core/index.js";

export const MODULE_ID = "file-steward";

/* ---------- version-tolerant accessors (v13 / v14) ---------- */

export const FilePickerClass = () =>
  foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;

export const resolveUuid = (uuid) => (foundry.utils.fromUuid ?? globalThis.fromUuid)(uuid);

export const saveFile = (data, type, filename) =>
  (foundry.utils.saveDataToFile ?? globalThis.saveDataToFile)(data, type, filename);

const documentClass = (name) =>
  (foundry.utils.getDocumentClass ?? globalThis.getDocumentClass)?.(name) ?? CONFIG[name]?.documentClass;

/** Foundry's routePrefix, e.g. "" or "foundry". */
function routePrefix() {
  try {
    return (foundry.utils.getRoute?.("/") ?? "/").replace(/^\/+|\/+$/g, "");
  } catch {
    return "";
  }
}

/** Build the normalizer for this server and the current case-sensitivity setting. */
export function currentNormalizer() {
  return makeNormalizer({
    origin: window.location.origin,
    routePrefix: routePrefix(),
    caseSensitive: game.settings.get(MODULE_ID, "caseSensitive"),
  });
}

/* ---------- embedded-collection lookup ---------- */

const embeddedCache = new Map();
/** field key → embedded document name for a document type, e.g. Scene → {tokens: "Token", tiles: "Tile", …} */
function embeddedFor(docName) {
  if (embeddedCache.has(docName)) return embeddedCache.get(docName);
  const meta = documentClass(docName)?.metadata?.embedded ?? {};
  const inverted = Object.fromEntries(Object.entries(meta).map(([name, field]) => [field, name]));
  embeddedCache.set(docName, inverted);
  return inverted;
}

function typeLabel(docName) {
  const key = documentClass(docName)?.metadata?.label;
  return key ? game.i18n.localize(key) : docName;
}

function docTitle(doc, docName) {
  if (docName === "Setting") return doc.key;
  if (docName === "ChatMessage") return `#${doc.id}`;
  return doc.name || doc.id;
}

/* ---------- world index ---------- */

/** All world documents to scan, as [docName, document] pairs. */
function* worldDocuments() {
  let sawSettings = false;
  for (const coll of game.collections) {
    const docName = coll.documentName;
    if (docName === "Setting") sawSettings = true;
    for (const doc of coll) yield [docName, doc];
  }
  if (!sawSettings) {
    const settings = game.settings.storage?.get?.("world");
    if (settings) for (const doc of settings) yield ["Setting", doc];
  }
}

/**
 * Walk every world document once and index every file reference.
 * @param {(p: {done: number, total: number}) => void} [onProgress]
 */
export async function buildWorldIndex(onProgress) {
  const normalize = currentNormalizer();
  const index = new ReferenceIndex();
  const all = [...worldDocuments()];
  const emit = (r) => index.add(r);

  // The world's own background image lives in world.json, not a document.
  if (game.world?.background) {
    walkDocument({ background: game.world.background }, {
      docName: "World", uuid: null, label: `World: ${game.world.title}`, embeddedFor: () => ({}),
    }, normalize, emit);
  }

  for (let i = 0; i < all.length; i++) {
    const [docName, doc] = all[i];
    let source;
    try {
      source = doc.toObject();
    } catch {
      continue;
    }
    if (docName === "Setting" && typeof source.value === "string") {
      try { source.value = JSON.parse(source.value); } catch { /* plain string */ }
    }
    walkDocument(source, {
      docName,
      uuid: doc.uuid ?? null,
      label: `${typeLabel(docName)}: ${docTitle(doc, docName)}`,
      embeddedFor,
    }, normalize, emit);
    index.documents++;

    if (i % 250 === 249) {
      onProgress?.({ done: i + 1, total: all.length });
      await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive in big worlds
    }
  }
  onProgress?.({ done: all.length, total: all.length });
  return { index, normalize };
}

/* ---------- file listing ---------- */

/**
 * Recursively list files under a folder via Foundry's own browse API.
 * @returns {Promise<{files: string[], truncated: boolean}>}
 */
export async function listFiles(source, folder, { maxFiles = 20000, onProgress } = {}) {
  const FP = FilePickerClass();
  const files = [];
  const queue = [folder];
  const seen = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    let res;
    try {
      res = await FP.browse(source, dir);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not browse ${dir}`, err);
      continue;
    }
    files.push(...(res.files ?? []));
    queue.push(...(res.dirs ?? []));
    onProgress?.({ files: files.length, folders: seen.size });
    if (files.length >= maxFiles) return { files: files.slice(0, maxFiles), truncated: true };
  }
  return { files, truncated: false };
}

/** Count compendium packs that belong to the world (scanned in a later phase). */
export function worldPackCount() {
  return game.packs?.filter((p) => p.metadata?.packageType === "world").length ?? 0;
}
