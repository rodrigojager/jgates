import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

// Token colors come from CSS variables, so the same highlight style serves the light and the dark theme. CodeMirror
// mounts its style modules through constructable stylesheets, which the server CSP (style-src 'self') allows.
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: "var(--accent)", fontWeight: "600" },
  { tag: [tags.propertyName, tags.definition(tags.propertyName), tags.heading], color: "var(--blue)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--gold)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--red)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.punctuation, tags.separator, tags.bracket], color: "var(--muted)" },
]);

// The editor lives in a shadow root: CodeMirror then mounts its styles as constructable stylesheets instead of a <style>
// element, which the server CSP (style-src 'self', no 'unsafe-inline') would block. Custom properties cross the boundary.
const theme = EditorView.theme({
  "&": { maxHeight: "62vh", minHeight: "240px", backgroundColor: "var(--surface)", color: "var(--ink)" },
  "&.cm-focused": { outline: "3px solid var(--focus)", outlineOffset: "-3px" },
  ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "13px", lineHeight: "1.55", overflow: "auto" },
  ".cm-gutters": { backgroundColor: "var(--sidebar)", color: "var(--muted)", borderRight: "1px solid var(--line)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--mint)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--blue-bg)" },
  ".cm-content": { caretColor: "var(--ink)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
});

function languageFor(format: string): Extension {
  let language: LanguageSupport | StreamLanguage<unknown> | null = null;
  if (format === "json" || format === "jsonc") language = json();
  else if (format === "yaml") language = yaml();
  else if (format === "toml") language = StreamLanguage.define(toml);
  return language ?? [];
}

export interface EditorProps {
  value: string;
  format: string;
  readOnly: boolean;
  label: string;
  onChange: (text: string) => void;
  /** 1-based line to place the cursor on and scroll to (the "open at the position in the file" link). */
  line?: number | null;
}

/** CodeMirror 6 bound to a text value; the parent re-keys it (by document) to load another file. */
export function Editor({ value, format, readOnly, label, onChange, line }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const lock = useRef(new Compartment());
  // Texts the editor reported through onChange that the parent has not handed back yet. When the parent renders with
  // one of them, that is the echo of the user's own typing (possibly stale by a few keystrokes), not a replacement:
  // writing it back would erase what was typed meanwhile.
  const echoes = useRef<string[]>([]);

  useEffect(() => {
    if (!host.current) return;
    const shadow = host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" });
    const mount = document.createElement("div");
    shadow.appendChild(mount);
    const state = EditorState.create({
      doc: value,
      extensions: [
        theme,
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(highlight),
        languageFor(format),
        // Tab is not bound to indentation: it would trap the keyboard focus inside the editor (WCAG 2.1.2). Mod-] and Mod-[
        // indent from defaultKeymap.
        keymap.of([...defaultKeymap, ...historyKeymap]),
        lock.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        EditorView.contentAttributes.of({ "aria-label": label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString();
            echoes.current.push(text);
            change.current(text);
          }
        }),
      ],
    });
    const instance = new EditorView({ state, parent: mount, root: shadow });
    view.current = instance;
    return () => {
      instance.destroy();
      mount.remove();
      view.current = null;
    };
    // The editor is created once per mounted document; the parent changes `key` to open another one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: lock.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  // External replacement of the text (reload from disk).
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const echo = echoes.current.indexOf(value);
    if (echo >= 0) {
      echoes.current.splice(0, echo + 1);
      return;
    }
    echoes.current = [];
    if (instance.state.doc.toString() !== value) {
      instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: value } });
      echoes.current = [];
    }
  }, [value]);

  // Go to a line: cursor at its start, scrolled into view, focus in the editor.
  useEffect(() => {
    const instance = view.current;
    if (!instance || !line) return;
    const target = instance.state.doc.line(Math.min(Math.max(1, line), instance.state.doc.lines));
    instance.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
    instance.focus();
  }, [line]);

  return <div className="editor-host" ref={host} data-testid="editor" data-line={line ?? undefined} />;
}
