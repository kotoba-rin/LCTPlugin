const assert = require("assert");
const {
  buildFrenchLookup,
  getFrenchWordAt,
} = require("../src/french-lookup-text");

for (const [selection, query] of [
  ["L'identification", "identification"],
  ["L’identification", "identification"],
  ["l’Être", "Être"],
  ["s’identifiaient", "identifiaient"],
  ["qu'il", "il"],
  ["d’aujourd’hui", "aujourd’hui"],
]) {
  const result = buildFrenchLookup(selection, `On lit ${selection} ici.`);
  assert.ok(result, `${selection} must remain available for dictionary lookup`);
  assert.strictEqual(result.selection, selection);
  assert.strictEqual(result.query, query);
  assert.deepStrictEqual(result.candidates, [query, selection]);
  assert.strictEqual(result.context, `On lit ${selection} ici.`);
  assert.strictEqual(result.isPhrase, false);
  assert.strictEqual(result.elision.base, query);
  assert.strictEqual(result.elision.prefix + result.elision.base, selection);
}

for (const word of [
  "étaient", "belles", "chevaux", "œuvres", "coïncidence", "ÉTÉ",
  "aujourd'hui", "aujourd’hui", "presqu'île", "quelqu'un", "arc-en-ciel",
  "dit-il", "est-ce", "donne-t-il", "a-t-il", "rendez-vous", "arc‑en‑ciel",
]) {
  const result = buildFrenchLookup(word);
  assert.strictEqual(result.query, word, `${word} must not be reduced by guessed suffixes or apostrophe/hyphen splitting`);
  assert.strictEqual(result.selection, word);
  assert.deepStrictEqual(result.candidates, [word]);
  assert.strictEqual(result.isPhrase, false);
  assert.ok(!result.elision);
}

const sentence = "L’identification était-elle donc possible, d’après lui ?";
const phrase = buildFrenchLookup(`« ${sentence} »`, "  Voici\n\tson\u0000 contexte.\u202e ");
assert.strictEqual(phrase.selection, sentence.slice(0, -2));
assert.strictEqual(phrase.query, phrase.selection, "phrases must retain their grammatical elisions");
assert.strictEqual(phrase.context, "Voici son contexte.");
assert.strictEqual(phrase.isPhrase, true);
assert.ok(!phrase.elision);
assert.strictEqual(buildFrenchLookup("«coi\u0308ncidence!»").selection, "coïncidence");
assert.strictEqual(buildFrenchLookup("e\u0301taient").query, "étaient");
assert.strictEqual(buildFrenchLookup("l'objet a").isPhrase, true);
assert.strictEqual(buildFrenchLookup("objet, désir").isPhrase, true);

for (const invalid of [
  "", " \n\t ", null, undefined, {}, "12345", "...", "中文译文",
  "<!-- id: s7-01-0001 -->", "s7-01-0001", "s19b-01-0001",
  "id: s7-01-0001", "seminar: s7", "source-original: texts/s7/original/Leçon-01.md",
  "texts/s7/original/Leçon-01.md", "https://example.org/l’être", "app://obsidian.md/Leçon-01",
]) {
  assert.strictEqual(buildFrenchLookup(invalid), null, `invalid or metadata selection must be ignored: ${String(invalid)}`);
}
assert.ok(buildFrenchLookup("a".repeat(400)));
assert.strictEqual(buildFrenchLookup("a".repeat(401)), null, "oversized selections must not be silently changed into a different query");
const clipped = buildFrenchLookup("être", "é".repeat(605));
assert.strictEqual(Array.from(clipped.context).length, 600);
assert.strictEqual(buildFrenchLookup("être", null).context, "");

for (const word of ["L’identification", "l’Être", "s’identifiaient", "étaient", "belles", "chevaux", "œuvres", "coïncidence", "qu'il", "est-ce", "donne-t-il", "arc-en-ciel", "arc‑en‑ciel"]) {
  const text = `« ${word} », ensuite.`;
  for (let offset = 2; offset <= 2 + word.length; offset += 1) {
    assert.strictEqual(getFrenchWordAt(text, offset), word, `cursor offset ${offset} must preserve the complete token ${word}`);
  }
}
const decomposed = "Un coi\u0308ncidence rare.";
assert.strictEqual(getFrenchWordAt(decomposed, decomposed.indexOf("\u0308")), "coïncidence", "a combining-mark offset must return the whole NFC word");
assert.strictEqual(getFrenchWordAt("😀 œuvres", 4), "œuvres", "offsets use the original UTF-16 string");
for (const [text, offset] of [["", 0], ["être", -1], ["être", 5], ["être", NaN], ["中文", 1], ["s7-01-0001", 0], ["<!-- id: s7-01-0001 -->", 5]]) {
  assert.strictEqual(getFrenchWordAt(text, offset), "");
}
assert.strictEqual(getFrenchWordAt("<!-- id: s7-01-0001 -->\nL’être était.", 24), "L’être", "metadata on another line must not disable a real French word");

console.log("French lookup text tests passed");
