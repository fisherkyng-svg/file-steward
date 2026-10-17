/**
 * File Steward — planning uploads into a folder. No Foundry globals, so it is tested in Node.
 */

const decodeSafe = (p) => {
  try { return decodeURIComponent(p ?? ""); } catch { return p ?? ""; }
};

export const extOf = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();

/**
 * Decide what to do with each picked or dropped file.
 * @param {{name: string, size?: number}[]} files   File objects (or anything with a name)
 * @param {string[]} existing                         paths already in the folder, as Foundry's browse returns them
 * @param {object}   opts
 * @param {Set<string>|null} opts.allowed             uploadable extensions (lower case), or null to allow all
 * @param {boolean}  opts.caseSensitive               whether Map.mp3 and map.mp3 are different files on this server
 * @returns {{upload: object[], conflicts: object[], skipped: {name: string, reason: string}[]}}
 *   upload    — new names, safe to send
 *   conflicts — names that already exist in the folder (uploading would replace them)
 *   skipped   — not uploadable: "type" (extension not allowed), "duplicate" (same name twice in this batch)
 */
export function planUploads(files, existing, { allowed = null, caseSensitive = true } = {}) {
  const key = (n) => (caseSensitive ? n : n.toLowerCase());
  const present = new Set(existing.map((p) => key(decodeSafe(p).split("/").pop())));
  const seen = new Set();
  const upload = [];
  const conflicts = [];
  const skipped = [];
  for (const f of files) {
    const name = f.name;
    if (!name || (allowed && !allowed.has(extOf(name)))) {
      skipped.push({ name: name ?? "", reason: "type" });
      continue;
    }
    if (seen.has(key(name))) {
      skipped.push({ name, reason: "duplicate" });
      continue;
    }
    seen.add(key(name));
    (present.has(key(name)) ? conflicts : upload).push(f);
  }
  return { upload, conflicts, skipped };
}

/** Join a folder and a file name into the Data-relative path Foundry stores. */
export function joinPath(folder, name) {
  const dir = decodeSafe(folder).replace(/^\/+|\/+$/g, "");
  return dir ? `${dir}/${name}` : name;
}
