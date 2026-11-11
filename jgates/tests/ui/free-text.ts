import { expect, type Page } from "@playwright/test";

// R2 of the guided UI: a control that takes free text where the set of values is known is a defect. Every free-text
// control of the services flow, the own-tool dialog and the declare-component dialog names why its values are open
// (`data-free-text="<reason>"`), and the reason must be one of the open kinds below; a label that names a known set
// (role, service, port, component, language, format, capability, method, timeout) fails the check.

/** Open kinds: paths, names and addresses the project invents. */
export const FREE_TEXT_REASONS = new Set([
  "path",
  "url-path",
  "port-undeclared",
  "project-path",
  "identifier",
  "other-language",
  "other-framework",
  "image-reference",
  "download-url",
  "checksum",
  "package-spec",
  "tool-id",
  "command",
  "arguments",
  "report-file",
  "capability-name",
]);

/** Labels of controls whose value set is known. */
export const KNOWN_SET_WORDS = /\b(papel|role|serviço|service|componente|component|linguagem|language|formato|format|capacidade verificada|método|method|tempo máximo|timeout)\b/i;

export interface FreeTextControl {
  label: string;
  tag: string;
  type: string;
  reason: string | null;
}

/** The free-text controls (text, number, url, textarea) that are on screen inside `root`. */
export async function freeTextControls(page: Page, root = "body"): Promise<FreeTextControl[]> {
  return page.evaluate((selector) => {
    const scope = document.querySelector(selector) ?? document.body;
    const nodes = scope.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=search]), textarea");
    return [...nodes]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => {
        const label = (el.labels?.[0]?.textContent ?? el.getAttribute("aria-label") ?? el.id ?? "").replace(/\s+/g, " ").trim();
        return { label, tag: el.tagName.toLowerCase(), type: (el as HTMLInputElement).type ?? "textarea", reason: el.getAttribute("data-free-text") };
      });
  }, root);
}

/** Fails on a free-text control without a reason, with a reason that is not an open kind, or labelled with a known set. */
export async function expectNoKnownSetAsText(page: Page, root = "body", where = "screen"): Promise<number> {
  const controls = await freeTextControls(page, root);
  for (const control of controls) {
    expect(control.reason, `${where}: the free-text field "${control.label}" must say why it is not a select`).not.toBeNull();
    expect(FREE_TEXT_REASONS.has(control.reason as string), `${where}: "${control.label}" has the reason ${control.reason}, which is not an open kind`).toBe(true);
    expect(KNOWN_SET_WORDS.test(control.label), `${where}: the field "${control.label}" has a known set of values and must not be free text`).toBe(false);
  }
  return controls.length;
}
