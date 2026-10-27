import { canonicalJson } from "../../ids/index.js";
import { translator } from "../../../i18n/index.js";
import { decodePointer, isDescendant, isPlainObject, type LayerOp, type ListOp } from "./pointer.js";
import type { FieldWrite, Origin, ResolvedField, ResolveIssue } from "./types.js";

interface FieldState {
  segments: string[];
  value: unknown;
  history: FieldWrite[];
}

export type IssueSink = { error: (issue: ResolveIssue) => void; warning: (issue: ResolveIssue) => void };

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/**
 * The effective configuration as leaves by JSON Pointer, each with its write history.
 * Layers are applied weakest first; a later write replaces the value and keeps the previous one in the history.
 */
export class FieldStore {
  private readonly fields = new Map<string, FieldState>();
  private readonly t = translator("config");

  constructor(private readonly missingRemove: "warning" | "error" | "ignore" = "warning") {}

  apply(op: LayerOp, origin: Omit<Origin, "path">, sink: IssueSink): void {
    if (op.pointer === "") return; // an empty document writes nothing
    const write = (value: unknown, kind: FieldWrite["op"], previous: FieldState | undefined, operation?: unknown): void => {
      const entry: FieldWrite = { ...origin, path: op.path, value, op: kind, ...(operation !== undefined ? { operation } : {}) };
      const history = previous ? [...previous.history, entry] : [entry];
      this.fields.set(op.pointer, { segments: op.segments, value, history });
    };

    if (op.kind === "set" && op.segments[op.segments.length - 1] === "enabled" && op.value === null) {
      sink.error({ code: "ENABLED_NULL", message: this.t("resolve_enabled_null", { pointer: op.pointer }), fix: this.t("resolve_enabled_null_fix"), pointer: op.pointer, ...(origin.file ? { file: origin.file } : {}) });
      return;
    }

    // A leaf above the pointer stops being a leaf: the object now has keys.
    this.dropLeafAncestors(op.pointer);

    if (op.kind === "object") {
      const current = this.fields.get(op.pointer);
      if (this.hasDescendants(op.pointer)) return;
      if (current && isPlainObject(current.value)) return;
      write({}, "object", current);
      return;
    }

    if (op.kind === "set") {
      const replaced = this.takeSubtree(op.pointer);
      write(op.value, "set", replaced ?? this.fields.get(op.pointer));
      return;
    }

    // Explicit list operation.
    const current = this.fields.get(op.pointer);
    if ((current && !Array.isArray(current.value)) || this.hasDescendants(op.pointer)) {
      sink.error({ code: "LIST_OP_NOT_LIST", message: this.t("resolve_list_op_not_list", { pointer: op.pointer }), pointer: op.pointer, ...(origin.file ? { file: origin.file } : {}) });
      return;
    }
    const listOp = op.value as ListOp;
    const base = Array.isArray(current?.value) ? [...(current?.value as unknown[])] : [];
    let next: unknown[];
    if (listOp.replace) next = [...listOp.replace];
    else {
      const adds = listOp.add ?? [];
      const removes = listOp.remove ?? [];
      for (const item of adds) {
        if (removes.some((r) => same(r, item))) {
          sink.error({ code: "LIST_OP_ADD_AND_REMOVE", message: this.t("resolve_list_op_add_remove", { pointer: op.pointer, item: canonicalJson(item) }), pointer: op.pointer });
          return;
        }
      }
      next = base;
      for (const item of removes) {
        const index = next.findIndex((x) => same(x, item));
        if (index === -1) {
          if (this.missingRemove !== "ignore") {
            const issue: ResolveIssue = { code: "REMOVE_MISSING_ITEM", message: this.t("resolve_remove_missing", { pointer: op.pointer, item: canonicalJson(item) }), pointer: op.pointer, ...(origin.file ? { file: origin.file } : {}) };
            if (this.missingRemove === "error") sink.error(issue);
            else sink.warning(issue);
          }
          continue;
        }
        next = next.filter((x) => !same(x, item));
      }
      for (const item of adds) if (!next.some((x) => same(x, item))) next.push(item);
    }
    write(next, "list", current, listOp);
  }

  private hasDescendants(pointer: string): boolean {
    for (const key of this.fields.keys()) if (isDescendant(key, pointer)) return true;
    return false;
  }

  private dropLeafAncestors(pointer: string): void {
    for (const key of [...this.fields.keys()]) if (isDescendant(pointer, key)) this.fields.delete(key);
  }

  /** Removes the leaves under a pointer that is about to get a plain value; returns them as one previous state. */
  private takeSubtree(pointer: string): FieldState | undefined {
    const under = [...this.fields.entries()].filter(([key]) => isDescendant(key, pointer));
    if (under.length === 0) return undefined;
    const value: Record<string, unknown> = {};
    let latest: FieldWrite | undefined;
    const base = decodePointer(pointer)?.length ?? 0;
    for (const [key, state] of under) {
      setIn(value, state.segments.slice(base), state.value);
      const last = state.history[state.history.length - 1];
      if (last) latest = last;
      this.fields.delete(key);
    }
    return latest ? { segments: decodePointer(pointer) ?? [], value, history: [{ ...latest, value }] } : undefined;
  }

  /** The effective configuration, with keys sorted. */
  tree(): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    for (const key of [...this.fields.keys()].sort()) {
      const state = this.fields.get(key) as FieldState;
      setIn(root, state.segments, state.value);
    }
    return sortKeys(root) as Record<string, unknown>;
  }

  /** Leaves by pointer (sorted), each with its last origin and the previous value. */
  resolvedFields(): Record<string, ResolvedField> {
    const out: Record<string, ResolvedField> = {};
    for (const key of [...this.fields.keys()].sort()) {
      const state = this.fields.get(key) as FieldState;
      const last = state.history[state.history.length - 1] as FieldWrite;
      const before = state.history.length > 1 ? (state.history[state.history.length - 2] as FieldWrite) : undefined;
      out[key] = {
        pointer: key,
        value: state.value,
        layer: last.layer,
        source: last.source,
        file: last.file,
        path: last.path,
        op: last.op,
        ...(last.operation !== undefined ? { operation: last.operation } : {}),
        ...(before ? { previous: { value: before.value, layer: before.layer, source: before.source, file: before.file, path: before.path } } : {}),
        history: state.history,
      };
    }
    return out;
  }

  get(pointer: string): unknown {
    return this.fields.get(pointer)?.value;
  }
}

function setIn(target: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let node = target;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      node[segment] = value;
      return;
    }
    const next = node[segment];
    if (!isPlainObject(next)) node[segment] = {};
    node = node[segment] as Record<string, unknown>;
  });
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

/** Value at a pointer of a plain tree; undefined when absent. */
export function getIn(tree: unknown, segments: readonly string[]): unknown {
  let node: unknown = tree;
  for (const s of segments) {
    if (!isPlainObject(node) || !Object.hasOwn(node, s)) return undefined;
    node = node[s];
  }
  return node;
}
