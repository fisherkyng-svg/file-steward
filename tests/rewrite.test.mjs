import { test } from "node:test";
import assert from "node:assert/strict";
import { makeNormalizer } from "../scripts/core/paths.js";
import { transformRaw, planRelink, buildDocUpdate, updateKey, findTwins } from "../scripts/core/rewrite.js";

const norm = makeNormalizer({ origin: "https://vtm.example.net" });

test("transformRaw keeps the stored spelling", () => {
  const o = "1 - NYC/Estate Map.png", n = "1 - NYC/Estate Map.webp";
  assert.equal(transformRaw("1 - NYC/Estate Map.png", o, n), n);
  assert.equal(transformRaw("1%20-%20NYC/Estate%20Map.png", o, n), "1%20-%20NYC/Estate%20Map.webp");
  assert.equal(transformRaw("/1%20-%20NYC/Estate%20Map.png?v=2", o, n), "/1%20-%20NYC/Estate%20Map.webp?v=2");
  assert.equal(
    transformRaw("https://vtm.example.net/1%20-%20NYC/Estate%20Map.png", o, n),
    "https://vtm.example.net/1%20-%20NYC/Estate%20Map.webp"
  );
});

test("transformRaw respects path boundaries and refuses partial matches", () => {
  assert.equal(transformRaw("maps/a.png.bak", "maps/a.png", "maps/b.png"), null);
  assert.equal(transformRaw("oldmaps/a.png", "maps/a.png", "maps/b.png"), null);
  assert.equal(transformRaw("worlds/x/maps/a.png", "maps/a.png", "maps/b.png"), "worlds/x/maps/b.png");
  // half-encoded value: don't guess
  assert.equal(transformRaw("1%20-%20NYC/Estate Map.png", "1 - NYC/Estate Map.png", "x.png"), null);
});

test("folder relink swaps only the prefix", () => {
  assert.equal(transformRaw("maps/zan/L1.webp", "maps/zan/", "maps/zanatosa/"), "maps/zanatosa/L1.webp");
  assert.equal(transformRaw("maps/zanatosa/L1.webp", "maps/zan/", "maps/x/"), null);
});

test("case-insensitive mode finds mixed case", () => {
  assert.equal(transformRaw("Maps/A.PNG", "maps/a.png", "maps/a.webp", { caseSensitive: false }), "maps/a.webp");
});

test("planRelink splits changes, missing destinations and failures", () => {
  const refs = [
    { raw: "m/a.png", field: "img", uuid: "Actor.1" },
    { raw: "m%2Fa.png", field: "img", uuid: "Actor.2" }, // encoded slash: unrecognized spelling
  ];
  const existing = new Set(["m/a.webp"]);
  const p = planRelink(refs, { oldPath: "m/a.png", newPath: "m/a.webp", normalize: norm, existing });
  assert.equal(p.changes.length, 1);
  assert.equal(p.failed.length, 1);
  const p2 = planRelink(refs.slice(0, 1), { oldPath: "m/a.png", newPath: "m/zz.webp", normalize: norm, existing });
  assert.equal(p2.missing.length, 1);
});

test("updateKey replaces whole arrays", () => {
  assert.equal(updateKey("background.src"), "background.src");
  assert.equal(updateKey("flags.mod.images.2.src"), "flags.mod.images");
});

test("buildDocUpdate: field, HTML, array, and records before/after", () => {
  const source = {
    background: { src: "m/a.png" },
    text: { content: '<img src="m/a.png"><a href="m/a.png">x</a> &amp; <img src="m/b&amp;c.png">' },
    flags: { mod: { images: [{ src: "m/keep.png" }, { src: "m/a.png" }] } },
  };
  const ch = (field, raw, newRaw) => ({ ref: { field, raw }, newRaw });
  const { update, records, unchanged } = buildDocUpdate(source, [
    ch("background.src", "m/a.png", "m/a.webp"),
    ch("text.content", "m/a.png", "m/a.webp"),
    ch("text.content", "m/b&c.png", "m/b&c.webp"),
    ch("flags.mod.images.1.src", "m/a.png", "m/a.webp"),
  ]);
  assert.equal(update["background.src"], "m/a.webp");
  assert.equal(update["text.content"], '<img src="m/a.webp"><a href="m/a.webp">x</a> &amp; <img src="m/b&amp;c.webp">');
  assert.deepEqual(update["flags.mod.images"], [{ src: "m/keep.png" }, { src: "m/a.webp" }]);
  assert.equal(records.length, 3);
  assert.equal(records.find((r) => r.key === "background.src").before, "m/a.png");
  assert.equal(unchanged.length, 0);
  assert.equal(source.background.src, "m/a.png", "source not mutated");
});

test("findTwins pairs an unused file with its used sibling", () => {
  const files = ["d/Estate%20Map.png", "d/Estate%20Map.webp", "d/Solo.webp", "d/Both.png", "d/Both.webp"];
  const used = new Set(["d/Estate%20Map.png", "d/Both.png", "d/Both.webp"]);
  const t = findTwins(files, (f) => used.has(f));
  assert.deepEqual([...t], [["d/Estate%20Map.webp", "d/Estate%20Map.png"]]);
});
