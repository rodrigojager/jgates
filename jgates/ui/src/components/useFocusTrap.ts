import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Keeps keyboard focus inside `container` while `active`: Tab and Shift+Tab wrap around, Escape calls `onEscape`, focus
 * moves in when it activates and goes back to the element that had it when it deactivates.
 */
export function useFocusTrap(container: RefObject<HTMLElement | null>, active: boolean, onEscape: () => void): void {
  useEffect(() => {
    const root = container.current;
    if (!active || !root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = focusables(root)[0];
    (first ?? root).focus();
    // A modal <dialog> opened from inside the container (the workspace switcher) traps focus by itself.
    const dialogOpen = () => document.querySelector("dialog[open]") !== null;
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables(root);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const head = items[0] as HTMLElement;
      const tail = items[items.length - 1] as HTMLElement;
      const current = document.activeElement;
      if (event.shiftKey && (current === head || !root.contains(current))) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && (current === tail || !root.contains(current))) {
        event.preventDefault();
        head.focus();
      }
    };
    // Focus that escapes by other means (a click, a script) is pulled back in.
    const onFocusIn = (event: FocusEvent) => {
      if (dialogOpen()) return;
      if (event.target instanceof Node && !root.contains(event.target)) (focusables(root)[0] ?? root).focus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      previous?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, container]);
}
