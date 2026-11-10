"""Behavioral checks for committed, portable public-library snapshots."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build-project-snapshot.py"
BASE_URL = "https://example.com/lctp-library/releases"


class ProjectSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.output = self.root / "output"
        self.source.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Snapshot Test")
        self.git("config", "user.email", "snapshot@example.invalid")
        self.write("README.md", "# 文库\n")
        self.write("LICENSE", "Public content license\n")
        self.write("texts/s14/original/Leçon-01.md", "<!-- id: s14-01-0001 -->\nTexte\n")
        self.write("texts/s14/translation/Leçon-01.md", "<!-- id: s14-01-0001 -->\n译文\n")
        self.write("texts/s14/notes/s14-01.md", "# Published note\n")
        self.write("知识库/测试.md", "# 知识卡\n")
        self.write("术语表/术语.csv", "fr,zh\nterme,词项\n")
        self.write("assets/图片.png", b"\x89PNG\r\n\x1a\nfixture")
        self.write(".obsidian/plugins/example/data.json", '{"private":"secret"}')
        self.write("scripts/private.py", "print('not content')\n")
        self.write("texts/.private/notes.md", "private\n")
        self.write("texts/s14/config.json", '{"token":"private"}')
        self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.source), *args]).decode().strip()

    def write(self, path, value):
        target = self.source / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value if isinstance(value, bytes) else value.encode())

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "Content fixture")
        return self.git("rev-parse", "HEAD")

    def build(self, *args, success=True):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--source-root", str(self.source),
             "--output-dir", str(self.output), "--base-url", BASE_URL, *args],
            text=True, capture_output=True,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0, "invalid snapshot unexpectedly published")
        return result

    def latest(self):
        return json.loads((self.output / "latest.json").read_text())

    def release(self):
        latest = self.latest()
        return self.output / "releases" / latest["version"]

    def snapshot_module(self):
        spec = importlib.util.spec_from_file_location("project_snapshot_test_module", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_publishes_only_committed_public_content_with_consistent_hashes(self):
        revision = self.git("rev-parse", "HEAD")
        self.write("texts/s14/translation/Leçon-01.md", "Uncommitted local change\n")
        self.write("texts/s14/notes/private-untracked.md", "Do not publish\n")
        result = self.build()
        latest = self.latest()
        release = self.release()
        manifest_bytes = (release / "manifest.json").read_bytes()
        manifest = json.loads(manifest_bytes)
        paths = {file["path"] for file in manifest["files"]}
        self.assertEqual(latest["source_revision"], revision)
        self.assertEqual(latest["version"], manifest["version"])
        self.assertEqual(latest["file_count"], 8)
        self.assertEqual(result["version"], latest["version"])
        self.assertIn("texts/s14/notes/s14-01.md", paths)
        self.assertNotIn("texts/s14/notes/private-untracked.md", paths)
        self.assertFalse(any(path.startswith((".obsidian/", "scripts/", "texts/.private/")) for path in paths))
        self.assertNotIn("texts/s14/config.json", paths)
        self.assertEqual(latest["manifest_sha256"], hashlib.sha256(manifest_bytes).hexdigest())
        archive = (release / "project.zip").read_bytes()
        self.assertEqual(latest["archive_sha256"], hashlib.sha256(archive).hexdigest())
        self.assertEqual(latest["archive_size"], len(archive))
        with zipfile.ZipFile(release / "project.zip") as zipped:
            self.assertEqual(set(zipped.namelist()), paths)
            self.assertEqual(zipped.read("texts/s14/translation/Leçon-01.md"), "<!-- id: s14-01-0001 -->\n译文\n".encode())
            for file in manifest["files"]:
                data = (release / "files" / file["path"]).read_bytes()
                self.assertEqual(zipped.read(file["path"]), data)
                self.assertEqual(file["size"], len(data))
                self.assertEqual(file["sha256"], hashlib.sha256(data).hexdigest())
                self.assertTrue(file["url"].startswith(f"{BASE_URL}/{latest['version']}/files/"))
        unicode_entry = next(file for file in manifest["files"] if file["path"] == "知识库/测试.md")
        self.assertIn("%E7%9F%A5%E8%AF%86%E5%BA%93", unicode_entry["url"])
        self.assertEqual(latest["manifest_url"], f"{BASE_URL}/{latest['version']}/manifest.json")

    def test_knowledge_catalog_uses_committed_card_metadata_without_loading_repository_code(self):
        sentinel = self.root / "must-not-execute"
        first_paragraph = "🙂界" * 70
        committed_card = (
            "---\ntitle: 'Agalma：珍宝与对象 a'\ntype: knowledge-card\n"
            "tags:\n  - 研讨班VIII\n  - 领域/精神分析/欲望驱力与客体\n"
            "aliases: [阿伽尔玛, \"hidden, treasure\", L'amour]\n"
            f"custom: !!python/object/apply:os.system ['touch {sentinel}']\n"
            f"---\n\n{first_paragraph}\n\n不纳入摘录的第二段。\n"
        )
        self.write("知识库/测试.md", committed_card)
        self.write("知识库/README.md", "---\ntype: knowledge-card\ntitle: 目录\ntags: []\n---\n索引\n")
        self.write("知识库/空文件.md", "")
        self.write("知识库/索引.md", "---\ntype: index\ntitle: 索引\n---\n内容\n")
        self.write("texts/s14/notes/not-a-card.md", committed_card)
        self.write("scripts/build-catalog.py", f"from pathlib import Path\nPath({str(sentinel)!r}).touch()\n")
        revision = self.commit()
        self.write("知识库/测试.md", committed_card.replace("珍宝与对象 a", "未提交的私人标题"))
        self.write("知识库/未提交.md", committed_card)
        self.build("--revision", revision)
        manifest = json.loads((self.release() / "manifest.json").read_text())
        self.assertEqual(manifest["schema_version"], 1)
        self.assertEqual(manifest["snapshot_generator"], self.snapshot_module().SNAPSHOT_GENERATOR)
        self.assertEqual(manifest["knowledge_entries"], [{
            "path": "知识库/测试.md", "title": "Agalma：珍宝与对象 a",
            "tags": ["研讨班VIII", "领域/精神分析/欲望驱力与客体"],
            "excerpt": first_paragraph[:120], "aliases": ["阿伽尔玛", "hidden, treasure", "L'amour"],
        }])
        self.assertEqual(len(manifest["knowledge_entries"][0]["excerpt"]), 120)
        file = next(record for record in manifest["files"] if record["path"] == "知识库/测试.md")
        self.assertEqual(file["sha256"], hashlib.sha256(committed_card.encode()).hexdigest())
        self.assertEqual((self.release() / "files" / "知识库/测试.md").read_text(), committed_card)
        self.assertFalse(sentinel.exists())

    def test_catalog_strings_are_read_as_data_and_optional_aliases_are_not_required(self):
        module = self.snapshot_module()
        data = (
            '---\ntype: "knowledge-card" # card type\ntitle: "名字 # one"\n'
            'tags: ["领域/文学/文学理论", \'作品/L\'\'amour\']\n'
            '自定义.属性: !!python/object/apply:os.system\n'
            'extra:\n  nested: [not, executable]\n---\n\n第一段\n继续本段。\n\n第二段。\n'
        ).encode()
        self.assertEqual(module.knowledge_entry("知识库/示例.md", data), {
            "path": "知识库/示例.md", "title": "名字 # one",
            "tags": ["领域/文学/文学理论", "作品/L'amour"], "excerpt": "第一段 继续本段。",
        })
        for data in (b"", b"# Legacy note\n", b"---\ntype: index\n---\n", b"---\ntype: !!python/object/apply:os.system\n---\n"):
            with self.subTest(data=data):
                self.assertIsNone(module.knowledge_entry("知识库/示例.md", data))

    def test_invalid_knowledge_metadata_never_advances_latest(self):
        self.build()
        latest = (self.output / "latest.json").read_bytes()
        self.write("知识库/测试.md", "---\ntype: knowledge-card\ntitle: !!python/object/apply:os.system\ntags: []\n---\n正文\n")
        self.commit()
        result = self.build(success=False)
        self.assertIn("Invalid knowledge-card metadata", result.stderr)
        self.assertEqual((self.output / "latest.json").read_bytes(), latest)
        self.assertFalse(any(path.name.startswith(".snapshot-") for path in self.output.iterdir()))

    def test_knowledge_metadata_limits_match_the_catalog_protocol(self):
        module = self.snapshot_module()
        invalid_fields = (
            "title: " + "长" * 301 + "\ntags: []",
            "title: 词条\ntags: [" + ", ".join(f"标签{i}" for i in range(65)) + "]",
            "title: 词条\ntags: [" + "长" * 161 + "]",
            "title: 词条\ntags: []\naliases: [" + ", ".join(f"别名{i}" for i in range(33)) + "]",
            "title: 词条\ntags: []\naliases: [" + "长" * 301 + "]",
            "title: 词条\ntitle: 重复字段\ntags: []",
            "title: 词条\ntags:\n  - !!python/object/apply:os.system",
        )
        for fields in invalid_fields:
            with self.subTest(fields=fields[:100]):
                content = f"---\ntype: knowledge-card\n{fields}\n---\n正文\n".encode()
                with self.assertRaisesRegex(ValueError, "Invalid knowledge-card metadata"):
                    module.knowledge_entry("知识库/示例.md", content)

    def test_generator_and_catalog_changes_create_new_immutable_versions(self):
        self.write("知识库/测试.md", "---\ntitle: 词条\ntype: knowledge-card\ntags: []\n---\n正文\n")
        self.commit()
        module = self.snapshot_module()
        first = module.build_snapshot(self.source, self.output, BASE_URL)
        first_release = self.release()
        first_manifest = (first_release / "manifest.json").read_bytes()
        manifest = json.loads(first_manifest)
        records = [{key: value for key, value in file.items() if key != "url"} for file in manifest["files"]]
        legacy_digest = hashlib.sha256(module.json_bytes(records)).hexdigest()
        self.assertNotEqual(first["version"], f"r-{first['source_revision'][:12]}-{legacy_digest[:12]}")
        with patch.object(module, "SNAPSHOT_GENERATOR", "test-generator-next-version"):
            second = module.build_snapshot(self.source, self.output, BASE_URL)
        self.assertEqual(json.loads((self.release() / "manifest.json").read_text())["snapshot_generator"], "test-generator-next-version")
        self.assertNotEqual(first["version"], second["version"])
        original_reader = module.knowledge_entry

        def changed_metadata(path, content):
            entry = original_reader(path, content)
            return {**entry, "excerpt": "同一正文的新目录摘录"} if entry else None

        with patch.object(module, "knowledge_entry", side_effect=changed_metadata):
            third = module.build_snapshot(self.source, self.output, BASE_URL)
        self.assertNotEqual(first["version"], third["version"])
        self.assertEqual((first_release / "manifest.json").read_bytes(), first_manifest)
        self.assertEqual(first["source_revision"], third["source_revision"])
        self.assertEqual(first["archive_sha256"], third["archive_sha256"])

    def test_same_revision_is_reproducible_and_reuses_immutable_version(self):
        self.build()
        first = (self.output / "latest.json").read_bytes()
        archive = (self.release() / "project.zip").read_bytes()
        self.build()
        self.assertEqual((self.output / "latest.json").read_bytes(), first)
        self.assertEqual((self.release() / "project.zip").read_bytes(), archive)
        second_output = self.root / "second-output"
        self.build("--output-dir", str(second_output))
        second_latest = json.loads((second_output / "latest.json").read_text())
        second_archive = second_output / "releases" / second_latest["version"] / "project.zip"
        self.assertEqual(second_archive.read_bytes(), archive)
        self.assertFalse(any(path.name.startswith(".snapshot-") for path in self.output.iterdir()))

    def test_explicit_revision_ignores_newer_commits(self):
        revision = self.git("rev-parse", "HEAD")
        self.write("texts/s14/original/Leçon-02.md", "new commit\n")
        self.commit()
        self.build("--revision", revision)
        manifest = json.loads((self.release() / "manifest.json").read_text())
        self.assertNotIn("texts/s14/original/Leçon-02.md", [file["path"] for file in manifest["files"]])

    def test_existing_version_cannot_be_replaced_by_different_content(self):
        self.build("--version", "fixed-release")
        latest = (self.output / "latest.json").read_bytes()
        self.write("texts/s14/original/Leçon-01.md", "changed committed text\n")
        self.commit()
        result = self.build("--version", "fixed-release", success=False)
        self.assertIn("immutable", result.stderr.lower())
        self.assertEqual((self.output / "latest.json").read_bytes(), latest)

    def test_corrupted_existing_version_does_not_get_silently_repaired(self):
        self.build()
        latest = (self.output / "latest.json").read_bytes()
        (self.release() / "files" / "README.md").write_text("corruption")
        self.build(success=False)
        self.assertEqual((self.output / "latest.json").read_bytes(), latest)

    def test_symlinks_are_rejected_without_advancing_latest(self):
        self.build()
        latest = (self.output / "latest.json").read_bytes()
        (self.source / "texts" / "alias.md").symlink_to("../README.md")
        self.commit()
        result = self.build(success=False)
        self.assertIn("symlink", result.stderr.lower())
        self.assertEqual((self.output / "latest.json").read_bytes(), latest)

    def test_windows_reserved_names_are_rejected(self):
        self.write("texts/s14/CON.md", "not portable\n")
        self.commit()
        result = self.build(success=False)
        self.assertIn("Windows", result.stderr)
        self.assertFalse((self.output / "latest.json").exists())

    def test_case_collisions_are_rejected(self):
        original = "texts/s14/original/Leçon-01.md"
        oid = self.git("rev-parse", f"HEAD:{original}")
        self.git("update-index", "--add", "--cacheinfo", f"100644,{oid},texts/s14/original/LEÇON-01.md")
        self.git("commit", "-qm", "case collision")
        result = self.build(success=False)
        self.assertIn("collision", result.stderr.lower())

    def test_case_collisions_in_directory_names_are_rejected(self):
        oid = self.git("rev-parse", "HEAD:README.md")
        self.git("update-index", "--add", "--cacheinfo", f"100644,{oid},texts/S14/new.md")
        self.git("commit", "-qm", "directory case collision")
        result = self.build(success=False)
        self.assertIn("collision", result.stderr.lower())

    def test_oversized_git_object_is_rejected_and_reader_is_stopped(self):
        spec = importlib.util.spec_from_file_location("project_snapshot_test_module", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with patch.object(module, "MAX_FILE_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "client limit"):
                module.build_snapshot(self.source, self.output, BASE_URL)
        self.assertFalse((self.output / "latest.json").exists())
        self.assertFalse(any(path.name.startswith(".snapshot-") for path in self.output.iterdir()))

    def test_public_release_permissions_do_not_depend_on_builders_umask(self):
        previous = os.umask(0o077)
        try:
            self.build()
        finally:
            os.umask(previous)
        self.assertEqual(stat.S_IMODE(self.release().stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.output / "latest.json").stat().st_mode), 0o644)
        for file in self.release().rglob("*"):
            if file.is_file():
                self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o644)
            elif file.is_dir():
                self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o755)

    def test_non_nfc_names_are_rejected(self):
        self.git("config", "core.precomposeunicode", "false")
        oid = self.git("rev-parse", "HEAD:README.md")
        self.git("update-index", "--add", "--cacheinfo", f"100644,{oid},texts/s14/Cafe\u0301.md")
        self.git("commit", "-qm", "decomposed path")
        result = self.build(success=False)
        self.assertIn("NFC", result.stderr)

    def test_unsafe_arguments_are_rejected_before_writing_output(self):
        for args in (("--version", "../escape"), ("--version", "v" * 81), ("--base-url", "http://example.com/releases"),
                     ("--base-url", "https://user:password@example.com/releases"), ("--revision", "--all")):
            with self.subTest(args=args):
                self.build(*args, success=False)
                self.assertFalse((self.output / "latest.json").exists())


if __name__ == "__main__":
    unittest.main()
