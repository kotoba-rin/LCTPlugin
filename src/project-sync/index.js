const { DEFAULT_PROJECT_ENDPOINT, sha256, encodeJson, parseJson, validateContentPath, validateUrl, validateLatest, validateManifest, isKnowledgePath } = require("./validation");
const { checkCancelled, fetchBytes, verifyFile, downloadArchive } = require("./downloads");
const { readBytes, digest, readHash, localChangesError, assertUnchanged, compareAndWrite, removeIfPresent, readState, rollback, cleanupTransaction, restorePreviousState, recoverTransaction, prepareTransaction } = require("./transactions");
const { decodeText } = require("./text-merge");
const { readComparison } = require("./conflict-comparison");
const { resolveConflict } = require("./resolve-conflict");
const { buildCatalog, catalogCache, readCatalogCache, lessonFromCatalog, referencedAssets } = require("./catalog");
const { getKnowledgeEntryStatuses } = require("./knowledge-status");

class ProjectSyncEngine {
  constructor({ storage, transport, endpointUrl = DEFAULT_PROJECT_ENDPOINT, stateDir = ".obsidian/plugins/lacan-translation-helper/project-sync", onProgress } = {}) {
    if (!storage?.read || !storage?.write || !storage?.remove || typeof transport !== "function") throw new Error("文库同步缺少存储或网络适配器。");
    if (typeof stateDir !== "string" || !stateDir || stateDir.startsWith("/") || stateDir.includes("\\") || stateDir.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("无效的同步状态目录。");
    this.endpointUrl = validateUrl(endpointUrl, endpointUrl);
    this.storage = storage;
    this.transport = transport;
    this.stateDir = stateDir;
    this.onProgress = onProgress;
    this.running = false;
  }

  async sync({ signal } = {}) {
    return this.withSyncLock(() => this.runSync(signal));
  }

  async cleanupLegacyBaseCache() {
    return this.withSyncLock(async () => {
      await recoverTransaction(this.storage, this.stateDir, (event) => this.onProgress?.(event));
      return (await this.storage.removeLegacyBaseCache?.()) ?? 0;
    });
  }

  async getCatalog({ signal } = {}) {
    return this.withSyncLock(async () => {
      const { latest, manifest } = await this.loadRelease(signal);
      const catalog = buildCatalog(manifest, latest);
      checkCancelled(signal);
      await this.storage.write(`${this.stateDir}/catalog.json`, encodeJson(catalogCache(manifest, latest, this.endpointUrl)));
      return catalog;
    });
  }

  async readCachedCatalog() {
    const bytes = await readBytes(this.storage, `${this.stateDir}/catalog.json`);
    return bytes === null ? null : readCatalogCache(parseJson(bytes, "本地文库目录"), this.endpointUrl);
  }

  async syncFiles(paths, { signal } = {}) {
    const selected = this.validateScope(paths);
    return this.withSyncLock(() => this.runScopedSync(selected, signal));
  }

  async getKnowledgeEntryStatuses(catalog, options = {}) {
    return getKnowledgeEntryStatuses(this, catalog, options);
  }

  async syncKnowledgeEntry(path, { signal } = {}) {
    validateContentPath(path);
    if (!isKnowledgePath(path)) throw new Error("请选择知识库中的知识卡。");
    return this.withSyncLock(async () => {
      const release = await this.loadRelease(signal);
      const catalog = buildCatalog(release.manifest, release.latest);
      const entry = catalog.knowledgeEntries.find((item) => item.path === path);
      if (!entry) {
        checkCancelled(signal);
        return { version: release.latest.version, catalog, removed: true, path, added: 0, updated: 0, deleted: 0, merged: 0, unchanged: 0,
          conflicts: [], skippedFiles: [], downloadedFiles: 0, usedArchive: false, scopePaths: [] };
      }
      checkCancelled(signal);
      await this.storage.write(`${this.stateDir}/catalog.json`, encodeJson(catalogCache(release.manifest, release.latest, this.endpointUrl)));
      const result = await this.runScopedSync([path], signal, { release, assetSources: [path], strict: true });
      return { ...result, catalog };
    });
  }

  async syncAllKnowledgeEntries({ signal, getOrderedPaths, onEntry } = {}) {
    return this.withSyncLock(async () => {
      const release = await this.loadRelease(signal);
      const catalog = buildCatalog(release.manifest, release.latest);
      checkCancelled(signal);
      await this.storage.write(`${this.stateDir}/catalog.json`, encodeJson(catalogCache(release.manifest, release.latest, this.endpointUrl)));
      const orderedPaths = await getOrderedPaths?.(catalog) || [];
      const order = new Map(orderedPaths.map((path, index) => [path, index]));
      const entries = [...catalog.knowledgeEntries].sort((a, b) =>
        (order.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.path) ?? Number.MAX_SAFE_INTEGER));
      const summary = { version: release.latest.version, catalog, entryCount: entries.length, completedEntries: 0, skippedEntries: 0,
        added: 0, updated: 0, deleted: 0, merged: 0, unchanged: 0, downloadedFiles: 0, usedArchive: false,
        conflicts: [], skippedFiles: [], scopePaths: [] };
      const skipped = new Map();
      const scope = new Set();
      // Keep one release and one lock for the whole batch. Each card and its
      // attachments must finish before the next card can start downloading.
      for (const [index, entry] of entries.entries()) {
        checkCancelled(signal);
        await onEntry?.({ entry, index, total: entries.length, catalog });
        checkCancelled(signal);
        const result = await this.runScopedSync([entry.path], signal, { release, assetSources: [entry.path], strict: true });
        summary.completedEntries += 1;
        if (result.skippedFiles.length) summary.skippedEntries += 1;
        for (const key of ["added", "updated", "deleted", "merged", "unchanged", "downloadedFiles"]) summary[key] += result[key] || 0;
        for (const file of result.skippedFiles) skipped.set(file.path, file);
        for (const path of result.scopePaths) scope.add(path);
        Object.assign(summary, { conflicts: result.conflicts, skippedFiles: [...skipped.values()], scopePaths: [...scope],
          statePath: result.statePath, conflictReportPath: result.conflictReportPath });
        await onEntry?.({ entry, index, total: entries.length, catalog, result, summary });
      }
      checkCancelled(signal);
      return summary;
    });
  }

