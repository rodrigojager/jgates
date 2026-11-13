import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, drawSelection, gutter, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
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
  ".cm-diag-line": { backgroundColor: "color-mix(in srgb, var(--red) 14%, transparent)", textDecoration: "underline wavy var(--red)", textUnderlineOffset: "3px" },
  ".cm-diag-gutter": { width: "1.2em" },
  ".cm-diag-mark": { color: "var(--red)", fontWeight: "700" },
});

/** A problem the parent found in the text: the 1-based line and what is wrong (shown as the tooltip of the line). */
export interface EditorMarker {
  line: number;
  message: string;
}

const setMarkers = StateEffect.define<EditorMarker[]>();

/** The marked lines, by line number, with the first message of each. */
const markerField = StateField.define<Map<number, string>>({
  create: () => new Map(),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setMarkers)) {
        const next = new Map<number, string>();
        for (const m of effect.value) if (!next.has(m.line)) next.set(m.line, m.message);
        return next;
      }
    }
    return value;
  },
  provide: (field) =>
    EditorView.decorations.compute([field], (state) => {
      const marks = state.field(field);
      const ranges = [...marks.entries()]
        .filter(([line]) => line >= 1 && line <= state.doc.lines)
        .sort((a, b) => a[0] - b[0])
        .map(([line, message]) => Decoration.line({ class: "cm-diag-line", attributes: { "data-diag-line": String(line), title: message } }).range(state.doc.line(line).from));
      return Decoration.set(ranges);
    }),
});

class ProblemMarker extends GutterMarker {
  toDOM(): Node {
    const el = document.createElement("span");
    el.className = "cm-diag-mark";
    el.textContent = "!";
    el.setAttribute("data-diag-mark", "true");
    return el;
  }
}
const problemMarker = new ProblemMarker();

const problemGutter = gutter({
  class: "cm-diag-gutter",
  lineMarker: (view, block) => (view.state.field(markerField).has(view.state.doc.lineAt(block.from).number) ? problemMarker : null),
  lineMarkerChange: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(setMarkers))),
  initialSpacer: () => problemMarker,
});

function languageFor(format: string): Extension {
  let language: LanguageSupport | StreamLanguage<unknown> | null = null;
  if (format === "json" || format === "jsonc") language = json();
  else if (format === "yaml") language = yaml();
  else if (format === "toml") language = StreamLanguage.define(toml);
  return language ?? [];
}

/**
 * The text is an explicit tab stop, editable or not: a long text scrolls inside the editor, and a scrollable region has to
 * contain focusable content for the keyboard to reach and scroll it (WCAG 2.1.1, axe scrollable-region-focusable).
 */
function lockExtensions(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.contentAttributes.of({ tabindex: "0" })];
}

export interface EditorProps {
  value: string;
  format: string;
  readOnly: boolean;
  label: string;
  onChange: (text: string) => void;
  /** 1-based line to place the cursor on and scroll to (the "open at the position in the file" link). */
  line?: number | null;
  /** Changes when the same line has to be reached again (a click on a problem of the list). */
  lineJump?: number;
  /** Lines with a problem: marked in the gutter and in the text. */
  markers?: EditorMarker[];
}

/** CodeMirror 6 bound to a text value; the parent re-keys it (by document) to load another file. */
export function Editor({ value, format, readOnly, label, onChange, line, lineJump, markers }: EditorProps) {
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
        markerField,
        problemGutter,
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
        lock.current.of(lockExtensions(readOnly)),
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
    view.current?.dispatch({ effects: lock.current.reconfigure(lockExtensions(readOnly)) });
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
  }, [line, lineJump]);

  useEffect(() => {
    view.current?.dispatch({ effects: setMarkers.of(markers ?? []) });
  }, [markers]);

  return <div className="editor-host" ref={host} data-testid="editor" data-line={line ?? undefined} />;
}
