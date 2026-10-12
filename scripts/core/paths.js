/**
 * File Steward — path normalization and candidate extraction.
 * Pure functions: no Foundry globals, so they can be unit-tested in Node.
 */

const EXT_RE = /\.[a-z0-9]{2,5}$/i;

/** Media extensions used when hunting for quoted paths inside free text (macros, JSON flags). */
const MEDIA_EXT =
  "webp|png|jpe?g|gif|svg|avif|bmp|tiff?|mp3|ogg|oga|wav|flac|m4a|aac|opus|webm|mp4|m4v|ogv|mov|pdf|json|txt|md|ttf|otf|woff2?";
const QUOTED_PATH_RE = new RegExp(`["'\`]([^"'\`\\n\\r<>]+?\\.(?:${MEDIA_EXT}))(?:[?#][^"'\`\\s]*)?["'\`]`, "gi");
const HTML_ATTR_RE = /\b(?:src|href|data-src|poster|srcset)\s*=\s*(["'])(.*?)\1/gi;
const CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

/**
 * Build a normalizer bound to the current server context.
 * @param {object} opts
 * @param {string} [opts.origin]        e.g. "https://vtm.example.net" — absolute URLs on other origins are ignored
 * @param {string} [opts.routePrefix]   Foundry's routePrefix, if any (e.g. "foundry")
 * @param {boolean} [opts.caseSensitive=true]
 * @returns {(raw: string, o?: {requireExtension?: boolean}) => string|null}
 */
export function makeNormalizer({ origin = "", routePrefix = "", caseSensitive = true } = {}) {
  const prefix = String(routePrefix || "").replace(/^\/+|\/+$/g, "");

  return function normalize(raw, { requireExtension = true } = {}) {
    if (typeof raw !== "string") return null;
    let s = raw.trim();
    if (!s || s.length > 2048) return null;
    if (/^(data|blob|javascript|mailto|about):/i.test(s)) return null;

    let absolute = false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      let u;
      try { u = new URL(s); } catch { return null; }
      if (!origin || u.origin !== origin) return null; // external URL: not one of our files
      s = u.pathname;
      absolute = true;
    }

    s = s.split(/[?#]/)[0].replace(/\\/g, "/");
    try { s = decodeURIComponent(s); } catch { /* malformed escape: keep as-is */ }

    if (s.startsWith("/")) absolute = true;
    s = s.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
    if (absolute && prefix && (s === prefix || s.startsWith(prefix + "/"))) s = s.slice(prefix.length + 1);
    if (!s) return null;
    if (requireExtension && !EXT_RE.test(s)) return null;
    return caseSensitive ? s : s.toLowerCase();
  };
}

/** Normalize a folder target so prefix matching is exact: always ends in "/". */
export function normalizeFolder(normalize, raw) {
  const n = normalize(raw, { requireExtension: false });
  if (!n) return null;
  return n.endsWith("/") ? n : n + "/";
}

const decodeEntities = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/**
 * Pull every string that might be a file path out of one field value.
 * kind: "field" = the whole value is a path; "html" = from an HTML attribute or CSS url();
 *       "text" = a quoted media path inside free text (macro code, JSON, notes).
 * @param {string} str
 * @returns {{value: string, kind: "field"|"html"|"text"}[]}
 */
export function extractCandidates(str) {
  if (typeof str !== "string" || !str) return [];
  const out = [];
  const seen = new Set();
  const push = (value, kind) => {
    const v = value.trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push({ value: v, kind });
  };

  const trimmed = str.trim();
  // Whole-value path (the common case: img, texture.src, path, src)
  // Spaces are allowed (file names have them); newlines, tabs and markup are not.
  if (trimmed.length <= 2048 && !/[\n\r\t<>]/.test(trimmed)) {
    push(trimmed.replace(/^["']|["']$/g, ""), "field"); // Setting values arrive JSON-quoted
  }

  if (str.includes("<") || str.includes("url(")) {
    for (const m of str.matchAll(HTML_ATTR_RE)) {
      const val = decodeEntities(m[2]);
      // srcset may hold "a.webp 1x, b.webp 2x"
      for (const part of val.split(",")) push(part.trim().split(/\s+/)[0], "html");
    }
    for (const m of str.matchAll(CSS_URL_RE)) push(decodeEntities(m[2]), "html");
  }

  if (/["'`]/.test(str)) {
    for (const m of str.matchAll(QUOTED_PATH_RE)) push(decodeEntities(m[1]), "text");
  }
  return out;
}
