/**
 * File Steward — the GM window.
 * 0.1: find references, find unused files, export CSV (read-only).
 * 0.2: relink references to another file or folder, use twins, undo.
 * 0.3: with the server helper (sidecar): move/rename, move to trash, restore, empty trash.
 */
import { normalizeFolder } from "./core/paths.js";
import { ReferenceIndex } from "./core/index.js";
import { planRelink, findTwins } from "./core/rewrite.js";
import {
  MODULE_ID, FilePickerClass, resolveUuid, saveFile, buildWorldIndex, listFiles, worldPackCount,
} from "./foundry/world.js";
import { applyChanges, undoRecords, existingFiles, getHistory, pushOperation, markUndone } from "./foundry/rewrite.js";
import { probe, sidecar } from "./foundry/sidecar.js";

const { ApplicationV2, DialogV2 } = foundry.applications.api;
const L = (k) => game.i18n.localize(`FILESTEWARD.${k}`);
const F = (k, data) => game.i18n.format(`FILESTEWARD.${k}`, data);
const MAX_ROWS = 500;
const MAX_NOTES = 25;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const decodeSafe = (p) => {
  try { return decodeURIComponent(p ?? ""); } catch { return p ?? ""; }
};

const looksLikeFolder = (p) => !p || p.endsWith("/") || !/\.[a-z0-9]{2,5}$/i.test(p);
const baseName = (p) => decodeSafe(p).split("/").pop();
/** An unused .webp whose twin in use is not .webp: switching to it is the safe bulk direction. */
const isWebpUpgrade = (f) => !!f.twin && /\.webp$/i.test(f.path) && !/\.webp$/i.test(f.twin);
const plural = (n, one, many) => L(n === 1 ? one : many);
const fmtSize = (b) => (b == null ? "" : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);

/** Decoded path for rewriting: no leading slash; folders end in "/". */
const rewritePath = (p, isFolder) => {
  const d = decodeSafe(p).replace(/^\/+/, "");
  return isFolder && !d.endsWith("/") ? d + "/" : d;
};

