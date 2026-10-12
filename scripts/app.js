/**
 * File Steward — the GM window. Phase 1 is read-only: find references, find unused files, export CSV.
 */
import { normalizeFolder } from "./core/paths.js";
import { ReferenceIndex } from "./core/index.js";
import {
  MODULE_ID, FilePickerClass, resolveUuid, saveFile, buildWorldIndex, listFiles, worldPackCount,
} from "./foundry/world.js";

const { ApplicationV2 } = foundry.applications.api;
const L = (k) => game.i18n.localize(`FILESTEWARD.${k}`);
const F = (k, data) => game.i18n.format(`FILESTEWARD.${k}`, data);
const MAX_ROWS = 500;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const decodeSafe = (p) => {
  try { return decodeURIComponent(p ?? ""); } catch { return p ?? ""; }
};

const looksLikeFolder = (p) => !p || p.endsWith("/") || !/\.[a-z0-9]{2,5}$/i.test(p);

export class StewardApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "file-steward",
    classes: ["file-steward"],
    tag: "section",
    window: { title: "FILESTEWARD.Title", icon: "fa-solid fa-folder-tree", resizable: true },
    position: { width: 780, height: 640 },
    actions: {
      pickFile: StewardApp.#onPickFile,
      pickFolder: StewardApp.#onPickFolder,
      scan: StewardApp.#onScan,
      unused: StewardApp.#onUnused,
      exportCsv: StewardApp.#onExport,
      openRef: StewardApp.#onOpenRef,
    },
  };

  state = {
    target: "",
    isFolder: false,
    source: "data",
    busy: false,
    status: "",
    mode: null, // "refs" | "unused"
    refs: [],
    unused: [],
    notes: [],
  };

  /** Pre-fill a target, e.g. from the API. */
  setTarget(path, { source = "data", isFolder } = {}) {
    this.state.target = path ?? "";
    this.state.display = decodeSafe(path); // what the GM sees: spaces, not %20
    this.state.source = source;
    this.state.isFolder = isFolder ?? looksLikeFolder(path);
  }

  /* ---------- rendering ---------- */

  async _renderHTML() {
    const s = this.state;
    const dis = s.busy ? "disabled" : "";
    const hasResults = (s.mode === "refs" && s.refs.length) || (s.mode === "unused" && s.unused.length);
    return `
      <div class="fs-bar">
        <label class="fs-label" for="fs-path">${L("Target")}</label>
        <div class="fs-row">
          <input id="fs-path" type="text" name="path" value="${esc(s.display ?? s.target)}" placeholder="${esc(L("TargetPlaceholder"))}" ${dis}>
          <button type="button" data-action="pickFile" ${dis}><i class="fa-solid fa-file-image"></i> ${L("PickFile")}</button>
          <button type="button" data-action="pickFolder" ${dis}><i class="fa-solid fa-folder"></i> ${L("PickFolder")}</button>
        </div>
        <div class="fs-row fs-actions">
          <button type="button" data-action="scan" ${dis}><i class="fa-solid fa-magnifying-glass"></i> ${L("FindRefs")}</button>
          <button type="button" data-action="unused" ${dis}><i class="fa-solid fa-broom"></i> ${L("FindUnused")}</button>
          <button type="button" data-action="exportCsv" ${hasResults && !s.busy ? "" : "disabled"}><i class="fa-solid fa-file-csv"></i> ${L("Export")}</button>
        </div>
      </div>
      <p class="fs-status" aria-live="polite">${esc(s.status)}</p>
      ${s.notes.length ? `<ul class="fs-notes">${s.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      <div class="fs-results">${this.#resultsHTML()}</div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const input = this.element.querySelector("input[name=path]");
    input?.addEventListener("change", (ev) => {
      const v = ev.target.value.trim();
      if (v !== this.state.display) this.setTarget(v);
    });
    input?.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const v = ev.target.value.trim();
      if (v !== this.state.display) this.setTarget(v);
      StewardApp.#onScan.call(this);
    });
  }

  #resultsHTML() {
    const s = this.state;
    if (s.mode === "refs") {
      if (!s.refs.length) return `<p class="fs-empty">${L("NoRefs")}</p>`;
      const rows = [...s.refs]
        .sort((a, b) => a.rootLabel.localeCompare(b.rootLabel) || a.field.localeCompare(b.field))
        .slice(0, MAX_ROWS)
        .map((r) => {
          const where = [...(r.chain ?? []), r.field].join(" › ");
          const uuid = r.uuid ?? r.rootUuid;
          const doc = uuid
            ? `<a data-action="openRef" data-uuid="${esc(uuid)}" data-root="${esc(r.rootUuid ?? "")}">${esc(r.rootLabel)}</a>`
            : esc(r.rootLabel);
          const file = s.isFolder ? `<td class="fs-path">${esc(r.normalized)}</td>` : "";
          return `<tr><td>${doc}</td><td>${esc(where)}</td>${file}<td><span class="fs-kind fs-kind-${r.kind}">${esc(L(`Kind.${r.kind}`))}</span></td></tr>`;
        })
        .join("");
      return `<table class="fs-table"><thead><tr><th>${L("Col.Document")}</th><th>${L("Col.Where")}</th>${s.isFolder ? `<th>${L("Col.File")}</th>` : ""}<th>${L("Col.Kind")}</th></tr></thead><tbody>${rows}</tbody></table>${this.#truncNote(s.refs.length)}`;
    }
    if (s.mode === "unused") {
      if (!s.unused.length) return `<p class="fs-empty">${L("NoUnused")}</p>`;
      const rows = s.unused.slice(0, MAX_ROWS).map((f) => `<tr><td class="fs-path">${esc(f.display)}</td></tr>`).join("");
      return `<table class="fs-table"><thead><tr><th>${L("Col.File")}</th></tr></thead><tbody>${rows}</tbody></table>${this.#truncNote(s.unused.length)}`;
    }
    return `<p class="fs-empty">${L("Intro")}</p>`;
  }

  #truncNote(n) {
    return n > MAX_ROWS ? `<p class="fs-note">${F("Truncated", { shown: MAX_ROWS, total: n })}</p>` : "";
  }

  #setStatus(text) {
    this.state.status = text;
    const el = this.element?.querySelector(".fs-status");
    if (el) el.textContent = text;
  }

  /** Run an operation with busy state, error handling and a final render. */
  async #run(fn) {
    if (this.state.busy) return;
    this.state.busy = true;
    this.state.notes = [];
    await this.render();
    try {
      await fn();
    } catch (err) {
      console.error(`${MODULE_ID} |`, err);
      this.state.status = F("Error", { message: err.message ?? String(err) });
      ui.notifications.error(this.state.status);
    } finally {
      this.state.busy = false;
      await this.render();
    }
  }

  #readInput() {
    const v = this.element?.querySelector("input[name=path]")?.value?.trim();
    if (v !== undefined && v !== this.state.display) this.setTarget(v);
  }

  /* ---------- actions ---------- */

  static #onPickFile() {
    this.#pick("any");
  }

  static #onPickFolder() {
    this.#pick("folder");
  }

  #pick(type) {
    const FP = FilePickerClass();
    new FP({
      type,
      current: this.state.target || undefined,
      callback: (path, picker) => {
        this.setTarget(path, { source: picker?.activeSource ?? "data", isFolder: type === "folder" });
        this.render();
      },
    }).render(true);
  }

  static async #onScan() {
    this.#readInput();
    const target = this.state.target;
    if (!target) return ui.notifications.warn(L("NeedTarget"));
    await this.#run(async () => {
      const t0 = performance.now();
      this.#setStatus(L("Scanning"));
      const { index, normalize } = await buildWorldIndex(({ done, total }) =>
        this.#setStatus(F("ScanProgress", { done, total }))
      );
      const key = this.state.isFolder ? normalizeFolder(normalize, target) : normalize(target, { requireExtension: false });
      if (!key) throw new Error(L("BadPath"));
      const refs = this.state.isFolder ? index.findFolder(key) : index.findFile(key);
      this.state.mode = "refs";
      this.state.refs = refs;
      const docs = ReferenceIndex.countDocuments(refs);
      this.state.status = F("RefsFound", {
        refs: refs.length,
        refWord: L(refs.length === 1 ? "Word.Ref" : "Word.Refs"),
        docs,
        docWord: L(docs === 1 ? "Word.Doc" : "Word.Docs"),
        scanned: index.documents,
        secs: ((performance.now() - t0) / 1000).toFixed(1),
      });
      this.state.notes = this.#caveats(false);
    });
  }

  static async #onUnused() {
    this.#readInput();
    const s = this.state;
    if (!s.target || !s.isFolder) return ui.notifications.warn(L("NeedFolder"));
    if (s.source === "s3") return ui.notifications.warn(L("NoS3"));
    await this.#run(async () => {
      this.#setStatus(L("Listing"));
      const { files, truncated } = await listFiles(s.source, s.target.replace(/\/+$/, ""), {
        onProgress: ({ files: n, folders }) => this.#setStatus(F("ListProgress", { files: n, folders })),
      });
      this.#setStatus(L("Scanning"));
      const { index, normalize } = await buildWorldIndex(({ done, total }) =>
        this.#setStatus(F("ScanProgress", { done, total }))
      );
      const unused = [];
      for (const f of files) {
        const key = normalize(f, { requireExtension: false });
        if (key && !index.has(key)) {
          unused.push({ path: f, display: decodeSafe(f) });
        }
      }
      unused.sort((a, b) => a.display.localeCompare(b.display));
      s.mode = "unused";
      s.unused = unused;
      s.status = F("UnusedFound", { unused: unused.length, files: files.length, scanned: index.documents });
      s.notes = this.#caveats(true);
      if (truncated) s.notes.unshift(L("ListTruncated"));
    });
  }

  #caveats(forUnused) {
    const notes = [L("Caveat.World")];
    const packs = worldPackCount();
    if (packs) notes.push(F("Caveat.Packs", { n: packs }));
    if (forUnused) notes.push(L("Caveat.Code"));
    return notes;
  }

  static #onExport() {
    const s = this.state;
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    let lines;
    if (s.mode === "refs") {
      lines = [["file", "document_type", "document", "location", "field", "kind", "stored_value", "uuid"].join(",")];
      for (const r of s.refs) {
        lines.push([r.normalized, r.rootType, r.rootLabel, (r.chain ?? []).join(" > "), r.field, r.kind, r.raw, r.uuid ?? r.rootUuid ?? ""].map(q).join(","));
      }
    } else if (s.mode === "unused") {
      lines = ["file", ...s.unused.map((f) => q(f.display))];
    } else return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    saveFile(lines.join("\n"), "text/csv", `file-steward-${s.mode}-${stamp}.csv`);
  }

  static async #onOpenRef(event, target) {
    const tryOpen = async (uuid) => {
      if (!uuid) return false;
      const doc = await resolveUuid(uuid).catch(() => null);
      const sheetDoc = doc?.sheet ? doc : doc?.parent?.sheet ? doc.parent : null;
      if (!sheetDoc) return false;
      sheetDoc.sheet.render(true);
      return true;
    };
    if (!(await tryOpen(target.dataset.uuid)) && !(await tryOpen(target.dataset.root))) {
      ui.notifications.info(L("NoSheet"));
    }
  }
}
