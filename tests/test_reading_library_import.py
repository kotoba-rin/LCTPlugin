"""Reading-only imports preserve the visible release when fetching or validation fails."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "import-reading-library.py"
SPEC = importlib.util.spec_from_file_location("reading_library_import_test", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
SOURCE_URL = "https://github.com/example/library.git"
BASE_URL = "https://example.com/lctp-library/releases"


class ReadingLibraryImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "source"
        self.cache = self.root / "private-cache"
        self.output = self.root / "public"
        self.validator = self.root / "trusted-validator.py"
        self.source.mkdir()
        self.run_git(self.source, "init", "-q", "-b", "main")
        self.run_git(self.source, "config", "user.name", "Reading Import Test")
        self.run_git(self.source, "config", "user.email", "test@example.invalid")
        self.write("README.md", "# Published library\n")
        self.write("texts/s1/original/Leçon-01.md", "<!-- id: s1-01-0001 -->\nOriginal\n")
        self.write("texts/s1/translation/Leçon-01.md", "<!-- id: s1-01-0001 -->\n译文\n\n> <!-- 建言 -->\n> main-only suggestion\n")
        self.original_revision = self.commit()
        self.run_git(self.source, "checkout", "-qb", "reading")
        self.write("texts/s1/translation/Leçon-01.md", "<!-- id: s1-01-0001 -->\n译文\n\n> [注] 保留注释。\n")
        self.provenance = {"schema_version": 1, "source_branch": "main", "source_revision": self.original_revision,
                           "transform": "remove-commentary-v1", "scanned_files": 2, "transformed_files": 1, "removed_blocks": 1}
        self.write(".reading-source.json", json.dumps(self.provenance))
        self.reading_revision = self.commit()
        # Only a locally deployed validator is executed, never one found in the fetched tree.
        self.validator.write_text(
            "import subprocess,sys\n"
            "from pathlib import Path\n"
            "assert sys.argv[1] == 'check'\n"
            "repo=Path(sys.argv[sys.argv.index('--source-root')+1])\n"
            "revision=sys.argv[sys.argv.index('--revision')+1]\n"
            "data=subprocess.check_output(['git','-C',str(repo),'show',revision+':texts/s1/translation/Leçon-01.md'])\n"
            "sys.exit(1 if '<!-- 建言 -->'.encode() in data else 0)\n",
            encoding="utf-8",
        )

    def run_git(self, repository, *args):
        return subprocess.check_output(["git", "-C", str(repository), *args], stderr=subprocess.PIPE).decode().strip()

    def write(self, relative, content):
        destination = self.source / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")

    def commit(self):
        self.run_git(self.source, "add", "-A")
        self.run_git(self.source, "commit", "-qm", "Fixture")
        return self.run_git(self.source, "rev-parse", "HEAD")

    def fetch_fixture(self, repository, source_url):
        self.assertEqual(source_url, SOURCE_URL)
        self.run_git(repository, "fetch", "--quiet", "--no-tags", str(self.source), f"+refs/heads/reading:{MODULE.READING_REF}")
        return self.run_git(repository, "rev-parse", MODULE.READING_REF)

    def publish(self):
        with patch.object(MODULE, "fetch_reading", side_effect=self.fetch_fixture):
            return MODULE.import_library(SOURCE_URL, self.cache, self.output, BASE_URL, self.validator)

    def latest_bytes(self):
        return (self.output / "latest.json").read_bytes()

    def release_manifest(self):
        latest = json.loads(self.latest_bytes())
        return self.output / "releases" / latest["version"] / "manifest.json"

    def rewrite_manifest_fixture(self, edit):
        """Simulate another validly hashed protocol revision, not transport damage."""
        builder = MODULE.load_snapshot_builder()
        latest = json.loads(self.latest_bytes())
        manifest_path = self.release_manifest()
        manifest = json.loads(manifest_path.read_bytes())
        edit(manifest)
        manifest_bytes = builder.json_bytes(manifest)
        manifest_path.write_bytes(manifest_bytes)
        latest["manifest_sha256"] = builder.sha256(manifest_bytes)
        latest_bytes = builder.json_bytes(latest)
        (self.output / "latest.json").write_bytes(latest_bytes)
        (manifest_path.parent / "release.json").write_bytes(latest_bytes)

    def add_knowledge_card(self):
        self.write("知识库/词条.md", "---\ntitle: 父之名\ntype: knowledge-card\ntags:\n  - 研讨班I\n  - 领域/精神分析/能指言说与书写\naliases: [Nom du Père]\n---\n词条首段摘录。\n\n第二段。\n")
        self.reading_revision = self.commit()

    def publish_older_generator(self):
        builder = MODULE.load_snapshot_builder()
        with patch.object(builder, "SNAPSHOT_GENERATOR", "lctp-public-library-snapshot/2"), \
                patch.object(MODULE, "load_snapshot_builder", return_value=builder):
            return self.publish()

    def test_imports_only_committed_reading_and_reuses_unchanged_release(self):
        self.write("texts/s1/translation/Leçon-01.md", "uncommitted private draft\n")
        result = self.publish()
        self.assertEqual(result["status"], "published")
        self.assertEqual(result["reading_revision"], self.reading_revision)
        self.assertEqual(result["original_revision"], self.original_revision)
        latest = json.loads(self.latest_bytes())
        self.assertEqual(latest["source_revision"], self.reading_revision)
        content = self.output / "releases" / latest["version"] / "files/texts/s1/translation/Leçon-01.md"
        self.assertEqual(content.read_text(), "<!-- id: s1-01-0001 -->\n译文\n\n> [注] 保留注释。\n")
        self.assertNotIn("main-only suggestion", content.read_text())
        before = self.latest_bytes()
        with patch.object(MODULE, "load_snapshot_builder", wraps=MODULE.load_snapshot_builder) as loader:
            second = self.publish()
            self.assertEqual(second["status"], "unchanged")
            self.assertTrue(loader.called)
        self.assertEqual(self.latest_bytes(), before)

    def test_generator_upgrade_republishes_same_reading_commit_once(self):
        self.add_knowledge_card()
        older = self.publish_older_generator()
        previous_manifest_path = self.release_manifest()
        previous_manifest = previous_manifest_path.read_bytes()
        current = self.publish()
        self.assertEqual(current["status"], "published")
        self.assertEqual(current["reading_revision"], older["reading_revision"])
        self.assertNotEqual(current["release"]["version"], older["release"]["version"])
        self.assertEqual(previous_manifest_path.read_bytes(), previous_manifest, "an upgrade must preserve the old immutable release")
        manifest = json.loads(self.release_manifest().read_bytes())
        self.assertEqual(manifest["schema_version"], 1)
        self.assertEqual(manifest["snapshot_generator"], MODULE.load_snapshot_builder().SNAPSHOT_GENERATOR)
        self.assertEqual(manifest["knowledge_entries"], [{
            "path": "知识库/词条.md", "title": "父之名", "tags": ["研讨班I", "领域/精神分析/能指言说与书写"],
            "excerpt": "词条首段摘录。", "aliases": ["Nom du Père"],
        }])
        current_bytes = self.latest_bytes()
        self.assertEqual(self.publish()["status"], "unchanged")
        self.assertEqual(self.latest_bytes(), current_bytes)

    def test_legacy_manifest_without_generator_or_catalog_rebuilds_without_touching_old_release(self):
        self.add_knowledge_card()
        older = self.publish_older_generator()

        def remove_catalog(manifest):
            manifest.pop("snapshot_generator")
            manifest.pop("knowledge_entries")

        self.rewrite_manifest_fixture(remove_catalog)
        legacy_manifest_path = self.release_manifest()
        legacy_manifest_bytes = legacy_manifest_path.read_bytes()
        result = self.publish()
        self.assertEqual(result["status"], "published")
        self.assertEqual(result["reading_revision"], older["reading_revision"])
        self.assertNotEqual(result["release"]["version"], older["release"]["version"])
        self.assertEqual(legacy_manifest_path.read_bytes(), legacy_manifest_bytes)
        self.assertEqual(len(json.loads(self.release_manifest().read_bytes())["knowledge_entries"]), 1)

    def test_current_generator_with_stale_catalog_is_never_reported_unchanged(self):
        self.add_knowledge_card()
        self.publish()
        self.rewrite_manifest_fixture(lambda manifest: manifest["knowledge_entries"][0].update(excerpt="旧目录摘录"))
        previous = self.latest_bytes()
        builder = MODULE.load_snapshot_builder()
        self.assertIsNone(MODULE.current_release(self.output, self.reading_revision, builder))
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.publish()
        self.assertEqual(self.latest_bytes(), previous, "corrupt immutable metadata is never silently overwritten")

    def test_current_generator_still_requires_an_explicit_catalog_for_an_empty_knowledge_library(self):
        self.publish()
        self.rewrite_manifest_fixture(lambda manifest: manifest.pop("knowledge_entries"))
        self.assertIsNone(MODULE.current_release(self.output, self.reading_revision, MODULE.load_snapshot_builder()))

    def test_invalid_provenance_cannot_advance_public_latest(self):
        self.publish()
        previous = self.latest_bytes()
        self.provenance["transform"] = "unstripped"
        self.write(".reading-source.json", json.dumps(self.provenance))
        self.commit()
        with self.assertRaisesRegex(ValueError, "provenance"):
            self.publish()
        self.assertEqual(self.latest_bytes(), previous)

    def test_unchanged_corrupt_release_is_detected_instead_of_reported_success(self):
        self.publish()
        previous = self.latest_bytes()
        latest = json.loads(previous)
        target = self.output / "releases" / latest["version"] / "files/README.md"
        target.write_text("corrupted immutable content\n")
        with self.assertRaisesRegex(ValueError, "differs"):
            self.publish()
        self.assertEqual(self.latest_bytes(), previous)

    def test_commentary_rejection_keeps_previous_release(self):
        self.publish()
        previous = self.latest_bytes()
        self.write("texts/s1/translation/Leçon-01.md", "译文\n\n> <!-- 建言 -->\n> must not publish\n")
        self.commit()
        with self.assertRaisesRegex(ValueError, "validation failed"):
            self.publish()
        self.assertEqual(self.latest_bytes(), previous)

    def test_network_failure_does_not_publish_main_or_change_latest(self):
        self.publish()
        previous = self.latest_bytes()
        with patch.object(MODULE, "fetch_reading", side_effect=subprocess.CalledProcessError(128, ["git", "fetch"])):
            with self.assertRaises(subprocess.CalledProcessError):
                MODULE.import_library(SOURCE_URL, self.cache, self.output, BASE_URL, self.validator)
        self.assertEqual(self.latest_bytes(), previous)

    def test_rejects_credentials_non_github_and_public_git_cache(self):
        for url in ("http://github.com/example/library.git", "https://token@github.com/example/library.git",
                    "https://github.com/example/library.git?branch=main", "https://other.example/example/library.git", "file:///tmp/repo"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                MODULE.import_library(url, self.cache, self.output, BASE_URL, self.validator)
        with self.assertRaisesRegex(ValueError, "separate"):
            MODULE.import_library(SOURCE_URL, self.output / "cache", self.output, BASE_URL, self.validator)
        self.assertFalse(self.output.exists())

    def test_existing_cache_cannot_switch_to_another_repository(self):
        self.publish()
        with self.assertRaisesRegex(ValueError, "different source"):
            MODULE.import_library("https://github.com/example/other.git", self.cache, self.output, BASE_URL, self.validator)

    def test_validator_cannot_be_loaded_from_fetched_repository(self):
        self.publish()
        fetched = self.cache / "repository" / "validator.py"
        fetched.write_text("raise SystemExit(0)")
        with self.assertRaisesRegex(ValueError, "trusted local"):
            MODULE.import_library(SOURCE_URL, self.cache, self.output, BASE_URL, fetched)

    def test_job_lock_reports_busy_without_fetch_or_output_mutation(self):
        with MODULE.import_lock(self.cache) as locked:
            self.assertTrue(locked)
            with patch.object(MODULE, "fetch_reading", side_effect=AssertionError("busy jobs must not fetch")):
                result = MODULE.import_library(SOURCE_URL, self.cache, self.output, BASE_URL, self.validator)
        self.assertEqual(result, {"status": "busy", "branch": "reading"})
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
