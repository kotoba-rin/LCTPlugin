const nodePath = require("path");
const { validateContentPath, validateVersion } = require("./validation");

const LESSON_PATH = /^texts\/([^/]+)\/(original|translation)\/((?:Leçon|Lecon|lesson)-(\d+)\.md)$/i;
const ASSET_EXTENSION = /\.(?:jpe?g|png|gif|svg|webp|avif|bmp|tiff?|emf|wmf|pdf)$/i;

const seminarIdentity = (slug) => {
  const code = slug.match(/^(s\d+[a-z]?)(?:-|$)/i)?.[1]?.toLowerCase() || slug;
  const number = Number(code.match(/^s(\d+)/)?.[1]);
  return { code, order: Number.isFinite(number) ? number + (code === "s19b" ? 0.5 : 0) : Number.MAX_SAFE_INTEGER };
};

const buildCatalog = (manifest, latest) => {
  const sourceRevision = latest.source_revision ?? null;
  if (sourceRevision !== null && (typeof sourceRevision !== "string" || sourceRevision.length > 128)) throw new Error("文库来源版本记录无效。");
  const paths = new Set(manifest.files.map((file) => validateContentPath(file.path)));
  const translations = new Map();
  for (const path of paths) {
    const match = path.match(LESSON_PATH);
    if (match?.[2].toLowerCase() === "translation") translations.set(`${match[1]}/${Number(match[4])}`, path);
  }
  const seminars = new Map();
  for (const path of paths) {
    const match = path.match(LESSON_PATH);
    if (!match || match[2].toLowerCase() !== "original") continue;
    const [, slug, , fileName, lessonPadded] = match;
    const lessonNumber = Number(lessonPadded);
    if (!Number.isSafeInteger(lessonNumber)) throw new Error("文库课次编号无效。");
    const { code, order } = seminarIdentity(slug);
    if (!seminars.has(slug)) {
      const glossaryPath = `texts/${slug}/glossary.md`;
      seminars.set(slug, { slug, code, order, title: slug, glossaryPath: paths.has(glossaryPath) ? glossaryPath : null, lessons: [] });
    }
    const expectedTranslation = `texts/${slug}/translation/${fileName}`;
    const translationPath = paths.has(expectedTranslation) ? expectedTranslation : translations.get(`${slug}/${lessonNumber}`) || expectedTranslation;
    seminars.get(slug).lessons.push({ key: path, seminarSlug: slug, seminarCode: code, lessonNumber, lessonPadded,
      title: `${code}-${lessonNumber} · Leçon ${lessonPadded}`, originalPath: path, translationPath });
  }
  const values = [...seminars.values()].sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
  for (const seminar of values) seminar.lessons.sort((a, b) => a.lessonNumber - b.lessonNumber || a.originalPath.localeCompare(b.originalPath));
  return { version: validateVersion(latest.version), sourceRevision,
    lessonCount: values.reduce((count, seminar) => count + seminar.lessons.length, 0), seminars: values };
};

const catalogCache = (manifest, latest, endpointUrl) => ({ schema_version: 1, endpoint_url: endpointUrl,
  version: latest.version, source_revision: latest.source_revision || null, files: manifest.files.map(({ path }) => ({ path })) });

const readCatalogCache = (value, endpointUrl) => {
  if (value?.schema_version !== 1 || value.endpoint_url !== endpointUrl) return null;
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 25000
    || (value.source_revision !== null && (typeof value.source_revision !== "string" || value.source_revision.length > 128))) {
    throw new Error("本地文库目录缓存损坏，请刷新文库目录。");
  }
  return buildCatalog(value, value);
};

const lessonFromCatalog = (catalog, originalPath) => {
  validateContentPath(originalPath);
  return catalog.seminars.flatMap((seminar) => seminar.lessons).find((lesson) => lesson.originalPath === originalPath) || null;
};

const referencedAssets = (text, sourcePath, files) => {
  if (typeof text !== "string") return [];
  const assets = new Set();
  const assetPaths = new Set(files.filter((file) => ASSET_EXTENSION.test(file.path)).map((file) => file.path));
  const byName = new Map();
  for (const path of assetPaths) {
    const name = nodePath.posix.basename(path);
    byName.set(name, byName.has(name) ? null : path);
  }
  const add = (raw) => {
    let reference = raw.trim().replace(/^<|>$/g, "");
    if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) return;
    reference = reference.split(/[|#?]/, 1)[0];
    try { reference = decodeURIComponent(reference); } catch { return; }
    if (!ASSET_EXTENSION.test(reference) || reference.includes("\\")) return;
    const relative = nodePath.posix.normalize(nodePath.posix.join(nodePath.posix.dirname(sourcePath), reference));
    const candidates = reference.startsWith("/") ? [reference.slice(1)] : [relative, reference];
    if (!reference.includes("/")) candidates.push(byName.get(reference));
    for (const candidate of candidates) {
      if (candidate && assetPaths.has(candidate)) { assets.add(candidate); break; }
    }
  };
  for (const match of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) add(match[1]);
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)) add(match[1]);
  for (const match of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) add(match[1]);
  return [...assets];
};

module.exports = { buildCatalog, catalogCache, readCatalogCache, lessonFromCatalog, referencedAssets };
