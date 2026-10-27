from __future__ import annotations

import fnmatch
import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any


@dataclass
class Waiver:
    rule: str | None = None
    fingerprint: str | None = None
    path: str | None = None
    reason: str | None = None
    expires: str | None = None

    @property
    def expired(self) -> bool:
        if not self.expires:
            return False
        try:
            return date.fromisoformat(self.expires) < date.today()
        except ValueError:
            return True

    def matches(self, finding: Any) -> bool:
        if self.expired:
            return False
        if self.fingerprint and self.fingerprint == finding.fingerprint:
            return True
        if self.rule and self.rule == finding.rule:
            if not self.path:
                return True
            return fnmatch.fnmatch(finding.path, self.path)
        if self.path and fnmatch.fnmatch(finding.path, self.path):
            return True
        return False


def _load_payload(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        waivers = payload.get("waivers", [])
        if isinstance(waivers, list):
            return waivers
    raise ValueError(f"Waiver file must contain a list or a waivers object: {path}")


def load_waivers(paths: list[str], root: Path) -> list[Waiver]:
    loaded: list[Waiver] = []
    for item in paths:
        path = Path(item)
        if not path.is_absolute():
            path = root / path
        for raw in _load_payload(path):
            loaded.append(
                Waiver(
                    rule=raw.get("rule"),
                    fingerprint=raw.get("fingerprint") or raw.get("id"),
                    path=raw.get("path"),
                    reason=raw.get("reason"),
                    expires=raw.get("expires") or raw.get("expiresAt"),
                )
            )
    return loaded

