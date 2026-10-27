"""Restricted TOML edit helper for the JGates core.

Run as ``python -m quality_sidecar.toml_edit``: one JSON request on stdin, one JSON response on stdout.
The helper receives the document *text* (it never reads workspace files and never imports workspace code) and edits
it with tomlkit, which keeps comments, ordering, arrays of tables, quoted keys and dotted keys.

Request (schemaVersion 1)::

    {"schemaVersion": 1, "operation": "read" | "apply" | "validate", "text": "<toml>",
     "section": ["tool", "ruff"],                      # optional key path of the section (default: the root)
     "intents": [{"path": ["line-length"], "op": "set", "value": 100}, {"path": ["x"], "op": "delete"}]}

``path`` is relative to ``section``. Response::

    {"schemaVersion": 1, "ok": true, "operation": "...", "version": "<tomlkit>", "text": "...", "changed": bool,
     "exists": bool, "fields": {...}}
    {"schemaVersion": 1, "ok": false, "error": {"code": "...", "message": "...", "line": n, "column": n}}
"""

from __future__ import annotations

import json
import sys
from typing import Any

SCHEMA_VERSION = 1
OPERATIONS = ("read", "apply", "validate")
MAX_TEXT_BYTES = 4 * 1024 * 1024
MAX_INTENTS = 1000
ALLOWED_REQUEST_KEYS = {"schemaVersion", "operation", "text", "section", "intents"}


