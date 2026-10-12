// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeNormalizer, normalizeFolder, extractCandidates } from "../scripts/core/paths.js";
import { walkDocument, ReferenceIndex } from "../scripts/core/index.js";

const ORIGIN = "https://vtm.example.net";
const norm = makeNormalizer({ origin: ORIGIN });

test("normalizes encoded, absolute and prefixed paths to one key", () => {
  const want = "assets/maps/Old Manor/floor 2.webp";
  assert.equal(norm("assets/maps/Old Manor/floor 2.webp"), want);
  assert.equal(norm("assets/maps/Old%20Manor/floor%202.webp"), want);
  assert.equal(norm("/assets/maps/Old%20Manor/floor%202.webp"), want);
  assert.equal(norm(`${ORIGIN}/assets/maps/Old%20Manor/floor%202.webp?v=3`), want);
  assert.equal(norm("./assets/maps/Old Manor/floor 2.webp"), want);
});

test("routePrefix stripped only from absolute paths", () => {
  const n = makeNormalizer({ origin: ORIGIN, routePrefix: "vtm" });
  assert.equal(n("/vtm/assets/a.webp"), "assets/a.webp");
  assert.equal(n("vtm/assets/a.webp"), "vtm/assets/a.webp"); // relative folder literally named vtm
});

test("rejects external URLs, data URIs and non-paths", () => {
  assert.equal(norm("https://other.example.com/a.webp"), null);
  assert.equal(norm("data:image/png;base64,AAAA"), null);
  assert.equal(norm("Guard Captain"), null);
  assert.equal(norm(""), null);
});

test("case-insensitive mode lowercases", () => {
  const n = makeNormalizer({ caseSensitive: false });
  assert.equal(n("Assets/Map.WEBP"), "assets/map.webp");
});

test("folder normalization always ends in slash, so maps/zan/ does not match maps/zanatosa/", () => {
  const idx = new ReferenceIndex();
  idx.add({ normalized: "maps/zanatosa/a.webp" });
  idx.add({ normalized: "maps/zan/b.webp" });
  assert.equal(normalizeFolder(norm, "maps/zan"), "maps/zan/");
  assert.equal(idx.findFolder(normalizeFolder(norm, "maps/zan")).length, 1);
});

test("extracts paths from HTML, CSS and quoted text", () => {
  const html = `<p>Look:</p><img src="assets/handouts/vey%20journal.webp" alt="x"><a href="assets/docs/plate&amp;iv.pdf">Plate</a><div style="background:url('assets/bg.png')"></div>`;
  const vals = extractCandidates(html).map((c) => `${c.kind}:${c.value}`);
  assert.ok(vals.includes("html:assets/handouts/vey%20journal.webp"));
  assert.ok(vals.includes("html:assets/docs/plate&iv.pdf"));
  assert.ok(vals.includes("html:assets/bg.png"));

  const macro = `const s = "assets/sfx/door creak.ogg";\nAudioHelper.play({src: s});`;
  assert.deepEqual(extractCandidates(macro), [{ value: "assets/sfx/door creak.ogg", kind: "text" }]);
});

test("walks embedded docs, ActorDelta, and builds uuids", () => {
  const embedded = {
    Scene: { tokens: "Token", tiles: "Tile", sounds: "AmbientSound" },
    Token: { delta: "ActorDelta" },
    ActorDelta: { items: "Item" },
    Actor: { items: "Item" },
    Item: {},
    Tile: {},
    AmbientSound: {},
  };
  const scene = {
    _id: "s1",
    name: "Sixth Chantry L-3",
    background: { src: "assets/maps/chantry/L3.webp" },
    tokens: [
      {
        _id: "t1",
        name: "Teddy",
        texture: { src: "assets/tokens/teddy.webp" },
        delta: { _id: "t1", items: [{ _id: "i1", name: "Revolver", img: "assets/icons/revolver.webp" }] },
      },
    ],
    tiles: [{ _id: "tl1", texture: { src: "assets/maps/chantry/anchor-book.webp" } }],
    sounds: [{ _id: "a1", path: "assets/sfx/choral%20drone.ogg" }],
    _stats: { compendiumSource: "Compendium.x.y.z" },
  };
  const idx = new ReferenceIndex();
  walkDocument(
    scene,
    { docName: "Scene", uuid: "Scene.s1", label: "Scene: Sixth Chantry L-3", embeddedFor: (n) => embedded[n] },
    norm,
    (r) => idx.add(r)
  );

  const bg = idx.findFile("assets/maps/chantry/L3.webp");
  assert.equal(bg.length, 1);
  assert.equal(bg[0].field, "background.src");
  assert.equal(bg[0].uuid, "Scene.s1");

  const tok = idx.findFile("assets/tokens/teddy.webp")[0];
  assert.equal(tok.uuid, "Scene.s1.Token.t1");
  assert.equal(tok.field, "texture.src");
  assert.deepEqual(tok.chain, ['Token "Teddy"']);

  const rev = idx.findFile("assets/icons/revolver.webp")[0];
  assert.equal(rev.uuid, "Scene.s1.Token.t1.ActorDelta.t1.Item.i1");
  assert.equal(rev.rootUuid, "Scene.s1");

  assert.equal(idx.findFile("assets/sfx/choral drone.ogg")[0].field, "path");
  assert.equal(idx.findFolder("assets/maps/chantry/").length, 2);
  assert.equal(ReferenceIndex.countDocuments(idx.findFolder("assets/")), 1);
  assert.equal(idx.references, 5);
});
