from __future__ import annotations

from dataclasses import asdict, dataclass, field
from hashlib import sha256
from typing import Any


SEVERITY_ORDER = {
    "critical": 5,
    "high": 4,
    "medium": 3,
    "low": 2,
    "info": 1,
}

SEVERITY_WEIGHT = {
    "critical": 25.0,
    "high": 15.0,
    "medium": 6.0,
    "low": 2.0,
    "info": 0.5,
}


def normalize_severity(value: str | None) -> str:
    if not value:
        return "medium"
    normalized = value.lower().strip()
    aliases = {
        "error": "high",
        "warning": "medium",
        "warn": "medium",
        "notice": "low",
        "unknown": "medium",
        "moderate": "medium",
    }
    return aliases.get(normalized, normalized if normalized in SEVERITY_ORDER else "medium")


def stable_fingerprint(parts: list[str]) -> str:
    content = "\0".join(parts)
    return sha256(content.encode("utf-8", errors="replace")).hexdigest()[:24]


@dataclass
class Finding:
    tool: str
    rule: str
    severity: str
    category: str
    message: str
    path: str = ""
    line: int | None = None
    column: int | None = None
    fingerprint: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    allowed: bool = False
    allowed_reason: str | None = None

    def __post_init__(self) -> None:
        self.severity = normalize_severity(self.severity)
        self.path = self.path.replace("\\", "/")
        if not self.fingerprint:
            self.fingerprint = stable_fingerprint(
                [
                    self.tool,
                    self.rule,
                    self.severity,
                    self.category,
                    self.path,
                    str(self.line or ""),
                    self.message,
                ]
            )

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["status"] = "allowed" if self.allowed else "active"
        return data

