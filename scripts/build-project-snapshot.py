#!/usr/bin/env python3
"""Build an immutable public-library snapshot from committed Git objects."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit


CONTENT_DIRECTORIES = {"texts", "知识库", "术语表", "assets"}
ROOT_FILES = {"README.md", "LICENSE", "LICENSE.md", "NOTICE.md"}
CONTENT_EXTENSIONS = {
    ".md", ".jpeg", ".jpg", ".png", ".gif", ".svg", ".webp", ".avif", ".bmp",
    ".tif", ".tiff", ".emf", ".wmf", ".pdf", ".csv", ".txt",
}
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
WINDOWS_RESERVED_RE = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?$", re.I)
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_FILES = 25000


def git(source: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(source), *args], stderr=subprocess.PIPE)


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_base_url(value: str) -> str:
    parsed = urlsplit(value)
    parsed.port  # Reject malformed port numbers before emitting any public URL.
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or "\\" in value):
        raise ValueError("--base-url must be an HTTPS URL without credentials, query or fragment")
    if any(part in {".", ".."} for part in parsed.path.split("/")):
        raise ValueError("--base-url must not contain path traversal")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def is_public_namespace(path: str) -> bool:
    parts = path.split("/")
    return path in ROOT_FILES or (len(parts) > 1 and parts[0] in CONTENT_DIRECTORIES)


def validate_public_path(path: str) -> None:
    if unicodedata.normalize("NFC", path) != path:
        raise ValueError(f"Content path must use NFC Unicode: {path!r}")
    if not path or len(path.encode("utf-16-le")) // 2 > 700 or path.startswith("/") or "\\" in path:
        raise ValueError(f"Invalid content path: {path!r}")
    for part in path.split("/"):
        if not part or part.startswith(".") or part.endswith((" ", ".")):
            raise ValueError(f"Invalid Windows content path: {path!r}")
        if WINDOWS_RESERVED_RE.match(part) or any(ord(char) < 32 or ord(char) == 127 or char in '<>:"|?*' for char in part):
            raise ValueError(f"Invalid Windows content path: {path!r}")


def committed_entries(source: Path, revision: str) -> tuple[str, list[tuple[str, str]]]:
    if not revision or revision.startswith("-"):
        raise ValueError("--revision must name a committed revision")
    top_level = Path(git(source, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    if source != top_level:
        raise ValueError("--source-root must be the Git repository root")
    commit = git(source, "rev-parse", "--verify", f"{revision}^{{commit}}").decode().strip()
    entries = []
    seen = {}
    for raw_entry in git(source, "ls-tree", "-r", "-z", "--full-tree", commit).split(b"\0"):
        if not raw_entry:
            continue
        metadata, raw_path = raw_entry.split(b"\t", 1)
        path = raw_path.decode("utf-8")
        if not is_public_namespace(path) or any(part.startswith(".") for part in path.split("/")):
            continue
        mode, object_type, object_id = metadata.decode("ascii").split(" ")
        if mode == "120000":
            raise ValueError(f"Public content cannot contain a symlink: {path!r}")
        if object_type != "blob" or mode not in {"100644", "100755"}:
            raise ValueError(f"Public content must be regular files: {path!r}")
        validate_public_path(path)
        if path not in ROOT_FILES and Path(path).suffix.lower() not in CONTENT_EXTENSIONS:
            continue
        parts = path.split("/")
        for length in range(1, len(parts) + 1):
            prefix = "/".join(parts[:length])
            folded = prefix.casefold()
            if folded in seen and seen[folded] != prefix:
                raise ValueError(f"Windows path collision: {seen[folded]!r} and {prefix!r}")
            seen[folded] = prefix
        entries.append((path, object_id))
    if not entries:
        raise ValueError("The selected revision contains no public-library files")
    if len(entries) > MAX_FILES:
        raise ValueError("Public library exceeds the client file-count limit")
    return commit, sorted(entries)


class GitBlobReader:
    """Read one object at a time so large libraries do not occupy a second full copy in memory."""

    def __init__(self, source: Path):
        self.process = subprocess.Popen(
            ["git", "-C", str(source), "cat-file", "--batch"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def read(self, object_id: str) -> bytes:
        self.process.stdin.write((object_id + "\n").encode("ascii"))
        self.process.stdin.flush()
        header = self.process.stdout.readline().decode("ascii").strip().split(" ")
        if len(header) != 3 or header[0] != object_id or header[1] != "blob":
            raise ValueError("Git returned an unexpected content object")
        size = int(header[2])
        if size > MAX_FILE_BYTES:
            raise ValueError(f"Public file exceeds the {MAX_FILE_BYTES} byte client limit")
        content = self.process.stdout.read(size)
        if len(content) != size or self.process.stdout.read(1) != b"\n":
            raise ValueError("Git returned an incomplete content object")
        return content

    def close(self, *, abort: bool = False):
        self.process.stdin.close()
        if abort and self.process.poll() is None:
            self.process.terminate()
        try:
            status = self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            status = self.process.wait()
        detail = self.process.stderr.read().decode("utf-8", errors="replace").strip()
        self.process.stdout.close()
        self.process.stderr.close()
        if status and not abort:
            raise ValueError(f"Git object reader failed: {detail}")


def write_content(source: Path, entries: list[tuple[str, str]], stage: Path) -> list[dict]:
    records = []
    total = 0
    reader = GitBlobReader(source)
    try:
        with zipfile.ZipFile(stage / "project.zip", "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for path, object_id in entries:
                content = reader.read(object_id)
                total += len(content)
                if total > MAX_TOTAL_BYTES:
                    raise ValueError("Public library exceeds the client unpacked-size limit")
                target = stage / "files" / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
                records.append({"path": path, "size": len(content), "sha256": sha256(content)})
    except BaseException:
        reader.close(abort=True)
        raise
    else:
        reader.close()
    if (stage / "project.zip").stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Public ZIP exceeds the client compressed-size limit")
    return records


def validate_existing_release(existing: Path, stage: Path, expected: dict) -> dict:
    if existing.is_symlink() or not existing.is_dir():
        raise ValueError("Existing immutable release is not a regular directory")
    metadata_path = existing / "release.json"
    if metadata_path.is_symlink():
        raise ValueError("Existing immutable release metadata cannot be a symlink")
    try:
        previous = json.loads(metadata_path.read_bytes())
    except (OSError, ValueError) as error:
        raise ValueError("Existing immutable release metadata is missing or invalid") from error
    comparable = {key: value for key, value in previous.items() if key != "published_at"}
    if comparable != {key: value for key, value in expected.items() if key != "published_at"}:
        raise ValueError("Refusing to change an immutable release; choose a new version")
    wanted = {str(path.relative_to(stage)) for path in stage.rglob("*") if path.is_file()}
    actual = set()
    for path in existing.rglob("*"):
        if path.is_symlink():
            raise ValueError("Existing immutable release contains a symlink")
        if path.is_file() and path != metadata_path:
            actual.add(str(path.relative_to(existing)))
    if actual != wanted:
        raise ValueError("Existing immutable release has a different file set")
    for relative in wanted:
        if file_hash(existing / relative) != file_hash(stage / relative):
            raise ValueError(f"Existing immutable release content differs: {relative}")
    return previous


def atomic_json(path: Path, value: dict):
    descriptor, temporary = tempfile.mkstemp(prefix=".latest-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as file:
            os.fchmod(file.fileno(), 0o644)
            file.write(json_bytes(value))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def make_public_readable(directory: Path):
    directory.chmod(0o755)
    for path in directory.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)


def build_snapshot(source: Path, output: Path, base_url: str, revision: str = "HEAD", version: str | None = None) -> dict:
    source = source.resolve()
    base_url = validate_base_url(base_url)
    if version is not None and not VERSION_RE.fullmatch(version):
        raise ValueError("--version must be a portable single path component")
    commit, entries = committed_entries(source, revision)
    output.mkdir(parents=True, exist_ok=True)
    releases = output / "releases"
    if releases.is_symlink():
        raise ValueError("The releases directory cannot be a symlink")
    releases.mkdir(exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".snapshot-", dir=output))
    try:
        records = write_content(source, entries, stage)
        content_digest = sha256(json_bytes(records))
        version = version or f"r-{commit[:12]}-{content_digest[:12]}"
        release_url = f"{base_url}/{version}"
        files = [{**record, "url": f"{release_url}/files/{quote(record['path'], safe='/')}"} for record in records]
        manifest = {"schema_version": 1, "version": version, "files": files}
        manifest_bytes = json_bytes(manifest)
        (stage / "manifest.json").write_bytes(manifest_bytes)
        archive = stage / "project.zip"
        latest = {
            "schema_version": 1, "version": version, "source_revision": commit,
            "published_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "manifest_url": f"{release_url}/manifest.json", "manifest_sha256": sha256(manifest_bytes),
            "archive_url": f"{release_url}/project.zip", "archive_sha256": file_hash(archive),
            "archive_size": archive.stat().st_size, "file_count": len(files),
        }
        destination = releases / version
        if destination.exists() or destination.is_symlink():
            latest = validate_existing_release(destination, stage, latest)
            make_public_readable(destination)
        else:
            (stage / "release.json").write_bytes(json_bytes(latest))
            make_public_readable(stage)
            try:
                os.rename(stage, destination)
            except FileExistsError:
                (stage / "release.json").unlink()
                latest = validate_existing_release(destination, stage, latest)
                make_public_readable(destination)
        atomic_json(output / "latest.json", latest)
        return latest
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--base-url", required=True, help="HTTPS URL of the public releases directory")
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--version", help="Optional immutable version override")
    args = parser.parse_args()
    try:
        result = build_snapshot(args.source_root, args.output_dir, args.base_url, args.revision, args.version)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Snapshot build failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
