from __future__ import annotations

import fnmatch
from dataclasses import asdict, dataclass
from typing import Iterable

from .findings import SEVERITY_WEIGHT, Finding
from .waivers import Waiver


PROFILE_THRESHOLDS = {
    "relaxed": 70,
    "standard": 80,
    "strict": 90,
}


@dataclass
class PolicyResult:
    status: str
    exit_code: int
    score: float
    threshold: int
    reasons: list[str]
    counts: dict[str, int]
    tool_errors: list[str]

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        data["score"] = round(self.score, 2)
        return data


def resolve_threshold(profile: str, threshold: int | None) -> int:
    if threshold is not None:
        return threshold
    return PROFILE_THRESHOLDS.get(profile, PROFILE_THRESHOLDS["standard"])


def _allow_by_path(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern.replace("\\", "/")) for pattern in patterns)


def apply_allowances(
    findings: list[Finding],
    *,
    allow_pii: bool,
    allow_secrets: bool,
    allow_rules: list[str],
    allow_paths: list[str],
    waivers: list[Waiver],
    waiver_reason: str | None,
    waiver_expires: str | None,
) -> None:
    for finding in findings:
        if finding.category == "pii" and allow_pii:
            finding.allowed = True
            finding.allowed_reason = waiver_reason or "Allowed by --allow-pii"
        elif finding.category == "secrets" and allow_secrets:
            finding.allowed = True
            finding.allowed_reason = waiver_reason or "Allowed by --allow-secrets"
        elif finding.rule in allow_rules:
            finding.allowed = True
            finding.allowed_reason = waiver_reason or "Allowed by --allow-rule"
        elif finding.path and _allow_by_path(finding.path, allow_paths):
            finding.allowed = True
            finding.allowed_reason = waiver_reason or "Allowed by --allow-path"

        if not finding.allowed:
            for waiver in waivers:
                if waiver.matches(finding):
                    finding.allowed = True
                    finding.allowed_reason = waiver.reason or "Allowed by waiver file"
                    if waiver.expires:
                        finding.metadata["waiverExpires"] = waiver.expires
                    break

        if finding.allowed and waiver_expires:
            finding.metadata.setdefault("waiverExpires", waiver_expires)


def evaluate_policy(
    findings: list[Finding],
    tool_results: list[object],
    *,
    profile: str,
    threshold: int | None,
    mode: str,
    fail_on_tool_error: bool,
) -> PolicyResult:
    resolved_threshold = resolve_threshold(profile, threshold)
    active = [finding for finding in findings if not finding.allowed]
    allowed = [finding for finding in findings if finding.allowed]

    score = 100.0
    for finding in active:
        score -= SEVERITY_WEIGHT.get(finding.severity, 6.0)
    score = max(0.0, score)

    severity_counts = {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0}
    category_counts: dict[str, int] = {}
    for finding in active:
        severity_counts[finding.severity] = severity_counts.get(finding.severity, 0) + 1
        category_counts[finding.category] = category_counts.get(finding.category, 0) + 1

    tool_errors = [
        getattr(result, "name", "unknown")
        for result in tool_results
        if getattr(result, "status", "") in {"missing", "error", "timeout"}
    ]
    coverage_errors = [
        getattr(result, "name", "coverage")
        for result in tool_results
        if getattr(result, "name", "") == "coverage" and getattr(result, "status", "") in {"missing", "error", "timeout"}
    ]
    required_evidence_errors = [
        getattr(result, "name", "evidence")
        for result in tool_results
        if getattr(result, "status", "") in {"missing", "error", "timeout"}
        and bool((getattr(result, "summary", {}) or {}).get("required"))
    ]

    reasons: list[str] = []
    if coverage_errors:
        reasons.append("Coverage analysis was requested but did not produce sufficient evidence.")
    if required_evidence_errors:
        reasons.append("Required deterministic evidence was missing, invalid, or unavailable.")
    if tool_errors and (mode == "full" or fail_on_tool_error):
        reasons.append("One or more required analysis tools failed or were unavailable.")

    if mode == "full":
        successful_tools = [
            result for result in tool_results if getattr(result, "status", "") in {"ok", "findings", "skipped"}
        ]
        if not successful_tools:
            reasons.append("No external analysis tool produced sufficient evidence.")

    if reasons:
        return PolicyResult(
            status="NEEDS_CHANGES",
            exit_code=2,
            score=score,
            threshold=resolved_threshold,
            reasons=reasons,
            counts={
                "active": len(active),
                "allowed": len(allowed),
                "total": len(findings),
                **{f"severity.{key}": value for key, value in severity_counts.items()},
                **{f"category.{key}": value for key, value in category_counts.items()},
            },
            tool_errors=tool_errors,
        )

    blocking_categories = {
        "architecture-policy",
        "change-policy",
        "contract-policy",
        "coverage",
        "quality-budget",
        "quality-evidence",
        "secrets",
        "test-quality",
    }
    blocking_tools = {"change-policy", "dependency-graph", "quality-budget", "quality-evidence", "test-quality"}
    has_blocking_finding = any(
        finding.category in blocking_categories or finding.tool in blocking_tools
        for finding in active
    )
    has_critical = any(finding.severity == "critical" for finding in active)

    if score < resolved_threshold or has_blocking_finding or has_critical:
        if score < resolved_threshold:
            reasons.append(f"Score {score:.2f} is below threshold {resolved_threshold}.")
        if has_blocking_finding:
            if any(finding.category == "secrets" for finding in active):
                reasons.append("Active secret finding blocks approval.")
            if any(finding.category == "coverage" for finding in active):
                reasons.append("Active coverage finding blocks approval.")
            if any(
                finding.category in blocking_categories - {"coverage", "secrets"}
                or finding.tool in blocking_tools
                for finding in active
            ):
                reasons.append("Active deterministic quality policy finding blocks approval.")
        if has_critical:
            reasons.append("Active critical finding blocks approval.")
        return PolicyResult(
            status="REJECTED",
            exit_code=1,
            score=score,
            threshold=resolved_threshold,
            reasons=reasons,
            counts={
                "active": len(active),
                "allowed": len(allowed),
                "total": len(findings),
                **{f"severity.{key}": value for key, value in severity_counts.items()},
                **{f"category.{key}": value for key, value in category_counts.items()},
            },
            tool_errors=tool_errors,
        )

    return PolicyResult(
        status="APPROVED",
        exit_code=0,
        score=score,
        threshold=resolved_threshold,
        reasons=[],
        counts={
            "active": len(active),
            "allowed": len(allowed),
            "total": len(findings),
            **{f"severity.{key}": value for key, value in severity_counts.items()},
            **{f"category.{key}": value for key, value in category_counts.items()},
        },
        tool_errors=tool_errors,
    )