  async syncLesson(originalPath, { signal } = {}) {
    validateContentPath(originalPath);
    return this.withSyncLock(async () => {
      await recoverTransaction(this.storage, this.stateDir, (event) => this.onProgress?.(event));
      const release = await this.loadRelease(signal);
      const lesson = lessonFromCatalog(buildCatalog(release.manifest, release.latest), originalPath);
      if (!lesson) throw new Error("这个课次不在已发布的文库目录中，请先刷新目录。");
      const paths = new Set(release.manifest.files.map((file) => file.path));
      if (!paths.has(lesson.translationPath)) throw new Error("这个课次的原文或译文尚未成对发布，已停止同步。");
      return this.runScopedSync([lesson.originalPath, lesson.translationPath], signal, { release, assetSources: [lesson.originalPath, lesson.translationPath], strict: true });
    });
  }

  async initializeSeminar(slug, { signal } = {}) {
    if (typeof slug !== "string" || !slug || slug.includes("/")) throw new Error("无效的研讨班目录。");
    return this.withSyncLock(async () => {
      await recoverTransaction(this.storage, this.stateDir, (event) => this.onProgress?.(event));
      const release = await this.loadRelease(signal);
      const seminar = buildCatalog(release.manifest, release.latest).seminars.find((entry) => entry.slug === slug);
      if (!seminar?.glossaryPath) throw new Error("这个研讨班尚未发布术语表，已停止初始化。");
      return this.runScopedSync([seminar.glossaryPath], signal, { release });
    });
  }

