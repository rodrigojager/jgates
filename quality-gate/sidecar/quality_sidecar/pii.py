"""Built-in PII detector, one rule per entity (cpf, cnpj, credit-card, phone).

The PII contract keeps four operations apart, and this module only implements the first three:

- A) not detecting: an entity with ``enabled: false`` never runs; ``coverage()`` records the exclusion.
- B) detecting without blocking: a match becomes a ``Finding``; what it costs is the policy's call (severity,
  ``--allow-pii``, waivers), never this module's.
- C) masking evidence: the matched value is captured only to build its masked form (``PiiMatch.masked``); no
  finding, report, log or JSON carries it raw. ``redact_text``/``redact_findings`` mask PII-shaped text in the
  output of any detector, and they run whether or not an entity is enabled (switching a detector off never switches masking off).
- D) correcting content is not offered: ``remediation.mode`` only accepts ``none``, and nothing here writes files.

The default configuration reproduces the detector as it was before the per-entity contract: cpf, cnpj and
credit-card on, with the same regexes, severities and messages, and one finding per line and entity; phone (new) is
off; check-digit and Luhn validation are off. Validation, when on, drops a line's finding unless at least one match
on that line passes the check.

Known limits (documented, not hidden): the regexes are format heuristics, not full coverage of the entities. The
legacy credit-card regex also matches any 13 to 19 digits split by spaces or hyphens (dates with ids, phone numbers
with the country code); validation narrows that down. CNPJ is the numeric format only (the alphanumeric CNPJ is a
future recognizer). Phone is the pt-BR format and needs some punctuation (parentheses, ``+55``, a space or a hyphen):
a bare 10 or 11 digit run is ambiguous with a CPF or an id and is not reported as a phone.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping

from .findings import Finding

SCHEMA_VERSION = 1
ENTITIES = ("cpf", "cnpj", "credit-card", "phone")
# Entities the detector reported before the per-entity contract: on by default so results do not change.
LEGACY_ENTITIES = ("cpf", "cnpj", "credit-card")
SEVERITIES = ("low", "medium", "high", "critical")
LOCALES = ("pt-BR",)
REMEDIATION_MODES = ("none",)
DEFAULT_ENABLED = {"cpf": True, "cnpj": True, "credit-card": True, "phone": False}
DEFAULT_SEVERITY = {"cpf": "medium", "cnpj": "medium", "credit-card": "high", "phone": "medium"}
# Format versions of the recognizers, so a change of format is a visible change of version.
FORMAT_VERSIONS = {"cpf": "br-cpf-1", "cnpj": "br-cnpj-numeric-1", "credit-card": "pan-13-19-1", "phone": "br-phone-1"}
MASK_CHAR = "*"

PATTERNS: dict[str, re.Pattern[str]] = {
    # The first three are the legacy regexes, byte for byte.
    "cpf": re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b"),
    "cnpj": re.compile(r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b"),
    "credit-card": re.compile(r"\b(?:\d[ -]*?){13,19}\b"),
    # pt-BR phone: optional +55, area code (no zero digit), 9xxxx-xxxx (mobile) or [2-5]xxx-xxxx (landline).
    "phone": re.compile(
        r"(?<![\w+.\-/])"
        r"(?:\+55[ \-]?)?"
        r"(?:\([1-9][1-9]\)|[1-9][1-9])"
        r"[ \-]?"
        r"(?:9\d{4}|[2-5]\d{3})"
        r"[ \-]?"
        r"\d{4}"
        r"(?![\w\-/]|\.\d)"
    ),
}

_CPF_W1 = (10, 9, 8, 7, 6, 5, 4, 3, 2)
_CPF_W2 = (11, 10, 9, 8, 7, 6, 5, 4, 3, 2)
_CNPJ_W1 = (5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)
_CNPJ_W2 = (6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)


class PiiConfigError(ValueError):
    """A configuration the detector cannot honor. ``code`` is ``invalid-config`` or ``unsupported-option``."""

    def __init__(self, code: str, path: str, message: str) -> None:
        super().__init__(f"{path}: {message}")
        self.code = code
        self.path = path
        self.message = message

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "path": self.path, "message": self.message}


@dataclass(frozen=True)
class EntitySettings:
    enabled: bool
    severity: str


@dataclass(frozen=True)
class PiiConfig:
    entities: Mapping[str, EntitySettings] = field(default_factory=lambda: {
        name: EntitySettings(DEFAULT_ENABLED[name], DEFAULT_SEVERITY[name]) for name in ENTITIES
    })
    locale: str = "pt-BR"
    validate_check_digits: bool = False
    redact_matched_values: bool = True
    remediation_mode: str = "none"

    def __post_init__(self) -> None:
        unknown = sorted(set(self.entities) - set(ENTITIES))
        if unknown:
            raise PiiConfigError("invalid-config", f"/entities/{unknown[0]}", "unknown entity")
        complete = {
            name: self.entities.get(name) or EntitySettings(DEFAULT_ENABLED[name], DEFAULT_SEVERITY[name])
            for name in ENTITIES
        }
        for name, settings in complete.items():
            _require_bool(settings.enabled, f"/entities/{name}/enabled")
            _require_severity(settings.severity, f"/entities/{name}/severity")
        object.__setattr__(self, "entities", complete)
        if self.locale not in LOCALES:
            raise PiiConfigError("unsupported-option", "/detection/locale",
                                 f"the built-in detector supports only {', '.join(LOCALES)}")
        if self.redact_matched_values is not True:
            raise PiiConfigError("unsupported-option", "/reporting/redactMatchedValues",
                                 "the built-in detector never reports raw matched values")
        if self.remediation_mode not in REMEDIATION_MODES:
            raise PiiConfigError("unsupported-option", "/remediation/mode",
                                 "the built-in detector only observes; content correction is not available")

    def entity(self, name: str) -> EntitySettings:
        return self.entities[name]

    def enabled_entities(self) -> tuple[str, ...]:
        return tuple(name for name in ENTITIES if self.entities[name].enabled)

    def to_dict(self) -> dict[str, Any]:
        """The effective configuration in the ``.jgates/pii.yml`` shape (camelCase)."""
        return {
            "schemaVersion": SCHEMA_VERSION,
            "entities": {
                name: {"enabled": self.entities[name].enabled, "severity": self.entities[name].severity}
                for name in ENTITIES
            },
            "detection": {"locale": self.locale, "validateCheckDigits": self.validate_check_digits},
            "reporting": {"redactMatchedValues": self.redact_matched_values},
            "remediation": {"mode": self.remediation_mode},
        }


@dataclass(frozen=True)
class PiiMatch:
    """One match. It never holds the raw value: only where it is and its masked form."""

    entity: str
    line: int
    column: int
    length: int
    masked: str
    valid: bool | None  # check-digit/Luhn verdict; None when the entity has no check (phone)


def default_config() -> PiiConfig:
    return PiiConfig()


def _require_bool(value: Any, path: str) -> bool:
    if not isinstance(value, bool):
        raise PiiConfigError("invalid-config", path, "must be true or false")
    return value


def _require_severity(value: Any, path: str) -> str:
    if value not in SEVERITIES:
        raise PiiConfigError("invalid-config", path, f"must be one of {', '.join(SEVERITIES)}")
    return value


def _require_object(value: Any, path: str, keys: Iterable[str]) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PiiConfigError("invalid-config", path or "/", "must be an object")
    unknown = sorted(set(value) - set(keys))
    if unknown:
        raise PiiConfigError("invalid-config", f"{path}/{unknown[0]}", "unknown option")
    return value


def config_from_dict(data: Mapping[str, Any] | None) -> PiiConfig:
    """Build a configuration from the ``.jgates/pii.yml`` document (or ``None`` for the defaults).

    Missing keys inherit the defaults; unknown keys, ``null`` values and options the detector does not support are
    refused with ``PiiConfigError`` (never dropped in silence). ``enabled: false`` at the top turns every entity off
    (masking stays on); a top-level ``severity`` applies to the entities that do not set their own.
    """
    if data is None:
        return default_config()
    doc = _require_object(data, "", ("schemaVersion", "enabled", "severity", "entities", "detection", "reporting",
                                     "remediation"))
    if "schemaVersion" in doc and doc["schemaVersion"] != SCHEMA_VERSION:
        raise PiiConfigError("invalid-config", "/schemaVersion", f"must be {SCHEMA_VERSION}")
    detector_on = _require_bool(doc["enabled"], "/enabled") if "enabled" in doc else True
    base_severity = _require_severity(doc["severity"], "/severity") if "severity" in doc else None

    entities_doc = _require_object(doc.get("entities", {}), "/entities", ENTITIES)
    entities: dict[str, EntitySettings] = {}
    for name in ENTITIES:
        raw = _require_object(entities_doc.get(name, {}), f"/entities/{name}", ("enabled", "severity"))
        enabled = _require_bool(raw["enabled"], f"/entities/{name}/enabled") if "enabled" in raw else DEFAULT_ENABLED[name]
        if "severity" in raw:
            severity = _require_severity(raw["severity"], f"/entities/{name}/severity")
        else:
            severity = base_severity or DEFAULT_SEVERITY[name]
        entities[name] = EntitySettings(enabled and detector_on, severity)

    detection = _require_object(doc.get("detection", {}), "/detection", ("locale", "validateCheckDigits"))
    validate = (_require_bool(detection["validateCheckDigits"], "/detection/validateCheckDigits")
                if "validateCheckDigits" in detection else False)
    reporting = _require_object(doc.get("reporting", {}), "/reporting", ("redactMatchedValues",))
    redact = (_require_bool(reporting["redactMatchedValues"], "/reporting/redactMatchedValues")
              if "redactMatchedValues" in reporting else True)
    remediation = _require_object(doc.get("remediation", {}), "/remediation", ("mode",))

    # PiiConfig refuses the options the detector cannot honor (other locales, raw values, remediation).
    return PiiConfig(entities=entities, locale=detection.get("locale", "pt-BR"), validate_check_digits=validate,
                     redact_matched_values=redact, remediation_mode=remediation.get("mode", "none"))


def config_from_request(entities: Iterable[str] | None = None, severity: str | None = None, *,
                        validate_check_digits: bool = False) -> PiiConfig:
    """Configuration for the bridge's ``pii`` operation: the listed entities on (the legacy ones when ``None``),
    every other entity off, and ``severity`` (when given) overriding all of them."""
    names = list(LEGACY_ENTITIES if entities is None else entities)
    for index, name in enumerate(names):
        if name not in ENTITIES:
            raise PiiConfigError("invalid-config", f"/entities/{index}", f"must be one of {', '.join(ENTITIES)}")
    if severity is not None:
        _require_severity(severity, "/severity")
    return PiiConfig(
        entities={name: EntitySettings(name in names, severity or DEFAULT_SEVERITY[name]) for name in ENTITIES},
        validate_check_digits=_require_bool(validate_check_digits, "/validateCheckDigits"),
    )


def coverage(config: PiiConfig) -> list[dict[str, Any]]:
    """One row per entity: whether it runs (A is visible, never an invisible exclusion)."""
    rows = []
    for name in ENTITIES:
        settings = config.entities[name]
        rows.append({
            "entity": name,
            "rule": f"pii.{name}",
            "supported": True,
            "enabled": settings.enabled,
            "status": "run" if settings.enabled else "disabled",
            "severity": settings.severity,
            "format": FORMAT_VERSIONS[name],
            "validation": ("off" if not config.validate_check_digits
                           else "none" if name == "phone" else "luhn" if name == "credit-card" else "check-digits"),
        })
    return rows


# --- validation ---------------------------------------------------------------------------------------------------

def _digits(value: str) -> list[int]:
    return [int(char) for char in value if char.isdigit()]


def _mod11(digits: list[int], weights: tuple[int, ...]) -> int:
    rest = sum(d * w for d, w in zip(digits, weights)) % 11
    return 0 if rest < 2 else 11 - rest


def is_valid_cpf(value: str) -> bool:
    d = _digits(value)
    if len(d) != 11 or len(set(d)) == 1:
        return False
    return _mod11(d[:9], _CPF_W1) == d[9] and _mod11(d[:10], _CPF_W2) == d[10]


def is_valid_cnpj(value: str) -> bool:
    d = _digits(value)
    if len(d) != 14 or len(set(d)) == 1:
        return False
    return _mod11(d[:12], _CNPJ_W1) == d[12] and _mod11(d[:13], _CNPJ_W2) == d[13]


def _luhn(digits: list[int]) -> bool:
    total = 0
    for index, digit in enumerate(reversed(digits)):
        if index % 2:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


def is_valid_card(value: str) -> bool:
    """Luhn over 13 to 19 digits, refusing a single repeated digit (sixteen zeros pass the arithmetic)."""
    digits = _digits(value)
    return 13 <= len(digits) <= 19 and len(set(digits)) > 1 and _luhn(digits)


def _is_phone_shaped(value: str) -> bool:
    return any(char in value for char in "()+ -")


_VALIDATORS = {"cpf": is_valid_cpf, "cnpj": is_valid_cnpj, "credit-card": is_valid_card}


def _candidates(name: str, text: str) -> Iterator[re.Match[str]]:
    """Overlapping matches of one entity. A card-shaped span may swallow the start of the next value
    (``…/0001-81 4111 …``), so the scan restarts one character after each match start instead of at its end."""
    pattern = PATTERNS[name]
    position = 0
    while (match := pattern.search(text, position)) is not None:
        if name != "phone" or _is_phone_shaped(match.group(0)):
            yield match
        position = match.start() + 1


# --- masking ------------------------------------------------------------------------------------------------------

def mask_value(value: str) -> str:
    """Every digit becomes ``*``; separators stay, so the shape is visible and the value is not."""
    return re.sub(r"\d", MASK_CHAR, value)


def redact_text(text: str) -> str:
    """Mask every PII-shaped span of any supported entity, enabled or not, with no validation (masking errs wide)."""
    if not text or not any(char.isdigit() for char in text):
        return text
    spans = [match.span() for name in ENTITIES for match in _candidates(name, text)]
    if not spans:
        return text
    chars = list(text)
    for start, end in spans:
        for index in range(start, end):
            if chars[index].isdigit():
                chars[index] = MASK_CHAR
    return "".join(chars)


def _redact_value(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _redact_value(item) for key, item in value.items()}
    return value


def redact_finding(finding: Finding, *, metadata: bool = False) -> Finding:
    """Mask PII-shaped text in the finding's message (and metadata when asked), in place. Paths, rules and the
    fingerprint stay as they are, so waivers and locations keep working."""
    finding.message = redact_text(finding.message)
    if metadata and finding.metadata:
        finding.metadata = _redact_value(finding.metadata)
    return finding


def redact_findings(findings: Iterable[Finding], *, metadata: bool = False) -> list[Finding]:
    return [redact_finding(item, metadata=metadata) for item in findings]


# --- detection ----------------------------------------------------------------------------------------------------

def scan_line(line: str, config: PiiConfig | None = None, *, line_number: int = 1) -> list[PiiMatch]:
    """Every match of the enabled entities on one line, in entity order, with the validation verdict."""
    config = config or default_config()
    matches: list[PiiMatch] = []
    for name in config.enabled_entities():
        validator = _VALIDATORS.get(name)
        kept: list[tuple[int, int]] = []  # spans of this entity that were not refused by validation
        for match in _candidates(name, line):
            value = match.group(0)
            start, end = match.span()
            if any(s <= start < e for s, e in kept):
                continue  # starts inside a value already reported: its tail, not a new value
            valid = validator(value) if validator else None
            if valid is not False:
                kept.append((start, end))
            matches.append(PiiMatch(
                entity=name,
                line=line_number,
                column=match.start() + 1,
                length=len(value),
                masked=mask_value(value),
                valid=valid,
            ))
    return matches


def scan_text(text: str, config: PiiConfig | None = None) -> list[PiiMatch]:
    config = config or default_config()
    out: list[PiiMatch] = []
    for number, line in enumerate(text.splitlines(), start=1):
        out.extend(scan_line(line, config, line_number=number))
    return out


def _line_has(name: str, line: str, config: PiiConfig) -> bool:
    # Without validation the first candidate is enough (the legacy ``pattern.search(line)``); with it, any candidate
    # that passes, including one that starts inside a longer, invalid card-shaped span.
    validator = _VALIDATORS.get(name) if config.validate_check_digits else None
    return any(validator is None or validator(match.group(0)) for match in _candidates(name, line))


def pii_message(name: str) -> str:
    return f"Possible {name.upper()} personal data detected."


def line_findings(path: str, line_number: int, line: str, config: PiiConfig | None = None) -> list[Finding]:
    """The findings of one line: at most one per enabled entity, with a fixed message and no matched text."""
    config = config or default_config()
    findings = []
    for name in config.enabled_entities():
        if _line_has(name, line, config):
            findings.append(Finding(
                tool="builtin",
                rule=f"pii.{name}",
                severity=config.entities[name].severity,
                category="pii",
                path=path,
                line=line_number,
                message=pii_message(name),
            ))
    return findings


def detect_pii(root: Path, config: PiiConfig | None = None) -> list[Finding]:
    """Run the PII detector alone over ``root`` (read-only). Entry point for the bridge's ``pii`` operation."""
    from .detectors import detect_builtin_findings  # local import: detectors imports this module

    return detect_builtin_findings(Path(root), include_pii=True, include_secrets=False, pii_config=config)
