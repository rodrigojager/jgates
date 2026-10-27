from __future__ import annotations

import json
import html
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .findings import Finding
from .i18n import normalize_locale, translate
from .policy import PolicyResult
from .tools import ToolResult


ABSOLUTE_WINDOWS_PATH = re.compile(r"^[A-Za-z]:[\\/]")


def _public_path(value: str | None, target: Path) -> str | None:
    if not value:
        return value
    normalized = str(value).replace("\\", "/")
    if normalized.startswith("/") or ABSOLUTE_WINDOWS_PATH.match(str(value)):
        try:
            relative = Path(value).resolve().relative_to(target.resolve())
            return "." if not relative.parts else relative.as_posix()
        except (OSError, ValueError):
            return normalized.rstrip("/").rsplit("/", 1)[-1]
    return normalized


def _public_argument(value: str, target: Path) -> str:
    if "=" in value and value.startswith("--"):
        name, raw = value.split("=", 1)
        sanitized = _public_path(raw, target)
        return f"{name}={sanitized}"
    return str(_public_path(value, target))


def _public_value(value: Any, target: Path) -> Any:
    if isinstance(value, dict):
        return {key: _public_value(item, target) for key, item in value.items()}
    if isinstance(value, list):
        return [_public_value(item, target) for item in value]
    if isinstance(value, str) and (value.startswith("/") or ABSOLUTE_WINDOWS_PATH.match(value)):
        return _public_path(value, target)
    return value


def _public_tool_result(result: ToolResult, target: Path) -> dict[str, Any]:
    data = result.to_dict()
    command = data.get("command") or []
    if command:
        data["command"] = [Path(str(command[0])).name, *[_public_argument(str(item), target) for item in command[1:]]]
    for key in ("output_path", "stdout_path", "stderr_path"):
        data[key] = _public_path(data.get(key), target)
    if data.get("error"):
        # Detailed stderr remains in the raw evidence artifact. The normalized
        # report exposes the outcome without leaking runner paths or internals.
        data["error"] = "Analyzer reported an operational error."
    data["summary"] = _public_value(data.get("summary") or {}, target)
    return data


def _markdown_cell(value: Any) -> str:
    text = str(value if value is not None else "").replace("\r", " ").replace("\n", " ")
    text = html.escape(text, quote=True)
    for character in ("\\", "|", "`", "*", "_", "[", "]"):
        text = text.replace(character, f"\\{character}")
    return text


def build_report(
    *,
    target: Path,
    profile: str,
    mode: str,
    policy: PolicyResult,
    stack: dict[str, Any],
    findings: list[Finding],
    tool_results: list[ToolResult],
    metrics: dict[str, Any],
    locale: str = "en",
) -> dict[str, Any]:
    report = {
        "schemaVersion": "1.0.0",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "target": ".",
        "status": policy.status,
        "exitCode": policy.exit_code,
        "profile": profile,
        "mode": mode,
        "locale": normalize_locale(locale),
        "score": {
            "value": round(policy.score, 2),
            "threshold": policy.threshold,
            "max": 100,
        },
        "summary": {
            "counts": policy.counts,
            "reasons": policy.reasons,
            "toolErrors": policy.tool_errors,
        },
        "stack": stack,
        "metrics": _public_value(metrics, target),
        "tools": [_public_tool_result(result, target) for result in tool_results],
        "findings": [_public_value(finding.to_dict(), target) for finding in findings],
    }
    return report


def write_json_report(report: dict[str, Any], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "quality-report.json"
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def write_markdown_report(report: dict[str, Any], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "quality-report.md"
    locale = normalize_locale(str(report.get("locale") or "en"))

    def t(key: str) -> str:
        return translate(locale, key)

    lines = [
        f"# {t('report_title')}",
        "",
        f"{t('status')}: **{report['status']}**",
        f"{t('score')}: **{report['score']['value']} / 100**",
        f"{t('threshold')}: **{report['score']['threshold']}**",
        f"{t('mode')}: `{report['mode']}`",
        f"{t('profile')}: `{report['profile']}`",
        "",
    ]
    lines.extend([f"## {t('reasons')}", ""])
    reasons = report["summary"].get("reasons") or []
    if reasons:
        lines.extend(f"- {_markdown_cell(reason)}" for reason in reasons)
    else:
        lines.append(f"- {t('no_reason')}")

    lines.extend(["", f"## {t('tools')}", ""])
    tools = report.get("tools") or []
    if tools:
        lines.append("| Tool | Status | Exit | Findings |")
        lines.append("| --- | --- | ---: | ---: |")
        for tool in tools:
            findings = (tool.get("summary") or {}).get("findings", 0)
            exit_code = tool.get("exit_code")
            lines.append(
                f"| {_markdown_cell(tool.get('name'))} | {_markdown_cell(tool.get('status'))} | "
                f"{_markdown_cell(exit_code if exit_code is not None else '')} | {_markdown_cell(findings)} |"
            )
    else:
        lines.append(f"- {t('no_tools')}")

    metrics = report.get("metrics") or {}
    totals = metrics.get("totals") or {}
    change = metrics.get("change") or {}
    lines.extend(["", f"## {t('metrics')}", ""])
    lines.append(f"- Files: {totals.get('files', 0)}")
    lines.append(f"- Bytes: {totals.get('bytes', 0)}")
    lines.append(f"- Text lines: {totals.get('lines', 0)}")
    lines.append(f"- Changed files: {change.get('files', 0)}")
    lines.append(f"- Changed lines: {change.get('changedLines', 0)}")
    lines.append(f"- Diff bytes: {change.get('patchBytes', 0)}")

    lines.extend(["", f"## {t('findings')}", ""])
    findings = report.get("findings") or []
    if findings:
        lines.append("| Status | Severity | Category | Rule | Path | Message |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for finding in findings[:200]:
            location = finding.get("path") or ""
            if finding.get("line"):
                location = f"{location}:{finding['line']}"
            message = _markdown_cell(finding.get("message", ""))
            lines.append(
                f"| {_markdown_cell(finding.get('status'))} | {_markdown_cell(finding.get('severity'))} | "
                f"{_markdown_cell(finding.get('category'))} | {_markdown_cell(finding.get('rule'))} | "
                f"{_markdown_cell(location)} | {message} |"
            )
        if len(findings) > 200:
            lines.append(f"\nOnly first 200 findings shown. Full list is in quality-report.json.")
    else:
        lines.append(f"- {t('no_findings')}")

    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
    return path
