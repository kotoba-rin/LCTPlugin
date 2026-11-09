const assert = require("assert");
const { FrenchSelectionTranslator, parseTranslationResult } = require("../src/french-selection-translator");

async function run() {
  const calls = [];
  let closed = 0;
  const translator = new FrenchSelectionTranslator({ createRuntime: () => ({
    runTurn: async (input) => {
      calls.push(input);
      return { status: "completed", text: '{"translation":"认同","lemma":"identification","grammar":["identification 是阴性名词；L’ 是省音冠词。"]}' };
    },
    shutdown: async () => { closed += 1; },
  }) });
  const selection = { selection: "L’identification", context: "Séminaire 9 : L’identification" };
  const result = await translator.translate(selection);
  assert.strictEqual(result.text, "认同");
  assert.ok(result.grammar[0].includes("阴性"));
  assert.strictEqual(calls[0].researchEnabled, false);
  assert.strictEqual(calls[0].effort, "low");
  assert.ok(calls[0].prompt.includes("L’identification"));
  assert.strictEqual(closed, 1);
  assert.strictEqual(await translator.translate(selection), result);
  assert.strictEqual(calls.length, 1, "same selection and context should reuse the completed translation");
  await translator.translate({ ...selection, context: "une autre phrase" });
  assert.strictEqual(calls.length, 2, "different context must receive a separate analysis");
  assert.throws(() => parseTranslationResult("not json"), /可用结果/);
  assert.throws(() => parseTranslationResult('{"translation":123}'), /没有返回译文/);
  assert.deepStrictEqual(parseTranslationResult('```json\n{"translation":"他们曾是","grammar":[42,"être 的未完成过去时"]}\n```').grammar, ["être 的未完成过去时"]);

  const controller = new AbortController();
  let release;
  let interrupted = 0;
  const slow = new FrenchSelectionTranslator({ createRuntime: () => ({
    runTurn: () => new Promise((resolve) => { release = resolve; }),
    shutdown: async () => { interrupted += 1; },
  }) });
  const pending = slow.translate({ selection: "étaient" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.ok(interrupted > 0);
  release({ status: "completed", text: '{"translation":"过期译文"}' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(slow.cache.size, 0, "an aborted reply must not enter the result cache");
  translator.destroy();
  slow.destroy();
  console.log("French selection translator tests passed");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
