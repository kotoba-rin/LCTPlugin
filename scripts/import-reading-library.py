#!/usr/bin/env python3
"""Publish the GitHub reading branch through an existing WordPress library directory."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit


READING_REF = "refs/lctp-import/reading"
PROVENANCE_PATH = ".reading-source.json"
TRANSFORM = "remove-commentary-v1"
COMMIT_RE = re.compile(r"^[0-9a-f]{40,64}$")
SNAPSHOT_SCRIPT = Path(__file__).resolve().with_name("build-project-snapshot.py")


def git(repository: Path, *arguments: str) -> bytes:
    environment = dict(os.environ)
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"):
        environment.pop(key, None)
    environment["GIT_TERMINAL_PROMPT"] = "0"
    return subprocess.check_output(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-C", str(repository), *arguments],
        env=environment, stderr=subprocess.PIPE, timeout=600,
    )


def validate_source_url(value: str) -> str:
    url = urlsplit(value)
    if (url.scheme != "https" or url.netloc != "github.com" or url.username or url.password
            or url.query or url.fragment or not re.fullmatch(r"/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?", url.path)
            or any(part in {".", ".."} for part in url.path.split("/"))):
        raise ValueError("--source-url must be a public HTTPS GitHub repository URL without credentials")
    return value


def validate_locations(cache_dir: Path, output_dir: Path, validator_script: Path) -> None:
    for directory in (cache_dir, output_dir):
        for parent in (directory, *directory.parents):
            if parent.is_symlink():
                raise ValueError("Library and private-cache paths cannot contain symbolic links")
    cache = cache_dir.resolve()
    output = output_dir.resolve()
    if cache == output or cache in output.parents or output in cache.parents:
        raise ValueError("The private Git cache must be separate from the public library")
    validator = validator_script.resolve()
    if not validator_script.is_file() or validator_script.is_symlink() or cache == validator or cache in validator.parents:
        raise ValueError("--validator-script must name a trusted local script outside the fetched Git cache")


@contextlib.contextmanager
def import_lock(cache_dir: Path):
    cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (cache_dir / "import.lock").open("a+b") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def initialize_repository(cache_dir: Path, source_url: str) -> Path:
    repository = cache_dir / "repository"
    marker = cache_dir / "source.json"
    if marker.exists():
        if marker.is_symlink() or json.loads(marker.read_text(encoding="utf-8")) != {"source_url": source_url, "branch": "reading"}:
            raise ValueError("The private cache belongs to a different source or branch")
    elif repository.exists():
        raise ValueError("Refusing to reuse an unmarked Git cache")
    if not repository.exists():
        repository.mkdir(mode=0o700)
        git(repository, "init", "--quiet")
        marker.write_text(json.dumps({"source_url": source_url, "branch": "reading"}) + "\n", encoding="utf-8")
        marker.chmod(0o600)
    if repository.is_symlink() or not (repository / ".git").is_dir() or (repository / ".git").is_symlink():
        raise ValueError("The private cache is not a regular standalone Git repository")
    return repository


def fetch_reading(repository: Path, source_url: str) -> str:
    # Fetch only the named reading branch. Never fall back to main or a default branch.
    # The original main commit is a direct parent and is needed by the trusted validator.
    git(repository, "fetch", "--quiet", "--no-tags", "--depth=2", source_url, f"+refs/heads/reading:{READING_REF}")
    revision = git(repository, "rev-parse", "--verify", f"{READING_REF}^{{commit}}").decode("ascii").strip()
    if not COMMIT_RE.fullmatch(revision):
        raise ValueError("Git returned an invalid reading revision")
    return revision


def read_provenance(repository: Path, revision: str) -> dict:
    size = git(repository, "cat-file", "-s", f"{revision}:{PROVENANCE_PATH}").decode("ascii").strip()
    if not size.isdigit() or int(size) > 16384:
        raise ValueError("Reading provenance exceeds its size limit")
    value = json.loads(git(repository, "show", f"{revision}:{PROVENANCE_PATH}"))
    if (not isinstance(value, dict) or type(value.get("schema_version")) is not int or value["schema_version"] != 1 or value.get("source_branch") != "main"
            or not isinstance(value.get("source_revision"), str) or not COMMIT_RE.fullmatch(value["source_revision"]) or value.get("transform") != TRANSFORM
            or any(type(value.get(field)) is not int or value[field] < 0 for field in ("removed_blocks", "transformed_files"))):
        raise ValueError("The reading branch has missing or invalid transformation provenance")
    return value


def validate_reading(repository: Path, revision: str, validator_script: Path) -> None:
    # This executable is deployed by the maintainer; code from fetched content is never run.
    result = subprocess.run(
        [sys.executable, str(validator_script), "check", "--source-root", str(repository), "--revision", revision],
        capture_output=True, text=True, timeout=300,
    )
    if result.returncode:
        raise ValueError("Reading content validation failed; the current public version was preserved")


def load_snapshot_builder():
    spec = importlib.util.spec_from_file_location("lctp_reading_snapshot", SNAPSHOT_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def current_release(output_dir: Path, revision: str, builder) -> dict | None:
    latest_path = output_dir / "latest.json"
    if not latest_path.is_file() or latest_path.is_symlink():
        return None
    try:
        latest = json.loads(latest_path.read_text(encoding="utf-8"))
        if not isinstance(latest, dict) or latest.get("source_revision") != revision:
            return None
        version = latest["version"]
        if not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", version):
            return None
        release = output_dir / "releases" / version
        manifest = release / "manifest.json"
        archive = release / "project.zip"
        if any(path.is_symlink() for path in (release, manifest, archive)) or not manifest.is_file() or not archive.is_file():
            return None
        if archive.stat().st_size != latest.get("archive_size"):
            return None
        if builder.file_hash(manifest) != latest.get("manifest_sha256") or builder.file_hash(archive) != latest.get("archive_sha256"):
            return None
        manifest_data = json.loads(manifest.read_bytes())
        if (not isinstance(manifest_data, dict) or manifest_data.get("schema_version") != 1
                or manifest_data.get("version") != version
                or manifest_data.get("snapshot_generator") != builder.SNAPSHOT_GENERATOR
                or not isinstance(manifest_data.get("knowledge_entries"), list)):
            return None
        records = manifest_data.get("files")
        if not isinstance(records, list) or len(records) != latest.get("file_count"):
            return None
        expected = {"manifest.json", "project.zip", "release.json"}
        knowledge_entries = []
        for record in records:
            path = record["path"]
            builder.validate_public_path(path)
            if not builder.is_public_namespace(path):
                return None
            target = release / "files" / path
            expected.add("files/" + path)
            if not target.is_file() or builder.file_hash(target) != record.get("sha256") or target.stat().st_size != record.get("size"):
                return None
            if path.startswith("知识库/") and Path(path).suffix.lower() == ".md":
                entry = builder.knowledge_entry(path, target.read_bytes())
                if entry is not None:
                    knowledge_entries.append(entry)
        # A matching Git commit alone is insufficient after a generator upgrade.
        # Re-derive the small catalog from already verified release content so
        # missing or stale metadata can never be reported as unchanged.
        if manifest_data["knowledge_entries"] != knowledge_entries:
            return None
        actual = set()
        for path in release.rglob("*"):
            if path.is_symlink():
                return None
            if path.is_file():
                actual.add(path.relative_to(release).as_posix())
        if actual != expected:
            return None
        return latest
    except (OSError, ValueError, KeyError, TypeError):
        return None


def import_library(source_url: str, cache_dir: Path, output_dir: Path, base_url: str, validator_script: Path) -> dict:
    source_url = validate_source_url(source_url)
    validate_locations(cache_dir, output_dir, validator_script)
    validator_script = validator_script.resolve()
    builder = load_snapshot_builder()
    builder.validate_base_url(base_url)
    with import_lock(cache_dir) as locked:
        if not locked:
            return {"status": "busy", "branch": "reading"}
        repository = initialize_repository(cache_dir, source_url)
        revision = fetch_reading(repository, source_url)
        provenance = read_provenance(repository, revision)
        validate_reading(repository, revision, validator_script)
        latest = current_release(output_dir, revision, builder)
        status = "unchanged" if latest is not None else "published"
        if latest is None:
            latest = builder.build_snapshot(repository.resolve(), output_dir, base_url, revision)
        return {"status": status, "branch": "reading", "reading_revision": revision,
                "original_revision": provenance["source_revision"], "removed_blocks": provenance["removed_blocks"], "release": latest}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--cache-dir", type=Path, required=True, help="Private directory outside the web root")
    parser.add_argument("--output-dir", type=Path, required=True, help="Existing public-library directory")
    parser.add_argument("--base-url", required=True, help="HTTPS URL of the public releases directory")
    parser.add_argument("--validator-script", type=Path, required=True, help="Trusted local publish_reading_branch.py deployed by the maintainer")
    args = parser.parse_args()
    try:
        result = import_library(args.source_url, args.cache_dir, args.output_dir, args.base_url, args.validator_script)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # Git and validator stderr can contain local environment details; keep the public job log concise.
        message = str(error) if isinstance(error, ValueError) else "Could not import the verified GitHub reading branch"
        print(f"Reading import failed: {message}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
