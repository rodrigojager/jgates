// Normalizes the JSON report (-J) of ZAP's packaged scans (zap-baseline.py, zap-api-scan.py, zap-full-scan.py; fixture
// of ZAP 2.17.0 in tests/fixtures/runtime-api/recorded) into result findings: one per alert, with its first instances
// as the reproduction. Fail-closed: anything but a ZAP report with a list of sites proves nothing (no sites at all means
// nothing was scanned, which is not a clean result). Alerts ZAP itself marks as false positives (confidence 0) are kept
// out; which risk blocks is the blockingRisk setting of the instance.
import { contentHash } from "../../core/ids/index.js";
import type { NormalizedSeverity, ResultFinding } from "../../core/run/types.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export const RISK_LEVELS = ["informational", "low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const RISKS: Record<string, { native: RiskLevel; normalized: NormalizedSeverity; rank: number }> = {
  "0": { native: "informational", normalized: "info", rank: 0 },
  "1": { native: "low", normalized: "low", rank: 1 },
  "2": { native: "medium", normalized: "medium", rank: 2 },
  "3": { native: "high", normalized: "high", rank: 3 },
};

export interface ZapParse {
  ok: boolean;
  findings: ResultFinding[];
  version: string | null;
  /** Sites present in the report (the scanned origins). */
  sites: string[];
  problem?: string;
}

const stripHtml = (text: string): string => text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** `rewrite` maps the URLs the container saw (host.docker.internal) back to the target the plan names. */
export function parseZapReport(text: string, opts: { stageId: string; blockingRisk: RiskLevel; rewrite?: (url: string) => string }): ZapParse {
  const fail = (problem: string): ZapParse => ({ ok: false, findings: [], version: null, sites: [], problem });
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!isRec(doc) || (doc["@programName"] !== "ZAP" && doc["@programName"] !== "OWASP ZAP")) return fail("the document is not a ZAP JSON report");
  if (!Array.isArray(doc.site)) return fail("the report has no list of sites");
  if (doc.site.length === 0) return fail("the report has no scanned site: nothing was reached");
  const version = str(doc["@version"]);
  const rewrite = opts.rewrite ?? ((u: string) => u);
  const threshold = RISKS[String(RISK_LEVELS.indexOf(opts.blockingRisk))]?.rank ?? 2;
  const findings: ResultFinding[] = [];
  const sites: string[] = [];
  for (const [si, site] of doc.site.entries()) {
    if (!isRec(site) || !Array.isArray(site.alerts)) return fail(`site ${si} has no list of alerts`);
    const siteName = rewrite(str(site["@name"]) ?? "");
    sites.push(siteName);
    for (const [ai, alert] of site.alerts.entries()) {
      const pluginId = isRec(alert) ? str(alert.pluginid) : null;
      const name = isRec(alert) ? (str(alert.alert) ?? str(alert.name)) : null;
      const riskcode = isRec(alert) ? String(alert.riskcode ?? "") : "";
      if (!isRec(alert) || !pluginId || !name || !Array.isArray(alert.instances)) return fail(`alert ${ai} of site ${si} has no plugin id, name or instances`);
      // Confidence 0 is ZAP's own "false positive" mark.
      if (String(alert.confidence ?? "") === "0") continue;
      const risk = RISKS[riskcode];
      // An unknown risk blocks: nothing the tool cannot qualify may count as favorable.
      const blocking = risk ? risk.rank >= threshold : true;
      const instances = alert.instances.filter(isRec).map((i) => ({ method: str(i.method) ?? "GET", uri: rewrite(str(i.uri) ?? ""), param: str(i.param), attack: str(i.attack), evidence: str(i.evidence) }));
      const first = instances.slice(0, 3).map((i) => `${i.method} ${i.uri}${i.param ? ` [${i.param}]` : ""}${i.attack ? ` attack: ${i.attack}` : ""}`);
      const cwe = str(alert.cweid);
      const ref = str(alert.alertRef) ?? pluginId;
      findings.push({
        stageId: opts.stageId,
        tool: "zap",
        ruleId: ref,
        category: "dast",
        severity: risk?.native ?? riskcode,
        normalizedSeverity: risk?.normalized ?? "unknown",
        message: `${name} (${instances.length} instance(s) on ${siteName})`,
        fingerprint: contentHash({ tool: "zap", rule: ref, site: siteName, uris: instances.map((i) => `${i.method} ${i.uri} ${i.param ?? ""}`).sort() }),
        origin: "zap",
        blocking,
        ...(blocking ? { blockingReason: "blocking-tool" as const } : {}),
        waived: false,
        evidence: `reproduce: ${first.join("; ")}`,
        ...(str(alert.solution) ? { remediation: stripHtml(alert.solution as string).slice(0, 500) } : {}),
        ...(cwe && cwe !== "-1" && cwe !== "0" ? { docsUrl: `https://cwe.mitre.org/data/definitions/${cwe}.html` } : { docsUrl: `https://www.zaproxy.org/docs/alerts/${pluginId}/` }),
      });
    }
  }
  return { ok: true, findings, version, sites };
}