export class StewardApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "file-steward",
    classes: ["file-steward"],
    tag: "section",
    window: { title: "FILESTEWARD.Title", icon: "fa-solid fa-folder-tree", resizable: true },
    position: { width: 820, height: 660 },
    actions: {
      pickFile: StewardApp.#onPickFile,
      pickFolder: StewardApp.#onPickFolder,
      scan: StewardApp.#onScan,
      unused: StewardApp.#onUnused,
      exportCsv: StewardApp.#onExport,
      openRef: StewardApp.#onOpenRef,
      relink: StewardApp.#onRelink,
      relinkTwin: StewardApp.#onRelinkTwin,
      relinkAllTwins: StewardApp.#onRelinkAllTwins,
      undo: StewardApp.#onUndo,
      sidecarCheck: StewardApp.#onSidecarCheck,
      move: StewardApp.#onMove,
      trashTarget: StewardApp.#onTrashTarget,
      trashFile: StewardApp.#onTrashFile,
      trashAllUnused: StewardApp.#onTrashAllUnused,
      showTrash: StewardApp.#onShowTrash,
      restoreItem: StewardApp.#onRestoreItem,
      purgeItem: StewardApp.#onPurgeItem,
      purgeAll: StewardApp.#onPurgeAll,
    },
  };

  state = {
    target: "",
    display: "",
    isFolder: false,
    source: "data",
    busy: false,
    status: "",
    mode: null, // "refs" | "unused" | "trash"
    refs: [],
    unused: [],
    trash: [],
    retentionDays: null,
    notes: [],
    sidecar: { state: "checking" },
  };

  /** True when the server helper answered with a valid token. */
  get #helper() {
    return this.state.sidecar.state === "ok";
  }

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
          <input id="fs-path" type="text" name="path" value="${esc(s.display)}" placeholder="${esc(L("TargetPlaceholder"))}" ${dis}>
          <button type="button" data-action="pickFile" ${dis}><i class="fa-solid fa-file-image"></i> ${L("PickFile")}</button>
          <button type="button" data-action="pickFolder" ${dis}><i class="fa-solid fa-folder"></i> ${L("PickFolder")}</button>
        </div>
        <div class="fs-row fs-actions">
          <button type="button" data-action="scan" ${dis}><i class="fa-solid fa-magnifying-glass"></i> ${L("FindRefs")}</button>
          <button type="button" data-action="unused" ${dis}><i class="fa-solid fa-broom"></i> ${L("FindUnused")}</button>
          <button type="button" data-action="relink" ${dis} data-tooltip="${esc(L("RelinkHint"))}"><i class="fa-solid fa-link"></i> ${L("RelinkBtn")}</button>
          <button type="button" data-action="exportCsv" ${hasResults && !s.busy ? "" : "disabled"}><i class="fa-solid fa-file-csv"></i> ${L("Export")}</button>
        </div>
        ${this.#helper ? `<div class="fs-row fs-actions">
          <button type="button" data-action="move" ${dis} data-tooltip="${esc(L("MoveHint"))}"><i class="fa-solid fa-file-export"></i> ${L("MoveBtn")}</button>
          <button type="button" data-action="trashTarget" ${dis}><i class="fa-solid fa-trash-can"></i> ${L("TrashBtn")}</button>
          <button type="button" data-action="showTrash" ${dis}><i class="fa-solid fa-dumpster"></i> ${L("TrashViewBtn")}</button>
        </div>` : ""}
        ${this.#sidecarHTML()}
      </div>
      <p class="fs-status" aria-live="polite">${esc(s.status)}</p>
      ${s.notes.length ? `<ul class="fs-notes">${s.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      <div class="fs-results">${this.#resultsHTML()}</div>
      ${this.#historyHTML()}`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender?.(context, options);
    this.refreshSidecar();
  }

  /** Re-check the server helper (e.g. after the GM pastes a token). */
  async refreshSidecar() {
    this.state.sidecar = { state: "checking" };
    this.state.sidecar = await probe();
    if (this.rendered !== false) this.render();
  }

  #sidecarHTML() {
    const sc = this.state.sidecar;
    const text =
      sc.state === "ok" ? F("Sidecar.Ok", { version: sc.info?.version ?? "?" })
      : sc.state === "checking" ? L("Sidecar.Checking")
      : L(`Sidecar.${sc.state}`);
    const cls = sc.state === "ok" ? "fs-ok" : sc.state === "no-token" || sc.state === "checking" ? "fs-muted" : "fs-warn";
    return `<p class="fs-sidecar ${cls}"><a data-action="sidecarCheck" data-tooltip="${esc(L("Sidecar.Recheck"))}"><i class="fa-solid fa-server"></i> ${esc(text)}</a></p>`;
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
      const dis = s.busy ? "disabled" : "";
      const twins = s.unused.filter((f) => f.twin);
      const toWebp = twins.filter(isWebpUpgrade);
      const bulk = twins.length
        ? `<div class="fs-row fs-twins-bar"><span>${esc(F("TwinsFound", { n: twins.length }))}</span>
           ${toWebp.length ? `<button type="button" data-action="relinkAllTwins" ${dis} data-tooltip="${esc(L("RelinkAllTwinsHint"))}"><i class="fa-solid fa-right-left"></i> ${esc(F("RelinkAllTwins", { n: toWebp.length }))}</button>` : ""}</div>`
        : "";
      const bulkTrash = this.#helper
        ? `<div class="fs-row fs-twins-bar"><span></span><button type="button" data-action="trashAllUnused" ${dis}><i class="fa-solid fa-trash-can"></i> ${esc(F("TrashAllUnused", { n: s.unused.length }))}</button></div>`
        : "";
      const rows = s.unused
        .slice(0, MAX_ROWS)
        .map((f) => {
          const twin = f.twin
            ? `<span class="fs-twin">${esc(F("TwinOf", { name: baseName(f.twin) }))}</span>
               <button type="button" class="fs-small" data-action="relinkTwin" data-from="${esc(f.twin)}" data-to="${esc(f.path)}" ${dis}
                 data-tooltip="${esc(F("UseThisHint", { name: baseName(f.twin) }))}">${L("UseThis")}</button>`
            : "";
          const del = this.#helper
            ? `<button type="button" class="fs-small" data-action="trashFile" data-path="${esc(f.path)}" ${dis} data-tooltip="${esc(L("TrashOneHint"))}"><i class="fa-solid fa-trash-can"></i></button>`
            : "";
          return `<tr><td class="fs-path">${esc(f.display)}</td><td class="fs-twin-cell">${twin}${del}</td></tr>`;
        })
        .join("");
      return `${bulk}${bulkTrash}<table class="fs-table"><thead><tr><th>${L("Col.File")}</th><th></th></tr></thead><tbody>${rows}</tbody></table>${this.#truncNote(s.unused.length)}`;
    }
    if (s.mode === "trash") {
      const dis = s.busy ? "disabled" : "";
      const retention = s.retentionDays ? F("TrashRetention", { n: s.retentionDays }) : L("TrashKept");
      if (!s.trash.length) return `<p class="fs-empty">${L("TrashEmpty")}</p><p class="fs-note">${esc(retention)}</p>`;
      const rows = s.trash
        .slice(0, MAX_ROWS)
        .map((t) => `<tr>
          <td class="fs-path">${t.isDir ? '<i class="fa-solid fa-folder"></i> ' : ""}${esc(t.path)}</td>
          <td>${esc(fmtSize(t.size))}</td>
          <td>${esc(new Date(t.trashedAt).toLocaleString())}</td>
          <td class="fs-twin-cell">
            <button type="button" class="fs-small" data-action="restoreItem" data-id="${esc(t.id)}" ${dis}><i class="fa-solid fa-rotate-left"></i> ${L("Restore")}</button>
            <button type="button" class="fs-small" data-action="purgeItem" data-id="${esc(t.id)}" ${dis} data-tooltip="${esc(L("PurgeOneHint"))}"><i class="fa-solid fa-xmark"></i></button>
          </td></tr>`)
        .join("");
      const total = s.trash.reduce((n, t) => n + (t.size ?? 0), 0);
      return `<div class="fs-row fs-twins-bar"><span>${esc(F("TrashSummary", { n: s.trash.length, size: fmtSize(total) }))} ${esc(retention)}</span>
          <button type="button" data-action="purgeAll" ${dis}><i class="fa-solid fa-fire"></i> ${L("PurgeAll")}</button></div>
        <table class="fs-table"><thead><tr><th>${L("Col.Original")}</th><th>${L("Col.Size")}</th><th>${L("Col.Trashed")}</th><th></th></tr></thead><tbody>${rows}</tbody></table>${this.#truncNote(s.trash.length)}`;
    }
    return `<p class="fs-empty">${L("Intro")}</p>`;
  }

  #historyHTML() {
    const last = getHistory().find((o) => !o.undone);
    if (!last) return "";
    const when = new Date(last.time).toLocaleString();
    return `<div class="fs-history fs-row">
      <span>${esc(F("LastChange", { summary: this.#summary(last), when }))}</span>
      <button type="button" data-action="undo" ${this.state.busy ? "disabled" : ""}><i class="fa-solid fa-rotate-left"></i> ${L("UndoBtn")}</button>
    </div>`;
  }

  #summary(op) {
    if (op.type === "move") return F("Summary.Move", { from: op.from, to: op.to });
    if (op.type === "trash") {
      return op.paths.length === 1 ? F("Summary.TrashOne", { name: op.paths[0] }) : F("Summary.TrashMany", { n: op.paths.length });
    }
    if (op.pairs?.length === 1) return `${op.pairs[0].from} → ${op.pairs[0].to}`;
    return F("ManyRelinked", { n: op.pairs?.length ?? 0 });
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

  #scanProgress = ({ done, total }) => this.#setStatus(F("ScanProgress", { done, total }));

  /* ---------- pickers ---------- */

  static #onPickFile() {
    this.#pick("any").then((r) => r && (this.setTarget(r.path, { source: r.source, isFolder: false }), this.render()));
  }

  static #onPickFolder() {
    this.#pick("folder").then((r) => r && (this.setTarget(r.path, { source: r.source, isFolder: true }), this.render()));
  }

  /** Open Foundry's picker; resolves with {path, source}, or never if the GM closes it. */
  #pick(type, current) {
    const FP = FilePickerClass();
    return new Promise((resolve) => {
      new FP({
        type,
        current: current ?? (this.state.target || undefined),
        callback: (path, picker) => resolve({ path, source: picker?.activeSource ?? "data" }),
      }).render(true);
    });
  }

  /* ---------- read-only reports ---------- */

  static async #onScan() {
    this.#readInput();
    const target = this.state.target;
    if (!target) return ui.notifications.warn(L("NeedTarget"));
    await this.#run(async () => {
      const t0 = performance.now();
      this.#setStatus(L("Scanning"));
      const { index, normalize } = await buildWorldIndex(this.#scanProgress);
      const key = this.state.isFolder ? normalizeFolder(normalize, target) : normalize(target, { requireExtension: false });
      if (!key) throw new Error(L("BadPath"));
      const refs = this.state.isFolder ? index.findFolder(key) : index.findFile(key);
      this.state.mode = "refs";
      this.state.refs = refs;
      const docs = ReferenceIndex.countDocuments(refs);
      this.state.status = F("RefsFound", {
        refs: refs.length,
        refWord: plural(refs.length, "Word.Ref", "Word.Refs"),
        docs,
        docWord: plural(docs, "Word.Doc", "Word.Docs"),
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
    await this.#run(() => this.#computeUnused());
  }

  /** Build the unused-files report for the current folder target (call inside #run). */
  async #computeUnused() {
    const s = this.state;
    this.#setStatus(L("Listing"));
    const { files, truncated } = await listFiles(s.source, s.target.replace(/\/+$/, ""), {
      onProgress: ({ files: n, folders }) => this.#setStatus(F("ListProgress", { files: n, folders })),
    });
    this.#setStatus(L("Scanning"));
    const { index, normalize } = await buildWorldIndex(this.#scanProgress);
    const isUsed = (f) => {
      const k = normalize(f, { requireExtension: false });
      return !!k && index.has(k);
    };
    const twins = findTwins(files, isUsed);
    const unused = files
      .filter((f) => !isUsed(f))
      .map((f) => ({ path: f, display: decodeSafe(f), twin: twins.get(f) ?? null }))
      .sort((a, b) => a.display.localeCompare(b.display));
    s.mode = "unused";
    s.unused = unused;
    s.status = F("UnusedFound", { unused: unused.length, files: files.length, scanned: index.documents });
    s.notes = this.#caveats(true);
    if (truncated) s.notes.unshift(L("ListTruncated"));
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
      lines = [["file", "used_twin"].join(","), ...s.unused.map((f) => [f.display, f.twin ? decodeSafe(f.twin) : ""].map(q).join(","))];
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

  /* ---------- relink ---------- */

  static async #onRelink() {
    this.#readInput();
    const s = this.state;
    if (!s.target) return ui.notifications.warn(L("RelinkNeedTarget"));
    const picked = await this.#pick(s.isFolder ? "folder" : "any");
    if (!picked?.path) return;
    if (rewritePath(picked.path, s.isFolder) === rewritePath(s.target, s.isFolder)) {
      return ui.notifications.warn(L("SameTarget"));
    }
    await this.#relinkPairs([{ from: s.target, to: picked.path, isFolder: s.isFolder }]);
  }

  static async #onRelinkTwin(event, target) {
    await this.#relinkPairs([{ from: target.dataset.from, to: target.dataset.to, isFolder: false }]);
  }

  static async #onRelinkAllTwins() {
    // Bulk only ever moves toward WebP; switching the other way is a per-row, deliberate choice.
    const pairs = this.state.unused.filter(isWebpUpgrade).map((f) => ({ from: f.twin, to: f.path, isFolder: false }));
    if (pairs.length) await this.#relinkPairs(pairs);
  }

  /**
   * Scan, plan, confirm, apply, log, verify. Nothing is written before the GM confirms,
   * and nothing is written for a reference whose destination file doesn't exist.
   */
  async #relinkPairs(pairs) {
    const s = this.state;
    const refreshMode = s.mode;
    await this.#run(async () => {
      this.#setStatus(L("Scanning"));
      const { index, normalize } = await buildWorldIndex(this.#scanProgress);
      const caseSensitive = game.settings.get(MODULE_ID, "caseSensitive");
      this.#setStatus(L("CheckingDestination"));
      const existing = await existingFiles(s.source, {
        files: pairs.filter((p) => !p.isFolder).map((p) => p.to),
        folders: pairs.filter((p) => p.isFolder).map((p) => p.to),
      });

      const plan = { changes: [], missing: [], failed: [] };
      const rows = [];
      const oldKeys = [];
      for (const p of pairs) {
        const oldKey = p.isFolder ? normalizeFolder(normalize, p.from) : normalize(p.from, { requireExtension: false });
        if (!oldKey) continue;
        oldKeys.push({ key: oldKey, isFolder: p.isFolder });
        const refs = p.isFolder ? index.findFolder(oldKey) : index.findFile(oldKey);
        const r = planRelink(refs, {
          oldPath: rewritePath(p.from, p.isFolder),
          newPath: rewritePath(p.to, p.isFolder),
          normalize,
          existing,
          caseSensitive,
        });
        plan.changes.push(...r.changes);
        plan.missing.push(...r.missing);
        plan.failed.push(...r.failed);
        rows.push({ from: decodeSafe(p.from), to: decodeSafe(p.to), count: r.changes.length });
      }

      const skipNotes = [
        ...plan.missing.map((m) => F("Missing", { label: m.rootLabel, file: decodeSafe(m.newRaw) })),
        ...plan.failed.map((f) => F("Failed", { label: f.rootLabel, raw: f.raw })),
      ];

      if (!plan.changes.length) {
        s.status = F("RelinkNothing", { missing: plan.missing.length, failed: plan.failed.length });
        s.notes = skipNotes.slice(0, MAX_NOTES);
        return;
      }

      const docs = new Set(plan.changes.map((c) => c.ref.uuid ?? c.ref.rootLabel)).size;
      const confirmed = await this.#confirmRelink(rows, plan, docs);
      if (!confirmed) {
        s.status = L("Cancelled");
        return;
      }

      this.#setStatus(L("Applying"));
      const result = await applyChanges(plan.changes);
      if (result.records.length) {
        await pushOperation({
          id: foundry.utils.randomID(),
          time: Date.now(),
          type: "relink",
          user: game.user.name,
          pairs: rows.map(({ from, to }) => ({ from, to })),
          records: result.records,
          undone: false,
        });
      }

      // Verify against a fresh scan rather than trusting the update calls.
      const after = await buildWorldIndex();
      const remaining = oldKeys.reduce(
        (n, o) => n + (o.isFolder ? after.index.findFolder(o.key) : after.index.findFile(o.key)).length,
        0
      );

      const changedDocs = new Set(result.records.map((r) => r.uuid)).size;
      s.status = F("RelinkDone", {
        applied: result.applied,
        refWord: plural(result.applied, "Word.Ref", "Word.Refs"),
        docs: changedDocs,
        docWord: plural(changedDocs, "Word.Doc", "Word.Docs"),
      });
      const notes = [
        ...(remaining ? [F("RelinkRemaining", { n: remaining })] : []),
        ...result.errors.map((e) => `${e.label}: ${e.reason}`),
        ...skipNotes,
      ];
      s.notes = notes.slice(0, MAX_NOTES);
      if (notes.length > MAX_NOTES) s.notes.push(F("MoreNotes", { n: notes.length - MAX_NOTES }));
      ui.notifications.info(s.status);

      // Refresh whatever report was showing so it reflects the change.
      const status = s.status;
      const kept = s.notes;
      if (refreshMode === "unused" && s.isFolder) await this.#computeUnused();
      else if (refreshMode === "refs") {
        const key = s.isFolder ? normalizeFolder(after.normalize, s.target) : after.normalize(s.target, { requireExtension: false });
        s.refs = key ? (s.isFolder ? after.index.findFolder(key) : after.index.findFile(key)) : [];
      }
      s.status = status;
      s.notes = kept;
    });
  }

  async #confirmRelink(rows, plan, docs) {
    const list = rows
      .slice(0, 15)
      .map((r) => `<tr><td class="fs-path">${esc(r.from)}</td><td>→</td><td class="fs-path">${esc(r.to)}</td><td>${r.count}</td></tr>`)
      .join("");
    const more = rows.length > 15 ? `<p>${esc(F("MoreRows", { n: rows.length - 15 }))}</p>` : "";
    const skipped = plan.missing.length + plan.failed.length;
    const n = plan.changes.length;
    const content = `
      <p>${esc(F("RelinkSummary", { refs: n, refWord: plural(n, "Word.Ref", "Word.Refs"), docs, docWord: plural(docs, "Word.Doc", "Word.Docs") }))}</p>
      <table class="fs-table fs-confirm">${list}</table>${more}
      ${skipped ? `<p>${esc(F("RelinkSkipped", { n: skipped }))}</p>` : ""}
      <p>${esc(L("RelinkSafe"))}</p>`;
    return DialogV2.confirm({
      window: { title: L("RelinkTitle"), icon: "fa-solid fa-link" },
      classes: ["file-steward-dialog"],
      content,
      rejectClose: false,
      modal: true,
    });
  }

  /* ---------- undo ---------- */

  static async #onUndo() {
    const op = getHistory().find((o) => !o.undone);
    if (!op) return;
    if ((op.type === "move" || op.type === "trash") && !this.#helper) {
      return ui.notifications.warn(L("Sidecar.NeededForUndo"));
    }
    const fields = op.records?.length ?? 0;
    const confirmed = await DialogV2.confirm({
      window: { title: L("UndoTitle"), icon: "fa-solid fa-rotate-left" },
      content: `<p>${esc(F(op.type === "trash" ? "UndoTrashConfirm" : "UndoConfirm", { n: fields, summary: this.#summary(op) }))}</p>`,
      rejectClose: false,
      modal: true,
    });
    if (!confirmed) return;
    const refreshMode = this.state.mode;
    await this.#run(async () => {
      this.#setStatus(L("Applying"));
      const notes = [];
      let restored = 0;
      if (op.records?.length) {
        const r = await undoRecords(op.records);
        restored = r.restored;
        if (r.conflicts.length) notes.push(F("UndoConflicts", { n: r.conflicts.length }), ...r.conflicts.map((c) => `${c.label}: ${c.reason}`));
      }
      // Files: bring the original back first, then send the copy to trash (never delete it outright).
      if (op.trashIds?.length) {
        const r = await sidecar.restore(op.trashIds);
        for (const e of r.errors) notes.push(F("RestoreFailed", { id: e.id, error: e.error }));
      }
      if (op.type === "move" && op.copied) {
        const r = await sidecar.trash([op.copied]);
        for (const e of r.errors) notes.push(`${e.path}: ${e.error}`);
      }
      await markUndone(op.id);
      if (refreshMode === "unused" && this.state.isFolder) await this.#computeUnused();
      if (refreshMode === "trash") await this.#loadTrash();
      this.state.status = op.type === "relink" || op.type === undefined ? F("UndoDone", { n: restored }) : F("UndoFilesDone", { summary: this.#summary(op) });
      this.state.notes = notes.slice(0, MAX_NOTES);
      ui.notifications.info(this.state.status);
    });
  }

  /* ---------- server helper: move, trash, restore ---------- */

  static async #onSidecarCheck() {
    await this.refreshSidecar();
    const st = this.state.sidecar.state;
    if (st !== "ok") ui.notifications.info(this.state.sidecar.message ? `${L(`Sidecar.${st}`)} (${this.state.sidecar.message})` : L(`Sidecar.${st}`));
  }

  static async #onMove() {
    this.#readInput();
    const s = this.state;
    if (!s.target) return ui.notifications.warn(L("NeedTarget"));
    const dest = await DialogV2.prompt({
      window: { title: L("MoveTitle"), icon: "fa-solid fa-file-export" },
      content: `<p>${esc(L("MovePrompt"))}</p><input type="text" name="dest" value="${esc(s.display.replace(/\/+$/, ""))}" style="width:100%" autofocus>`,
      ok: { label: L("MoveNext"), callback: (event, button) => button.form.elements.dest.value.trim() },
      rejectClose: false,
    });
    if (!dest) return;
    if (rewritePath(dest, s.isFolder) === rewritePath(s.target, s.isFolder)) return ui.notifications.warn(L("SameTarget"));
    await this.#movePath(s.target, dest, s.isFolder);
  }

  /**
   * Move with the helper: copy → relink → verify → trash the original.
   * The original is only trashed when nothing in the world still points at it.
   */
  async #movePath(from, to, isFolder) {
    const s = this.state;
    const fromD = decodeSafe(from).replace(/^\/+|\/+$/g, "");
    const toD = decodeSafe(to).replace(/^\/+|\/+$/g, "");
    await this.#run(async () => {
      this.#setStatus(L("Scanning"));
      const { index, normalize } = await buildWorldIndex(this.#scanProgress);
      const oldKey = isFolder ? normalizeFolder(normalize, fromD) : normalize(fromD, { requireExtension: false });
      const refs = isFolder ? index.findFolder(oldKey) : index.findFile(oldKey);
      const docs = ReferenceIndex.countDocuments(refs);

      const confirmed = await DialogV2.confirm({
        window: { title: L("MoveTitle"), icon: "fa-solid fa-file-export" },
        classes: ["file-steward-dialog"],
        content: `<p class="fs-path">${esc(fromD)} → ${esc(toD)}</p>
          <p>${esc(F("MoveConfirm", { refs: refs.length, refWord: plural(refs.length, "Word.Ref", "Word.Refs"), docs, docWord: plural(docs, "Word.Doc", "Word.Docs") }))}</p>
          <p>${esc(L("MoveSafe"))}</p>`,
        rejectClose: false,
        modal: true,
      });
      if (!confirmed) {
        s.status = L("Cancelled");
        return;
      }

      this.#setStatus(L("Copying"));
      await sidecar.copy(fromD, toD);

      let result = { records: [], errors: [], applied: 0 };
      let skipped = [];
      if (refs.length) {
        this.#setStatus(L("Applying"));
        const existing = await existingFiles(s.source, isFolder ? { folders: [toD] } : { files: [toD] });
        const plan = planRelink(refs, {
          oldPath: rewritePath(fromD, isFolder),
          newPath: rewritePath(toD, isFolder),
          normalize,
          existing,
          caseSensitive: game.settings.get(MODULE_ID, "caseSensitive"),
        });
        if (plan.changes.length) result = await applyChanges(plan.changes);
        skipped = [
          ...plan.missing.map((m) => F("Missing", { label: m.rootLabel, file: decodeSafe(m.newRaw) })),
          ...plan.failed.map((f) => F("Failed", { label: f.rootLabel, raw: f.raw })),
        ];
      }

      const after = await buildWorldIndex();
      const remaining = (isFolder ? after.index.findFolder(oldKey) : after.index.findFile(oldKey)).length;
      let trashIds = [];
      if (!remaining) {
        const t = await sidecar.trash([fromD]);
        trashIds = t.items.map((i) => i.id);
        for (const e of t.errors) skipped.push(`${e.path}: ${e.error}`);
      }

      await pushOperation({
        id: foundry.utils.randomID(),
        time: Date.now(),
        type: "move",
        user: game.user.name,
        from: fromD,
        to: toD,
        isFolder,
        copied: toD,
        records: result.records,
        trashIds,
      });

      this.setTarget(toD, { source: s.source, isFolder });
      s.mode = "refs";
      const newKey = isFolder ? normalizeFolder(after.normalize, toD) : after.normalize(toD, { requireExtension: false });
      s.refs = isFolder ? after.index.findFolder(newKey) : after.index.findFile(newKey);
      s.status = remaining
        ? F("MoveKept", { n: remaining })
        : F("MoveDone", { to: toD, applied: result.applied, refWord: plural(result.applied, "Word.Ref", "Word.Refs") });
      s.notes = [...result.errors.map((e) => `${e.label}: ${e.reason}`), ...skipped].slice(0, MAX_NOTES);
      ui.notifications.info(s.status);
    });
  }

  static async #onTrashTarget() {
    this.#readInput();
    if (!this.state.target) return ui.notifications.warn(L("NeedTarget"));
    await this.#trashPaths([{ path: this.state.target, isFolder: this.state.isFolder }], { fromUnused: false });
  }

  static async #onTrashFile(event, target) {
    await this.#trashPaths([{ path: target.dataset.path, isFolder: false }], { fromUnused: true });
  }

  static async #onTrashAllUnused() {
    await this.#trashPaths(this.state.unused.map((f) => ({ path: f.path, isFolder: false })), { fromUnused: true });
  }

  /**
   * Move files or folders to the helper's trash. Files still in use are blocked:
   * from the unused report they are dropped; for a single target the GM must confirm twice.
   */
  async #trashPaths(items, { fromUnused }) {
    const s = this.state;
    const refreshMode = s.mode;
    await this.#run(async () => {
      this.#setStatus(L("Scanning"));
      const { index, normalize } = await buildWorldIndex(this.#scanProgress);
      const withRefs = items.map((it) => {
        const d = decodeSafe(it.path).replace(/^\/+|\/+$/g, "");
        const key = it.isFolder ? normalizeFolder(normalize, d) : normalize(d, { requireExtension: false });
        const refs = key ? (it.isFolder ? index.findFolder(key) : index.findFile(key)) : [];
        return { ...it, display: d, refs };
      });
      const used = withRefs.filter((w) => w.refs.length);
      let go = withRefs.filter((w) => !w.refs.length);
      const notes = [];

      if (used.length && fromUnused) {
        // The world changed since the report: never trash something that is now in use.
        notes.push(F("NowInUse", { n: used.length }), ...used.map((u) => u.display));
      } else if (used.length) {
        const u = used[0];
        const docs = ReferenceIndex.countDocuments(u.refs);
        const anyway = await DialogV2.confirm({
          window: { title: L("StillUsedTitle"), icon: "fa-solid fa-triangle-exclamation" },
          classes: ["file-steward-dialog"],
          content: `<p class="fs-path">${esc(u.display)}</p>
            <p>${esc(F("StillUsed", { refs: u.refs.length, refWord: plural(u.refs.length, "Word.Ref", "Word.Refs"), docs, docWord: plural(docs, "Word.Doc", "Word.Docs") }))}</p>
            <ul>${[...new Set(u.refs.map((r) => r.rootLabel))].slice(0, 10).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
            <p><strong>${esc(L("StillUsedWarn"))}</strong></p>`,
          yes: { label: L("TrashAnyway"), icon: "fa-solid fa-trash-can" },
          no: { label: L("Keep"), default: true },
          rejectClose: false,
          modal: true,
        });
        if (!anyway) {
          s.status = L("Cancelled");
          return;
        }
        go = withRefs;
      }

      if (!go.length) {
        s.status = L("NothingToTrash");
        s.notes = notes.slice(0, MAX_NOTES);
        return;
      }

      const list = go.slice(0, 15).map((g) => `<li class="fs-path">${esc(g.display)}</li>`).join("");
      const more = go.length > 15 ? `<p>${esc(F("MoreRows", { n: go.length - 15 }))}</p>` : "";
      const ok = await DialogV2.confirm({
        window: { title: L("TrashTitle"), icon: "fa-solid fa-trash-can" },
        classes: ["file-steward-dialog"],
        content: `<p>${esc(F("TrashConfirm", { n: go.length }))}</p><ul>${list}</ul>${more}<p>${esc(L("TrashSafe"))}</p>`,
        rejectClose: false,
        modal: true,
      });
      if (!ok) {
        s.status = L("Cancelled");
        return;
      }

      this.#setStatus(L("Trashing"));
      const res = await sidecar.trash(go.map((g) => g.display));
      for (const e of res.errors) notes.push(`${e.path}: ${e.error}`);
      if (res.items.length) {
        await pushOperation({
          id: foundry.utils.randomID(),
          time: Date.now(),
          type: "trash",
          user: game.user.name,
          paths: res.items.map((i) => i.path),
          trashIds: res.items.map((i) => i.id),
          records: [],
        });
      }
      if (refreshMode === "unused" && s.isFolder) await this.#computeUnused();
      else if (!fromUnused) {
        s.mode = null;
        this.setTarget("", { isFolder: true });
      }
      s.status = F("TrashDone", { n: res.items.length });
      s.notes = notes.slice(0, MAX_NOTES);
      ui.notifications.info(s.status);
    });
  }

  async #loadTrash() {
    const res = await sidecar.listTrash();
    this.state.mode = "trash";
    this.state.trash = res.items;
    this.state.retentionDays = res.retentionDays;
    this.state.status = "";
  }

  static async #onShowTrash() {
    await this.#run(() => this.#loadTrash());
  }

  static async #onRestoreItem(event, target) {
    const id = target.dataset.id;
    await this.#run(async () => {
      const r = await sidecar.restore([id]);
      await this.#loadTrash();
      this.state.status = r.restored.length ? F("RestoredTo", { path: r.restored[0].path }) : L("RestoreNone");
      this.state.notes = r.errors.map((e) => F("RestoreFailed", { id: e.id, error: e.error }));
    });
  }

  static async #onPurgeItem(event, target) {
    const item = this.state.trash.find((t) => t.id === target.dataset.id);
    if (!item) return;
    const ok = await DialogV2.confirm({
      window: { title: L("PurgeTitle"), icon: "fa-solid fa-fire" },
      classes: ["file-steward-dialog"],
      content: `<p class="fs-path">${esc(item.path)}</p><p><strong>${esc(L("PurgeWarn"))}</strong></p>`,
      yes: { label: L("PurgeYes") },
      no: { label: L("Keep"), default: true },
      rejectClose: false,
      modal: true,
    });
    if (!ok) return;
    await this.#run(async () => {
      await sidecar.purge({ ids: [item.id] });
      await this.#loadTrash();
      this.state.status = F("PurgedN", { n: 1 });
    });
  }

  static async #onPurgeAll() {
    const n = this.state.trash.length;
    if (!n) return;
    const ok = await DialogV2.confirm({
      window: { title: L("PurgeTitle"), icon: "fa-solid fa-fire" },
      classes: ["file-steward-dialog"],
      content: `<p>${esc(F("PurgeAllConfirm", { n }))}</p><p><strong>${esc(L("PurgeWarn"))}</strong></p>`,
      yes: { label: L("PurgeYes") },
      no: { label: L("Keep"), default: true },
      rejectClose: false,
      modal: true,
    });
    if (!ok) return;
    await this.#run(async () => {
      const r = await sidecar.purge({ all: true });
      await this.#loadTrash();
      this.state.status = F("PurgedN", { n: r.purged });
    });
  }
}
