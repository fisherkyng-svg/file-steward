/**
 * File Steward — document walker and reference index.
 * Pure: the caller supplies document source data and an embedded-collection lookup.
 */
import { extractCandidates } from "./paths.js";

const SKIP_KEYS = new Set(["_id", "_stats", "ownership", "sort", "folder"]);

/**
 * Walk one document's source data and emit every file reference found.
 * @param {object} source            doc.toObject()
 * @param {object} ctx
 * @param {string} ctx.docName       "Scene", "Actor", …
 * @param {string|null} ctx.uuid     root document uuid
 * @param {string} ctx.label         human label for the root, e.g. "Scene: Old Manor"
 * @param {(docName: string) => Record<string,string>} ctx.embeddedFor  field key → embedded document name, e.g. {tokens: "Token"}
 * @param {(raw: string) => string|null} normalize
 * @param {(ref: object) => void} emit
 */
export function walkDocument(source, ctx, normalize, emit) {
  const root = { rootUuid: ctx.uuid, rootType: ctx.docName, rootLabel: ctx.label };

  const visit = (value, fieldPath, owner) => {
    if (typeof value === "string") {
      for (const c of extractCandidates(value)) {
        const n = normalize(c.value);
        if (!n) continue;
        emit({ ...root, ...owner, field: fieldPath.join("."), raw: c.value, kind: c.kind, normalized: n });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, [...fieldPath, String(i)], owner));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (SKIP_KEYS.has(k)) continue;
        visit(v, [...fieldPath, k], owner);
      }
    }
  };

  const walkDoc = (data, docName, uuid, chain) => {
    const embedded = ctx.embeddedFor(docName) || {};
    const owner = { uuid, docName, chain };
    for (const [k, v] of Object.entries(data ?? {})) {
      if (SKIP_KEYS.has(k)) continue;
      const childName = embedded[k];
      if (childName && Array.isArray(v)) {
        for (const child of v) {
          if (child && typeof child === "object") walkChild(child, childName, uuid, chain);
        }
      } else if (childName && v && typeof v === "object") {
        walkChild(v, childName, uuid, chain); // single embedded doc, e.g. a token's ActorDelta
      } else {
        visit(v, [k], owner);
      }
    }
  };

  const walkChild = (child, childName, parentUuid, chain) => {
    const id = child._id ?? "?";
    const uuid = parentUuid ? `${parentUuid}.${childName}.${id}` : null;
    const name = child.name ?? child.label ?? child.text ?? null;
    const label = name ? `${childName} "${String(name).slice(0, 40)}"` : childName;
    walkDoc(child, childName, uuid, [...chain, label]);
  };

  walkDoc(source, ctx.docName, ctx.uuid, []);
}

/** Map of normalized path → references. */
export class ReferenceIndex {
  constructor() {
    /** @type {Map<string, object[]>} */
    this.map = new Map();
    this.documents = 0;
    this.references = 0;
  }

  add(ref) {
    let list = this.map.get(ref.normalized);
    if (!list) this.map.set(ref.normalized, (list = []));
    list.push(ref);
    this.references++;
  }

  has(normalizedPath) {
    return this.map.has(normalizedPath);
  }

  /** References to one exact file. */
  findFile(normalizedPath) {
    return [...(this.map.get(normalizedPath) ?? [])];
  }

  /** References to anything inside a folder. `prefix` must end with "/". */
  findFolder(prefix) {
    const out = [];
    for (const [k, list] of this.map) if (k.startsWith(prefix)) out.push(...list);
    return out;
  }

  /** Count distinct root documents in a reference list. */
  static countDocuments(refs) {
    return new Set(refs.map((r) => r.rootUuid ?? r.rootLabel)).size;
  }
}
