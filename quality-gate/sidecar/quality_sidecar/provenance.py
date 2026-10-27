from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping


PROVENANCE_FIELDS = ("sourceCommit", "producer", "producerVersion", "generatedAt")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _parse_timestamp(value: str) -> datetime:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError("provenance.generatedAt must include a timezone")
    return parsed.astimezone(timezone.utc)


def validate_provenance(
    provenance: Mapping[str, Any] | None,
    path: Path,
    *,
    required: bool = False,
    expected_source_commit: str | None = None,
    max_age_seconds: int | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Validate artifact provenance without making human-readable fields contractual.

    The artifact digest is always returned. Provenance becomes mandatory when an
    expected commit or maximum age is supplied, even if ``required`` is false.
    """

    expected = (expected_source_commit or "").strip()
    must_verify = required or bool(expected) or max_age_seconds is not None
    summary: dict[str, Any] = {
        "artifactSha256": sha256_file(path),
        "provenanceVerified": False,
    }
    if provenance is None:
        if must_verify:
            raise ValueError("artifact provenance is required")
        return summary
    if not isinstance(provenance, Mapping):
        raise ValueError("provenance must be an object")

    missing = [field for field in PROVENANCE_FIELDS if not str(provenance.get(field) or "").strip()]
    if must_verify and missing:
        raise ValueError(f"provenance is missing required fields: {', '.join(missing)}")

    source_commit = str(provenance.get("sourceCommit") or "").strip()
    if expected and source_commit.casefold() != expected.casefold():
        raise ValueError(
            f"provenance sourceCommit {source_commit or '<missing>'} does not match expected commit {expected}"
        )

    generated_at = str(provenance.get("generatedAt") or "").strip()
    if generated_at:
        generated = _parse_timestamp(generated_at)
        reference = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        age = (reference - generated).total_seconds()
        if age < -300:
            raise ValueError("provenance.generatedAt is more than five minutes in the future")
        if max_age_seconds is not None:
            if max_age_seconds < 0:
                raise ValueError("max evidence age must be non-negative")
            if age > max_age_seconds:
                raise ValueError(
                    f"artifact provenance is stale ({int(age)}s old; maximum {max_age_seconds}s)"
                )

    for field in PROVENANCE_FIELDS:
        value = provenance.get(field)
        if value is not None and str(value).strip():
            summary[field] = str(value).strip()
    summary["provenanceVerified"] = not missing
    return summary


def json_provenance(payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    raw = payload.get("provenance")
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise ValueError("provenance must be an object")
    return raw


def junit_provenance(root: Any) -> Mapping[str, Any] | None:
    aliases = {
        "quality.sourceCommit": "sourceCommit",
        "quality.producer": "producer",
        "quality.producerVersion": "producerVersion",
        "quality.generatedAt": "generatedAt",
        "quality.provenance.sourceCommit": "sourceCommit",
        "quality.provenance.producer": "producer",
        "quality.provenance.producerVersion": "producerVersion",
        "quality.provenance.generatedAt": "generatedAt",
    }
    values: dict[str, str] = {}
    for element in root.iter():
        if str(element.tag).rsplit("}", 1)[-1] != "property":
            continue
        field = aliases.get(str(element.get("name") or ""))
        if field:
            values[field] = str(element.get("value") or element.text or "").strip()
    return values or None
