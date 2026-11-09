const assert = require("assert");
const { CodexSkillCatalog, normalizeSkillMetadata } = require(
  "../segment-ai/skill-catalog"
);

const skill = (name, scope = "repo", extra = {}) => ({
  name,
  description: `Use ${name} for its task.`,
  path: scope === "repo"
    ? `/vault/.agents/skills/${name}/SKILL.md`
    : `/agent/.codex/skills/${name}/SKILL.md`,
  scope,
  ...extra,
});

const run = async () => {
  const calls = [];
  let failure = false;
  let listed = [
    skill("project"),
    skill("local", "user"),
    skill("bundled", "system"),
    skill("admin", "admin"),
    skill("broken", "repo", { errors: [{ message: "Invalid manifest" }] }),
    skill("disabled", "user", { enabled: false }),
    skill("parent-project", "repo", { path: "/.agents/skills/parent/SKILL.md" }),
    skill("sibling-project", "repo", { path: "/vault-other/.agents/skills/sibling/SKILL.md" }),
    skill("relative", "repo", { path: "relative/SKILL.md" }),
    skill("local", "user"),
    skill("duplicate", "user"),
    skill("duplicate", "user", { path: "/agent/.agents/skills/duplicate/SKILL.md" }),
    skill("explicit-only", "user", { policy: { allowImplicitInvocation: false } }),
    skill("with-dependency", "user", {
      dependencies: { tools: [{ type: "mcp", value: "example" }] },
    }),
  ];
  const catalog = new CodexSkillCatalog({
    vaultRoot: "/vault",
    initialSkills: [skill("stale-from-previous-agent")],
    runtime: {
      async listSkills(options) {
        calls.push(options);
        if (failure) throw new Error("Discovery failed");
        return listed;
      },
    },
  });
  assert.strictEqual(catalog.loaded, false, "persisted metadata must not be used for a turn");
  const { availableSkills } = await catalog.resolveAvailable();
  assert.strictEqual(catalog.list().length, 10);
  assert.strictEqual(availableSkills.length, 8, "all enabled valid skills are available, without a fixed count");
  assert.deepStrictEqual(calls, [{ forceReload: true }]);
  assert.ok(!availableSkills.some((item) => /parent|sibling|stale|relative/.test(item.name)));
  assert.strictEqual(availableSkills.filter((item) => item.name === "duplicate").length, 2);
  assert.ok(availableSkills.some((item) => item.name === "with-dependency"), "discovery does not imply executing an external dependency");
  assert.deepStrictEqual(
    availableSkills.find((item) => item.name === "explicit-only").policy,
    { allowImplicitInvocation: false }
  );
  const copy = catalog.list();
  copy.find((item) => item.name === "explicit-only").policy.allowImplicitInvocation = true;
  copy.find((item) => item.name === "broken").errors.push("local mutation");
  assert.strictEqual(catalog.list().find((item) => item.name === "broken").errors.length, 1);
  assert.strictEqual(catalog.list().find((item) => item.name === "explicit-only").policy.allowImplicitInvocation, false);

  listed = [skill("newly-installed", "user")];
  const refreshed = await catalog.resolveAvailable();
  assert.deepStrictEqual(refreshed.availableSkills.map((item) => item.name), ["newly-installed"]);
  assert.strictEqual(calls.length, 2, "every turn refreshes installed skills");
  failure = true;
  await assert.rejects(catalog.resolveAvailable(), /Discovery failed/);
  assert.strictEqual(catalog.loaded, false);
  assert.deepStrictEqual(catalog.list(), [], "failed discovery must not fall back to stale skills");
  failure = false;
  listed = [];
  assert.deepStrictEqual(await catalog.resolveAvailable(), { availableSkills: [] });
  assert.strictEqual(catalog.loaded, true, "no installed skills is a valid discovery result");
  catalog.invalidate();
  assert.strictEqual(catalog.loaded, false);
  assert.strictEqual(normalizeSkillMetadata(null), null);

  let release;
  let concurrentCalls = 0;
  const concurrent = new CodexSkillCatalog({
    vaultRoot: "/vault",
    runtime: {
      async listSkills() {
        concurrentCalls += 1;
        return new Promise((resolve) => { release = resolve; });
      },
    },
  });
  const first = concurrent.resolveAvailable();
  const second = concurrent.resolveAvailable();
  release([skill("shared")]);
  const results = await Promise.all([first, second]);
  assert.strictEqual(concurrentCalls, 1, "simultaneous turns share one in-flight discovery");
  assert.deepStrictEqual(results[0], results[1]);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
