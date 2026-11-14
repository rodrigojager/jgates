// The categories in one order everywhere: the quality mascot strip's, then the project's own checks (the server keeps the same
// list in core/mascots). Lists of categories sort with this rank, never alphabetically.
export const CATEGORY_ORDER: readonly string[] = ["quality", "security", "dependencies", "tests", "architecture", "infrastructure", "custom"];

export function categoryRank(id: string): number {
  const at = CATEGORY_ORDER.indexOf(id);
  return at < 0 ? CATEGORY_ORDER.length : at;
}

/** A copy of the ids in the fixed category order (unknown ones last, by name). */
export function sortCategories(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b));
}
