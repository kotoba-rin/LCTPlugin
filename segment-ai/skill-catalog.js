const path = require("path");

const normalizeSkillMetadata = (value) => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const name = String(value.name || "").trim();
  const skillPath = String(value.path || "").trim();
  const scope = String(value.scope || "").trim();
  if (!name || !path.isAbsolute(skillPath) || !scope) {
    return null;
  }
  return {
    name,
    description: String(value.description || "").trim(),
    path: skillPath,
    scope,
    enabled: value.enabled !== false,
    errors: Array.isArray(value.errors)
      ? value.errors.map((error) => String(error?.message || error || "")).filter(Boolean)
      : [],
    ...(value.policy ? { policy: { ...value.policy } } : {}),
    dependencies: {
      tools: Array.isArray(value.dependencies?.tools)
        ? value.dependencies.tools.map((dependency) => ({ ...dependency }))
        : [],
    },
  };
};

const isPathInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
};

class CodexSkillCatalog {
  constructor({ vaultRoot, runtime, initialSkills = [] } = {}) {
    if (!path.isAbsolute(String(vaultRoot || "")) || !runtime) {
      throw new TypeError("CodexSkillCatalog requires a Vault root and runtime.");
    }
    this.vaultRoot = path.resolve(vaultRoot);
    this.runtime = runtime;
    this.skills = this.normalizeList(initialSkills);
    // A saved list is display-only. Every turn discovers the configured agent anew.
    this.loaded = false;
    this.refreshPromise = null;
  }

  normalizeList(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : [])
      .map(normalizeSkillMetadata)
      .filter(Boolean)
      .filter((skill) => skill.scope !== "repo" || isPathInside(this.vaultRoot, skill.path))
      .filter((skill) => {
        const key = `${skill.scope}:${skill.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => (
        left.name.localeCompare(right.name)
        || left.scope.localeCompare(right.scope)
        || left.path.localeCompare(right.path)
      ));
  }

  async refresh({ forceReload = true } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const listed = await this.runtime.listSkills({ forceReload });
        this.skills = this.normalizeList(listed);
        this.loaded = true;
        return this.list();
      } catch (error) {
        this.loaded = false;
        // Never execute using a previous agent's persisted catalog after a failure.
        this.skills = [];
        throw error;
      }
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  invalidate() {
    this.loaded = false;
  }

  list() {
    return this.skills.map((skill) => ({
      ...skill,
      ...(skill.policy ? { policy: { ...skill.policy } } : {}),
      errors: [...skill.errors],
      dependencies: {
        tools: skill.dependencies.tools.map((dependency) => ({ ...dependency })),
      },
    }));
  }

  async resolveAvailable() {
    const skills = await this.refresh({ forceReload: true });
    return {
      availableSkills: skills.filter((skill) => (
        skill.enabled && skill.errors.length === 0
      )),
    };
  }
}

module.exports = { CodexSkillCatalog, normalizeSkillMetadata };
