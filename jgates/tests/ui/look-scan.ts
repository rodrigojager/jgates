// The in-page scan of look-and-access.spec.ts (V2-74, PLAN-consistency.md X11-X19). It runs inside the page
// (page.evaluate serializes the function, so everything it needs is declared inside it) and returns the offenders by rule
// as short readable lines, so the spec can walk every screen and report all of them at once.

export interface Scan {
  /** Disabled controls with no reason a person or a screen reader can reach (title, description or the mark). */
  disabled: string[];
  /** Visible, enabled targets lower than 24 px. */
  targets: string[];
  /** Table columns cut (clipped text, or the table scrolling inside its box) and other clipped text. */
  cut: string[];
  /** Native controls the design system did not style. */
  native: string[];
  /** Selects that offer no choice. */
  single: string[];
  /** Pixels the page reaches past the viewport. */
  sideways: string[];
  /** Visible primary buttons outside dialogs. */
  primary: string[];
  /** Tabs placed above the page title. */
  layout: string[];
}

export function scanAll(): Scan {
  const MIN_TARGET = 24;
  const describe = (el: Element): string => {
    const e = el as HTMLElement;
    const text = (e.getAttribute("aria-label") ?? e.innerText ?? e.getAttribute("value") ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const cls = typeof e.className === "string" ? e.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    const id = e.getAttribute("data-testid");
    return `${e.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${id ? `[${id}]` : ""} "${text}"`;
  };
  const textOf = (ids: string | null): string =>
    (ids ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join("");

  const disabled: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled="true"]')) {
    if (!el.checkVisibility() || el.closest(".sr-only")) continue;
    const reason = (el.getAttribute("title") ?? "").trim() || textOf(el.getAttribute("aria-describedby")) || el.closest("[data-control-unavailable]")?.getAttribute("data-control-unavailable") || "";
    if (!reason) disabled.push(describe(el));
  }

  const targets: string[] = [];
  const interactive = "button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=link], [role=menuitem]";
  for (const el of document.querySelectorAll<HTMLElement>(interactive)) {
    if (!el.checkVisibility() || el.closest(".sr-only, .skip") || (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.pointerEvents === "none") continue;
    let rect = el.getBoundingClientRect();
    if (rect.width <= 1 && rect.height <= 1) {
      // A visually hidden native input: the control is the label that wraps it or that points at it.
      const wrap = el.closest("label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      if (!wrap) continue;
      rect = wrap.getBoundingClientRect();
    } else if (el.matches("input[type=checkbox], input[type=radio]")) {
      const wrap = el.closest("label");
      if (wrap) rect = wrap.getBoundingClientRect();
    }
    if (rect.height < MIN_TARGET - 0.5) targets.push(`${describe(el)} (${Math.round(rect.height * 10) / 10}px)`);
  }

  const cut: string[] = [];
  for (const table of document.querySelectorAll<HTMLElement>("main table, dialog table")) {
    if (!table.checkVisibility()) continue;
    const box = table.parentElement as HTMLElement;
    if (box.scrollWidth > box.clientWidth + 1 && getComputedStyle(box).overflowX !== "visible") cut.push(`table scrolls inside its box: ${describe(table)} (${box.scrollWidth} > ${box.clientWidth})`);
    for (const cell of table.querySelectorAll<HTMLElement>("th, td")) {
      // The header row of a table stacked into cards is visually hidden by design.
      const head = cell.closest("thead");
      if (head && getComputedStyle(head).position === "absolute") continue;
      if (cell.checkVisibility() && cell.scrollWidth > cell.clientWidth + 1) cut.push(`cut cell ${describe(cell)}`);
    }
  }
  for (const el of document.querySelectorAll<HTMLElement>("main *, dialog *")) {
    if (el.closest(".editor-host, .cm-editor, canvas, .quality-mascots, .log, pre, .diff, .sr-only")) continue;
    const style = getComputedStyle(el);
    const clips = style.overflowX === "hidden" || style.overflowX === "clip" || style.textOverflow === "ellipsis";
    // A visually hidden element (the header row of a table stacked into cards) clips by design.
    if (!clips || !el.checkVisibility() || (style.position === "absolute" && el.clientWidth <= 1)) continue;
    if (el.scrollWidth > el.clientWidth + 1 && (el.innerText ?? "").trim().length > 0) cut.push(`clipped ${describe(el)} (${el.scrollWidth} > ${el.clientWidth})`);
  }

  const native: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("select, textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]), progress, fieldset")) {
    if (!el.checkVisibility() || el.closest(".cm-editor, .sr-only")) continue;
    const s = getComputedStyle(el);
    const radius = parseFloat(s.borderTopLeftRadius) || 0;
    const border = parseFloat(s.borderTopWidth) || 0;
    if (el.tagName === "PROGRESS") {
      if (s.appearance !== "none") native.push(`${describe(el)}: native progress`);
    } else if (el.tagName === "FIELDSET") {
      // The design system's fieldset is a card (rounded) or has no border at all; the engraved or square one is the browser's.
      if (border > 0 && (s.borderTopStyle === "groove" || radius === 0)) native.push(`${describe(el)}: native fieldset`);
    } else if (border === 0 || radius === 0) {
      native.push(`${describe(el)}: native ${el.tagName.toLowerCase()}`);
    }
  }

  const single: string[] = [];
  for (const select of document.querySelectorAll<HTMLSelectElement>("select")) {
    if (select.checkVisibility() && select.options.length <= 1) single.push(describe(select));
  }

  const root = document.documentElement;
  const extra = Math.max(root.scrollWidth - root.clientWidth, document.body.scrollWidth - root.clientWidth);
  const primary = [...document.querySelectorAll<HTMLElement>("main .btn.primary")].filter((b) => b.checkVisibility() && !b.closest("dialog")).map(describe);
  const wide = extra > 0 ? [...document.querySelectorAll<HTMLElement>("body *")].filter((e) => e.getBoundingClientRect().right > root.clientWidth + 1 && getComputedStyle(e).position !== "fixed" && e.checkVisibility()).slice(0, 3).map(describe) : [];
  const title = document.querySelector<HTMLElement>("main h1");
  const layout = [...document.querySelectorAll<HTMLElement>("main [role=tablist], main .tabs")]
    .filter((tabs) => tabs.checkVisibility() && title && !tabs.closest("dialog") && tabs.getBoundingClientRect().top < title.getBoundingClientRect().top)
    .map((tabs) => `tabs above the title: ${describe(tabs)}`);
  return { disabled, targets, cut, native, single, sideways: extra > 0 ? [`${extra} px past the viewport (${wide.join(", ")})`] : [], primary, layout };
}
