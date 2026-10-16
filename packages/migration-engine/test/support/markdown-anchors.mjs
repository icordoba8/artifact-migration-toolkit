/**
 * The fragment targets a Markdown document offers: explicit `<a id>` anchors
 * plus GitHub-style heading slugs, ignoring fenced code. Used to prove an
 * engine `schemaRef` lands somewhere real rather than nowhere.
 */
export const anchorsOf = (markdown) => {
  const anchors = new Set();
  const slugCounts = new Map();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    for (const [, id] of line.matchAll(/<a id="([^"]+)"><\/a>/g)) anchors.add(id);
    const heading = /^#{1,6} (.+)$/.exec(line);
    if (!heading) continue;
    const base = heading[1]
      .replace(/<[^>]+>/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replaceAll(" ", "-");
    const seen = slugCounts.get(base) ?? 0;
    slugCounts.set(base, seen + 1);
    anchors.add(seen ? `${base}-${seen}` : base);
  }
  return anchors;
};

/** Every in-document `](#fragment)` link target. */
export const fragmentLinksOf = (markdown) =>
  [...markdown.matchAll(/\]\(#([^)]+)\)/g)].map(([, fragment]) => fragment);

/**
 * The text an anchor introduces: from its line up to the next heading of the
 * same or a higher level.
 */
export const sectionAt = (markdown, id) => {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.includes(`<a id="${id}"></a>`));
  if (start === -1) return null;
  const level = /^(#+) /.exec(lines[start])?.[1].length ?? 7;
  const end = lines.findIndex(
    (line, index) => index > start && /^(#+) /.exec(line)?.[1].length <= level,
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
};
