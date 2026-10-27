from __future__ import annotations

import os


SUPPORTED_LOCALES = ("en", "pt-BR")

_MESSAGES = {
    "en": {
        "target_missing": "Target directory not found: {target}",
        "invalid_waiver": "Invalid waiver file: {error}",
        "invalid_configuration": "Invalid quality policy or evidence configuration: {error}",
        "result": "{status} score={score:.2f} threshold={threshold}",
        "reports": "Reports: {path}",
        "report_title": "Quality Gate Report",
        "status": "Status",
        "score": "Score",
        "threshold": "Threshold",
        "mode": "Mode",
        "profile": "Profile",
        "reasons": "Reasons",
        "no_reason": "No blocking policy reason.",
        "tools": "Tools",
        "no_tools": "No external tools were executed.",
        "metrics": "Deterministic Metrics",
        "findings": "Findings",
        "no_findings": "No findings.",
        "ci_error": "Quality CI configuration error: {detail}",
        "ci_policy_required": "An externally governed organization policy and its SHA-256 are required.",
    },
    "pt-BR": {
        "target_missing": "Diretório alvo não encontrado: {target}",
        "invalid_waiver": "Arquivo de dispensa inválido: {error}",
        "invalid_configuration": "Política de qualidade ou configuração de evidência inválida: {error}",
        "result": "{status} nota={score:.2f} limite={threshold}",
        "reports": "Relatórios: {path}",
        "report_title": "Relatório do Quality Gate",
        "status": "Status",
        "score": "Nota",
        "threshold": "Limite",
        "mode": "Modo",
        "profile": "Perfil",
        "reasons": "Motivos",
        "no_reason": "Nenhum motivo bloqueante na política.",
        "tools": "Ferramentas",
        "no_tools": "Nenhuma ferramenta externa foi executada.",
        "metrics": "Métricas determinísticas",
        "findings": "Achados",
        "no_findings": "Nenhum achado.",
        "ci_error": "Erro de configuração do Quality CI: {detail}",
        "ci_policy_required": "Uma política da organização administrada externamente e seu SHA-256 são obrigatórios.",
    },
}


def normalize_locale(value: str | None) -> str:
    candidate = (value or os.environ.get("QUALITY_GATE_LOCALE") or "en").strip()
    aliases = {"pt": "pt-BR", "pt_br": "pt-BR", "pt-br": "pt-BR", "en-us": "en", "en_us": "en"}
    normalized = aliases.get(candidate.casefold(), candidate)
    return normalized if normalized in SUPPORTED_LOCALES else "en"


def translate(locale: str | None, key: str, **values: object) -> str:
    selected = normalize_locale(locale)
    template = _MESSAGES.get(selected, _MESSAGES["en"]).get(key, _MESSAGES["en"].get(key, key))
    return template.format(**values)
