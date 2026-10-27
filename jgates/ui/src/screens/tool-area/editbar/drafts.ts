import { useCallback, useEffect, useRef, useState } from "react";
import { api, entryQuery } from "../../../api";

// Drafts of the Files tab: the typed text is kept in the JGates data folder (never in the project) while it differs
// from the file, so a reload of the page gives it back. The project file only changes through the document save.

export interface DraftView {
  text: string;
  baseRevision: string | null;
  currentRevision: string | null;
  stale: boolean;
  updatedAt: string;
  validation: { status: string; errors?: Array<{ message: string; line: number | null; column: number | null }> } | null;
}

export type DraftState = "idle" | "saving" | "saved" | "error";

const draftPath = (instance: string, binding: string, entry: string | null): string => `/api/drafts/${encodeURIComponent(instance)}/${encodeURIComponent(binding)}${entryQuery(entry)}`;

/** The draft of a document, or null. */
export async function fetchDraft(instance: string, binding: string, entry: string | null): Promise<DraftView | null> {
  const r = await api<{ draft: DraftView | null }>("GET", draftPath(instance, binding, entry));
  return r.draft;
}

export async function discardDraft(instance: string, binding: string, entry: string | null): Promise<void> {
  await api("DELETE", draftPath(instance, binding, entry));
}

export interface DraftSyncInput {
  instance: string;
  binding: string | null;
  entry: string | null;
  /** The document as read; null while none is open or when it cannot be edited as text. */
  doc: { text: string | null; exists: boolean } | null;
  /** Revision the text is typed over (the document revision, or the one of a restored draft). */
  baseRevision: string | null;
  text: string;
  /** False for a read-only document: no draft is kept. */
  enabled: boolean;
  /** Draft known to exist already (restored), so that returning to the saved text drops it. */
  hasDraft: boolean;
}

const DEBOUNCE_MS = 500;

/**
 * Keeps the draft in step with the editor: a text that differs from the file is written to the data folder after a
 * short pause; a text equal to the file removes the draft. Leaving the document sends the pending text first.
 */
export function useDraftSync(input: DraftSyncInput): { state: DraftState; exists: boolean; discard: () => Promise<void> } {
  const [state, setState] = useState<DraftState>("idle");
  const [exists, setExists] = useState(input.hasDraft);
  const latest = useRef(input);
  latest.current = input;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const known = useRef(input.hasDraft);
  const sent = useRef<string | null>(null);

  useEffect(() => {
    known.current = input.hasDraft;
    setExists(input.hasDraft);
    sent.current = null;
  }, [input.hasDraft, input.binding, input.entry, input.instance]);

  const push = useCallback(async () => {
    const cur = latest.current;
    if (!cur.enabled || !cur.doc || !cur.binding) return;
    const dirty = cur.text !== (cur.doc.text ?? "");
    try {
      if (dirty) {
        if (sent.current === cur.text) {
          setState("saved");
          return;
        }
        setState("saving");
        const body = { text: cur.text, baseRevision: cur.baseRevision, ...(cur.entry ? { entry: cur.entry } : {}) };
        await api("PUT", draftPath(cur.instance, cur.binding, null), body);
        sent.current = cur.text;
        known.current = true;
        setExists(true);
        setState("saved");
      } else if (known.current) {
        await discardDraft(cur.instance, cur.binding, cur.entry);
        known.current = false;
        sent.current = null;
        setExists(false);
        setState("idle");
      } else {
        setState("idle");
      }
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (!input.enabled || !input.doc || !input.binding) return;
    if (timer.current) clearTimeout(timer.current);
    const dirty = input.text !== (input.doc.text ?? "");
    if (dirty) setState((s) => (s === "saved" && sent.current === input.text ? s : "saving"));
    timer.current = setTimeout(() => {
      timer.current = null;
      void push();
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [input.text, input.doc, input.binding, input.entry, input.baseRevision, input.enabled, push]);

  // Leaving the screen with a pending write: send it now.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        void push();
      }
    },
    [push],
  );

  const discard = useCallback(async () => {
    const cur = latest.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (cur.binding) await discardDraft(cur.instance, cur.binding, cur.entry).catch(() => undefined);
    known.current = false;
    sent.current = null;
    setExists(false);
    setState("idle");
  }, []);

  return { state, exists, discard };
}