  validateScope(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 25000) throw new Error("请指定需要同步的文件。");
    return [...new Set(paths.map((path) => validateContentPath(path)))];
  }

  async withSyncLock(action) {
    if (this.running) throw new Error("文库同步正在进行，请等待完成。");
    this.running = true;
    try { return await action(); }
    finally { this.running = false; }
  }

  async getConflictComparison(path) {
    return this.withSyncLock(async () => {
      await recoverTransaction(this.storage, this.stateDir, (event) => this.onProgress?.(event));
      const state = await readState(this.storage, `${this.stateDir}/state.json`);
      return (await readComparison(this, state, path)).comparison;
    });
  }

  async resolveConflict(path, options) {
    return this.withSyncLock(() => resolveConflict(this, path, options));
  }

  progress(phase, completed = 0, total = 0, path) {
    this.onProgress?.({ phase, completed, total, ...(path ? { path } : {}) });
  }

  async loadRelease(signal) {
    this.progress("checking");
    const latestBytes = await fetchBytes(this.transport, this.endpointUrl, { signal, maxBytes: 256 * 1024 });
    const latest = validateLatest(parseJson(latestBytes, "文库版本接口"), this.endpointUrl);
    const manifestBytes = await fetchBytes(this.transport, latest.manifest_url, { signal, maxBytes: 16 * 1024 * 1024 });
    if (sha256(manifestBytes) !== latest.manifest_sha256) throw new Error("文库文件清单校验失败。");
    const manifest = validateManifest(parseJson(manifestBytes, "文库文件清单"), latest, this.endpointUrl);
    return { latest, manifest };
  }

  async planFiles(manifest, state, signal) {
    const plans = [];
    const remotePaths = new Set();
    for (const file of manifest.files) {
      checkCancelled(signal);
      remotePaths.add(file.path);
      const localBytes = await readBytes(this.storage, file.path);
      const localHash = digest(localBytes);
      const baseline = state.files[file.path];
      let action;
      let kind = null;
      if (await this.storage.hasUnsavedChanges?.(file.path, localHash)) {
        action = "skip"; kind = "unsaved_changes";
      } else if (localHash === null) action = "add";
      else if (baseline && localHash !== baseline) {
        action = "skip"; kind = "local_modified";
      } else if (!baseline && localHash !== file.sha256) {
        action = "skip"; kind = "existing_local_file";
      } else action = localHash === file.sha256 ? "adopt" : "update";
      plans.push({ path: file.path, file, action, kind, beforeHash: localHash, baseline });
    }
    for (const [path, baseline] of Object.entries(state.files)) {
      if (remotePaths.has(path)) continue;
      checkCancelled(signal);
      const localHash = await readHash(this.storage, path);
      const dirty = await this.storage.hasUnsavedChanges?.(path, localHash);
      const action = dirty || (localHash !== null && localHash !== baseline) ? "skip" : localHash === null ? "forget" : "delete";
      plans.push({ path, action, kind: dirty ? "unsaved_changes" : "upstream_deleted", beforeHash: localHash, baseline });
    }
    return plans;
  }

  incomingPath(version, file) {
    const versionKey = sha256(Buffer.from(version)).slice(0, 16);
    const pathKey = sha256(Buffer.from(file.path));
    const extension = file.path.match(/\.[a-z0-9]+$/i)?.[0] || ".bin";
    return `${this.stateDir}/incoming/${versionKey}/${pathKey}${extension}`;
  }

  async downloadFiles(plans, latest, manifest, state, signal, { allowArchive = true } = {}) {
    const needed = plans.filter((plan) => plan.file && ["add", "update"].includes(plan.action));
    const missing = [];
    for (const plan of needed) {
      checkCancelled(signal);
      plan.incomingPath = this.incomingPath(latest.version, plan.file);
      if (await readHash(this.storage, plan.incomingPath) === plan.file.sha256) continue;
      const previousConflict = state.conflicts?.find((entry) => entry.path === plan.path && entry.upstreamHash === plan.file.sha256);
      if (state.version && previousConflict) {
        const previousPath = this.incomingPath(previousConflict.upstreamVersion || state.version, plan.file);
        const previousData = previousConflict.incomingPath === previousPath ? await readBytes(this.storage, previousPath) : null;
        if (digest(previousData) === plan.file.sha256) {
          checkCancelled(signal);
          await this.storage.write(plan.incomingPath, previousData);
          continue;
        }
      }
      missing.push(plan);
    }
    const archiveEligible = allowArchive && !state.version && latest.archive_url && needed.length === manifest.files.length
      && needed.every((plan) => plan.action === "add") && missing.length === needed.length;
    let contents = null;
    if (archiveEligible) {
      this.progress("downloading", 0, needed.length);
      contents = await downloadArchive(this.transport, latest, manifest.files, signal);
    }
    // Verified incoming files survive interrupted or conflicting updates.
    let completed = needed.length - missing.length;
    if (!archiveEligible) this.progress("downloading", completed, needed.length);
    for (const plan of missing) {
      checkCancelled(signal);
      const data = contents ? contents[plan.path]
        : verifyFile(await fetchBytes(this.transport, plan.file.url, { signal, maxBytes: plan.file.size }), plan.file);
      checkCancelled(signal);
      await this.storage.write(plan.incomingPath, data);
      if (contents) delete contents[plan.path];
      completed += 1;
      this.progress("downloading", completed, needed.length, plan.path);
    }
    return { downloadedFiles: archiveEligible ? manifest.files.length : missing.length, usedArchive: Boolean(archiveEligible) };
  }

  conflict(plan) {
    return { path: plan.path, kind: plan.kind, incomingPath: plan.incomingPath || null, localHash: plan.beforeHash,
      upstreamHash: plan.file?.sha256 || null, baseHash: plan.baseline || null, upstreamVersion: plan.upstreamVersion,
      blocks: plan.comparison?.blocks || [], mergeable: Boolean(plan.comparison?.mergeable), missingBase: Boolean(plan.comparison?.missingBase) };
  }

  skippedFiles(plans, triggers = plans.filter((plan) => plan.action === "skip")) {
    const reasons = new Map(triggers.map((plan) => [plan.path, plan.kind || plan.reason || "changed_during_sync"]));
    const triggerPath = triggers[0]?.path;
    return plans.map((plan) => ({ path: plan.path, reason: reasons.get(plan.path) || "paired_file_modified",
      ...(!reasons.has(plan.path) && triggerPath ? { triggerPath } : {}) }));
  }

  skippedResult(plans, state, latest, downloads = { downloadedFiles: 0, usedArchive: false }, triggers) {
    this.progress("skipped", plans.length, plans.length);
    return { version: latest.version, added: 0, updated: 0, merged: 0, deleted: 0, unchanged: 0,
      localModified: plans.length, conflicts: [...(state.conflicts || [])], skippedFiles: this.skippedFiles(plans, triggers),
      statePath: `${this.stateDir}/state.json`, conflictReportPath: `${this.stateDir}/conflicts.json`,
      ...downloads, scopePaths: plans.map((plan) => plan.path) };
  }

  async guardPlans(plans) {
    for (const plan of plans) {
      if (plan.action === "skip") continue;
      try { await assertUnchanged(this.storage, plan.path, plan.beforeHash); }
      catch (error) {
        if (error.code !== "LOCAL_CHANGES_DETECTED") throw error;
        plan.action = "skip"; plan.kind = error.reason;
      }
    }
  }

  async applySyncPlans(plans, state, latest, signal, downloads, { paired = false } = {}) {
    await this.guardPlans(plans);
    if ((paired && plans.some((plan) => plan.action === "skip")) || plans.every((plan) => plan.action === "skip")) return this.skippedResult(plans, state, latest, downloads);
    const changedPaths = new Set(plans.filter((plan) => plan.action !== "skip").map((plan) => plan.path));
    const preservedConflicts = (state.conflicts || []).filter((entry) => !changedPaths.has(entry.path));
    try {
      const result = await this.applyPlans(plans, state, latest, signal, { preservedConflicts, strict: true });
      this.progress("complete", plans.length, plans.length);
      return { ...result, ...downloads, scopePaths: plans.map((plan) => plan.path) };
    } catch (error) {
      if (error.code !== "LOCAL_CHANGES_DETECTED") throw error;
      const trigger = { path: error.path, kind: error.reason };
      return this.skippedResult(plans, state, latest, downloads, [trigger]);
    }
  }

  async applyPlans(plans, state, latest, signal, { preservedConflicts = [], strict = false } = {}) {
    const journal = await prepareTransaction(this.storage, this.stateDir, plans, state, latest, signal, { rejectChanged: strict });
    const nextState = { schema_version: 2, version: latest.version, source_revision: latest.source_revision || null,
      manifest_sha256: latest.manifest_sha256, files: { ...state.files }, local_deletions: { ...(state.local_deletions || {}) },
      conflicts: [], last_transaction: journal.id, synced_at: new Date().toISOString() };
    const result = { version: latest.version, added: 0, updated: 0, merged: 0, deleted: 0, unchanged: 0, localModified: 0, conflicts: [...preservedConflicts], skippedFiles: [],
      statePath: `${this.stateDir}/state.json`, conflictReportPath: `${this.stateDir}/conflicts.json` };
    const entries = new Map(journal.entries.map((entry) => [entry.path, entry]));
    try {
      let completed = 0;
      for (const plan of plans) {
        checkCancelled(signal);
        if (entries.has(plan.path)) {
          const entry = entries.get(plan.path);
          const data = Object.hasOwn(plan, "afterBytes") ? plan.afterBytes : plan.file ? await readBytes(this.storage, plan.incomingPath) : null;
          if (digest(data) !== entry.afterHash) throw new Error(`暂存文件校验失败：${plan.path}`);
          checkCancelled(signal);
          if (!await compareAndWrite(this.storage, plan.path, entry.beforeHash, data)) {
            entry.skipped = true;
            plan.action = "skip";
            plan.kind = "changed_during_sync";
            await this.storage.write(`${this.stateDir}/journal.json`, encodeJson(journal));
            if (strict) throw localChangesError(plan.path,
              await this.storage.hasUnsavedChanges?.(plan.path, entry.beforeHash) ? "unsaved_changes" : "changed_during_sync");
          }
        }
        if (plan.action === "skip") {
          result.skippedFiles.push({ path: plan.path, reason: plan.kind });
          result.localModified += 1;
          completed += 1;
          this.progress("applying", completed, plans.length, plan.path);
          continue;
        }
        if (plan.action !== "keep_deleted") delete nextState.local_deletions[plan.path];
        if (plan.action === "conflict") result.conflicts.push(this.conflict(plan));
        else if (plan.action === "resolve") {
          if (plan.file) {
            nextState.files[plan.path] = plan.file.sha256;
            if (plan.afterBytes === null) nextState.local_deletions[plan.path] = plan.file.sha256;
          } else {
            delete nextState.files[plan.path];
            delete nextState.local_deletions[plan.path];
          }
          if (plan.afterBytes === null) result.deleted += 1;
          else result.updated += 1;
        }
        else if (plan.action === "delete" || plan.action === "forget") {
          delete nextState.files[plan.path];
          delete nextState.local_deletions[plan.path];
          if (plan.action === "delete") result.deleted += 1;
        } else if (plan.action === "keep" || plan.action === "keep_deleted") {
          result.unchanged += 1;
          result.localModified += 1;
        } else {
          nextState.files[plan.path] = plan.file.sha256;
          if (plan.action === "add") result.added += 1;
          else if (plan.action === "update") result.updated += 1;
          else if (plan.action === "merge") { result.merged += 1; result.updated += 1; }
          else result.unchanged += 1;
        }
        completed += 1;
        this.progress("applying", completed, plans.length, plan.path);
      }
      if (strict) {
        for (const plan of plans.filter((entry) => entry.action !== "skip")) {
          const entry = entries.get(plan.path);
          await assertUnchanged(this.storage, plan.path, entry ? entry.afterHash : plan.beforeHash);
        }
      }
      nextState.conflicts = result.conflicts;
      checkCancelled(signal);
      await this.storage.write(result.conflictReportPath, encodeJson({ version: latest.version, generated_at: nextState.synced_at, conflicts: result.conflicts }));
      checkCancelled(signal);
      await this.storage.write(result.statePath, encodeJson(nextState));
    } catch (error) {
      const preserved = await rollback(this.storage, journal);
      await restorePreviousState(this.storage, this.stateDir, state);
      if (preserved.length) await this.storage.write(`${this.stateDir}/recovery-conflicts.json`, encodeJson({ paths: preserved, transaction_id: journal.id,
        backups: journal.entries.filter((entry) => preserved.includes(entry.path)) }));
      await cleanupTransaction(this.storage, this.stateDir, journal, preserved);
      throw error;
    }
    // The baseline is committed. Cleanup can be retried after a restart and
    // must never roll back successfully committed project changes.
    try {
      await cleanupTransaction(this.storage, this.stateDir, journal);
      for (const plan of plans) {
        if (plan.file && !["conflict", "skip"].includes(plan.action)) await removeIfPresent(this.storage, this.incomingPath(latest.version, plan.file));
      }
      if (state.version && state.version !== latest.version) {
        for (const conflict of state.conflicts || []) {
          const plan = plans.find((entry) => entry.path === conflict.path);
          if (plan?.file && !["skip", "conflict"].includes(plan.action) && conflict.upstreamHash === plan.file.sha256) {
            const oldPath = this.incomingPath(state.version, plan.file);
            if (await readHash(this.storage, oldPath) === conflict.upstreamHash) await removeIfPresent(this.storage, oldPath);
          }
        }
      }
    } catch { result.cleanupPending = true; }
    return result;
  }

  async runSync(signal) {
    checkCancelled(signal);
    await recoverTransaction(this.storage, this.stateDir, (event) => this.onProgress?.(event));
    await this.storage.removeLegacyBaseCache?.();
    checkCancelled(signal);
    const state = await readState(this.storage, `${this.stateDir}/state.json`);
    const { latest, manifest } = await this.loadRelease(signal);
    if (state.version === latest.version && state.manifest_sha256 && state.manifest_sha256 !== latest.manifest_sha256) throw new Error("同一文库版本的内容发生变化，已停止同步。");
    const plans = await this.planFiles(manifest, state, signal);
    const downloads = await this.downloadFiles(plans, latest, manifest, state, signal);
    return this.applySyncPlans(plans, state, latest, signal, downloads);
  }

  async runScopedSync(paths, signal, { release, assetSources = [], strict = false } = {}) {
    checkCancelled(signal);
    await recoverTransaction(this.storage, this.stateDir, (event) => this.onProgress?.(event));
    await this.storage.removeLegacyBaseCache?.();
    checkCancelled(signal);
    const state = await readState(this.storage, `${this.stateDir}/state.json`);
    const { latest, manifest } = release || await this.loadRelease(signal);
    if (state.version === latest.version && state.manifest_sha256 && state.manifest_sha256 !== latest.manifest_sha256) throw new Error("同一文库版本的内容发生变化，已停止同步。");
    const selected = new Set(this.validateScope(paths));
    const remote = new Map(manifest.files.map((file) => [file.path, file]));
    for (const path of selected) {
      if (!remote.has(path) && !state.files[path]) throw new Error(`这个文件不在已发布的文库中：${path}`);
    }
    const scopeState = () => ({ ...state, files: Object.fromEntries(Object.entries(state.files).filter(([path]) => selected.has(path))) });
    const scopeManifest = () => ({ ...manifest, files: manifest.files.filter((file) => selected.has(file.path)) });
    const plans = await this.planFiles(scopeManifest(), scopeState(), signal);
    if (strict && plans.some((plan) => plan.action === "skip")) return this.skippedResult(plans, state, latest);
    const downloads = await this.downloadFiles(plans, latest, manifest, state, signal, { allowArchive: false });
    const assets = new Set();
    for (const path of assetSources) {
      checkCancelled(signal);
      const plan = plans.find((entry) => entry.path === path);
      if (!plan?.file || plan.action === "skip") continue;
      const upstream = await readBytes(this.storage, plan.incomingPath || path);
      const upstreamHash = digest(upstream);
      if (plan.incomingPath) {
        if (upstreamHash !== plan.file.sha256) throw new Error(`暂存文件校验失败：${path}`);
      } else {
        const dirty = await this.storage.hasUnsavedChanges?.(path, plan.beforeHash);
        if (dirty || upstreamHash !== plan.beforeHash || upstreamHash !== plan.file.sha256) {
          plan.action = "skip";
          plan.kind = dirty ? "unsaved_changes" : "changed_during_sync";
          continue;
        }
      }
      const text = decodeText(upstream);
      for (const asset of referencedAssets(text, path, manifest.files)) if (!selected.has(asset)) assets.add(asset);
    }
    if (strict && plans.some((plan) => plan.action === "skip")) return this.skippedResult(plans, state, latest, downloads);
    if (assets.size) {
      for (const asset of assets) selected.add(asset);
      const assetState = { ...state, files: Object.fromEntries(Object.entries(state.files).filter(([path]) => assets.has(path))) };
      const assetManifest = { ...manifest, files: manifest.files.filter((file) => assets.has(file.path)) };
      const assetPlans = await this.planFiles(assetManifest, assetState, signal);
      if (strict && assetPlans.some((plan) => plan.action === "skip")) return this.skippedResult([...plans, ...assetPlans], state, latest, downloads);
      const assetDownloads = await this.downloadFiles(assetPlans, latest, manifest, state, signal, { allowArchive: false });
      downloads.downloadedFiles += assetDownloads.downloadedFiles;
      plans.push(...assetPlans);
    }
    return this.applySyncPlans(plans, state, latest, signal, downloads, { paired: strict });
  }
}

module.exports = { ProjectSyncEngine, DEFAULT_PROJECT_ENDPOINT, sha256, validateContentPath };