class HelperError(Exception):
    def __init__(self, code: str, message: str, line: int | None = None, column: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.line = line
        self.column = column

    def payload(self) -> dict[str, Any]:
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.line is not None:
            error["line"] = self.line
        if self.column is not None:
            error["column"] = self.column
        return {"schemaVersion": SCHEMA_VERSION, "ok": False, "error": error}


def _tomlkit():
    try:
        import tomlkit  # noqa: PLC0415
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise HelperError("TOMLKIT_MISSING", "tomlkit is not installed for the sidecar Python") from exc
    return tomlkit


def _version() -> str:
    tomlkit = _tomlkit()
    return str(getattr(tomlkit, "__version__", "unknown"))


def _is_key_path(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(k, (str, int)) and not isinstance(k, bool) for k in value)


def _check_request(request: Any) -> None:
    if not isinstance(request, dict):
        raise HelperError("BAD_REQUEST", "the request must be a JSON object")
    unknown = sorted(set(request) - ALLOWED_REQUEST_KEYS)
    if unknown:
        raise HelperError("BAD_REQUEST", f"request keys outside the protocol: {', '.join(unknown)}")
    if request.get("schemaVersion") != SCHEMA_VERSION:
        raise HelperError("BAD_REQUEST", f"schemaVersion must be {SCHEMA_VERSION}")
    if request.get("operation") not in OPERATIONS:
        raise HelperError("BAD_REQUEST", f"operation must be one of {', '.join(OPERATIONS)}")
    text = request.get("text")
    if not isinstance(text, str):
        raise HelperError("BAD_REQUEST", "text must be a string with the document content (file paths are not accepted)")
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HelperError("TOO_LARGE", f"text is larger than {MAX_TEXT_BYTES} bytes")
    section = request.get("section", [])
    if not _is_key_path(section) or any(not isinstance(k, str) for k in section):
        raise HelperError("BAD_REQUEST", "section must be a list of string keys")
    intents = request.get("intents", [])
    if not isinstance(intents, list) or len(intents) > MAX_INTENTS:
        raise HelperError("BAD_REQUEST", "intents must be a list")
    if request["operation"] != "apply" and intents:
        raise HelperError("BAD_REQUEST", "intents are only accepted by the apply operation")
    for index, intent in enumerate(intents):
        if not isinstance(intent, dict) or set(intent) - {"path", "op", "value"}:
            raise HelperError("BAD_INTENT", f"intent {index} must be {{path, op, value}}")
        if not _is_key_path(intent.get("path")) or not intent["path"]:
            raise HelperError("BAD_INTENT", f"intent {index}: path must be a non-empty list of keys")
        if intent.get("op") not in ("set", "delete"):
            raise HelperError("BAD_INTENT", f"intent {index}: op must be set or delete")
        if intent["op"] == "set" and "value" not in intent:
            raise HelperError("BAD_INTENT", f"intent {index}: set needs a value")


def _parse(text: str):
    tomlkit = _tomlkit()
    try:
        return tomlkit.parse(text)
    except Exception as exc:  # tomlkit.exceptions.ParseError and friends
        raise HelperError(
            "TOML_SYNTAX",
            str(exc),
            getattr(exc, "line", None),
            getattr(exc, "col", None),
        ) from exc


def _unwrap(node: Any) -> Any:
    unwrap = getattr(node, "unwrap", None)
    return unwrap() if callable(unwrap) else node


def _walk(container: Any, path: list[Any], create: bool):
    """Returns the node at ``path`` inside ``container`` (creating tables when ``create``), or None when absent."""
    tomlkit = _tomlkit()
    node = container
    for key in path:
        try:
            child = node[key]
        except (KeyError, IndexError, TypeError):
            if not create or not isinstance(key, str) or not hasattr(node, "add"):
                return None
            node[key] = tomlkit.table()
            child = node[key]
        node = child
    return node


def _apply_intent(root: Any, section: list[str], intent: dict[str, Any]) -> None:
    tomlkit = _tomlkit()
    path = list(section) + list(intent["path"])
    parent = _walk(root, path[:-1], create=intent["op"] == "set")
    key = path[-1]
    if intent["op"] == "delete":
        if parent is None:
            return
        try:
            del parent[key]
        except (KeyError, IndexError):
            return
        return
    if parent is None or not hasattr(parent, "__setitem__") or isinstance(parent, (str, int, float, bool)):
        raise HelperError("BAD_INTENT", f"cannot set {'.'.join(map(str, path))}: the parent is not a table or array")
    value = intent["value"]
    try:
        if isinstance(key, str) and key not in parent:
            parent[key] = tomlkit.item(value)
        else:
            parent[key] = value
    except Exception as exc:
        raise HelperError("BAD_INTENT", f"cannot set {'.'.join(map(str, path))}: {exc}") from exc


def handle(request: Any) -> dict[str, Any]:
    _check_request(request)
    operation = request["operation"]
    text = request["text"]
    section = request.get("section", [])
    doc = _parse(text)
    response: dict[str, Any] = {"schemaVersion": SCHEMA_VERSION, "ok": True, "operation": operation, "version": _version()}
    if operation == "validate":
        return response
    if operation == "read":
        node = _walk(doc, list(section), create=False)
        response["exists"] = node is not None
        response["fields"] = _unwrap(node) if node is not None else {}
        return response
    for intent in request.get("intents", []):
        _apply_intent(doc, list(section), intent)
    new_text = doc.as_string()
    # The result must still be valid TOML: a wrong edit is never returned.
    _parse(new_text)
    node = _walk(_parse(new_text), list(section), create=False)
    response["text"] = new_text
    response["changed"] = new_text != text
    response["exists"] = node is not None
    response["fields"] = _unwrap(node) if node is not None else {}
    return response


def _json_default(value: Any) -> Any:
    """TOML dates and times have no JSON form: they travel as ISO strings (read only)."""
    isoformat = getattr(value, "isoformat", None)
    return isoformat() if callable(isoformat) else str(value)


def main(stdin=None, stdout=None) -> int:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    try:
        raw = stdin.read()
        try:
            request = json.loads(raw)
        except ValueError as exc:
            raise HelperError("BAD_REQUEST", f"the request is not valid JSON: {exc}") from exc
        payload = handle(request)
        code = 0
    except HelperError as error:
        payload = error.payload()
        code = 1
    except Exception as exc:  # never leak a traceback as the protocol answer
        payload = HelperError("INTERNAL", f"{type(exc).__name__}: {exc}").payload()
        code = 1
    stdout.write(json.dumps(payload, ensure_ascii=False, default=_json_default))
    stdout.write("\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
