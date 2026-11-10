// The Python source of one method of a module class, read from the dimos checkout Desktop runs. An RPC
// often has no docstring; its code says what its parameters are for, and it is right there on disk.
// Nothing is imported or run: the class is found by its dotted path, the method by indentation, and a
// method the class inherits by following the `from … import …` lines to its bases.

export type MethodSource = { file: string; line: number; owner: string; text: string; inherited: boolean };

const NAME = /^[A-Za-z_][\w.]*$/;
const indentOf = (line: string) => line.length - line.trimStart().length;

async function readModule(root: string, module: string): Promise<{ path: string; lines: string[] } | null> {
  const base = `${root}/${module.replaceAll(".", "/")}`;
  for (const path of [`${base}.py`, `${base}/__init__.py`]) {
    try { return { path, lines: (await Deno.readTextFile(path)).split("\n") }; } catch { /* try the next shape */ }
  }
  return null;
}

// The lines of `class name` in a file: where its header starts and ends, and where its body ends.
function findClass(lines: string[], name: string): { start: number; body: number; end: number; header: string } | null {
  const start = lines.findIndex((line) => new RegExp(`^\\s*class\\s+${name}\\b`).test(line));
  if (start < 0) return null;
  // A header may run over several lines until its parentheses close and it ends in a colon.
  let body = start, depth = 0, header = "";
  for (; body < lines.length; body++) {
    const line = lines[body].replace(/#.*$/, "");
    header += line.trim();
    depth += (line.match(/[([]/g) ?? []).length - (line.match(/[)\]]/g) ?? []).length;
    if (depth <= 0 && line.trimEnd().endsWith(":")) break;
  }
  const indent = indentOf(lines[start]);
  let end = body + 1;
  while (end < lines.length && (lines[end].trim() === "" || indentOf(lines[end]) > indent)) end++;
  return { start, body: body + 1, end, header };
}

function findMethod(lines: string[], from: number, to: number, method: string): { start: number; end: number } | null {
  const pattern = new RegExp(`^\\s+(async\\s+)?def\\s+${method}\\s*\\(`);
  let at = -1;
  for (let i = from; i < to; i++) if (pattern.test(lines[i])) at = i;   // the last definition wins, as in Python
  if (at < 0) return null;
  const indent = indentOf(lines[at]);
  let start = at;
  while (start > from && /^\s*(@|#)/.test(lines[start - 1]) && indentOf(lines[start - 1]) === indent) start--;
  let end = at + 1, depth = 0, opened = false;
  // The signature may span lines; after it, the body is everything indented deeper.
  for (; end <= to; end++) {
    const line = lines[end - 1].replace(/#.*$/, "");
    depth += (line.match(/[([{]/g) ?? []).length - (line.match(/[)\]}]/g) ?? []).length;
    if (depth <= 0 && line.trimEnd().endsWith(":")) { opened = true; break; }
  }
  if (!opened) return { start, end: at + 1 };
  while (end < to && (lines[end].trim() === "" || indentOf(lines[end]) > indent)) end++;
  while (end > at + 1 && lines[end - 1].trim() === "") end--;
  return { start, end };
}

// The names a class header lists as bases: "class A(B, mod.C[T], metaclass=M):" -> ["B", "C"].
function basesOf(header: string): string[] {
  const inside = header.match(/^class\s+\w+\s*\((.*)\)\s*:/s)?.[1];
  if (!inside) return [];
  const names: string[] = [];
  let depth = 0, current = "";
  for (const char of inside + ",") {
    if (char === "[" || char === "(") depth++;
    if (char === "]" || char === ")") depth--;
    if (char === "," && depth === 0) { names.push(current.trim()); current = ""; } else if (depth === 0) current += char;
  }
  return names.filter((name) => name && !name.includes("=")).map((name) => name.split(".").pop()!).filter((name) => /^[A-Za-z_]\w*$/.test(name));
}

// Where a name used in a file comes from: "from a.b import X as Y" -> a.b.X for Y. Relative imports are resolved.
function importedFrom(lines: string[], name: string, module: string, isPackage: boolean): string | null {
  const text = lines.join("\n");
  for (const match of text.matchAll(/^from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
    for (const part of match[2].replace(/[()]/g, "").split(",")) {
      const [original, alias] = part.replace(/#.*$/, "").trim().split(/\s+as\s+/);
      if ((alias ?? original)?.trim() !== name) continue;
      let source = match[1];
      if (source.startsWith(".")) {
        const dots = source.match(/^\.+/)![0].length, packageParts = module.split(".").slice(0, isPackage ? undefined : -1);
        source = [...packageParts.slice(0, packageParts.length - (dots - 1)), source.slice(dots)].filter(Boolean).join(".");
      }
      return `${source}.${original.trim()}`;
    }
  }
  return null;
}

export async function methodSource(root: string, classPath: string, method: string, seen = new Set<string>()): Promise<MethodSource | null> {
  if (!NAME.test(classPath) || !/^[A-Za-z_]\w*$/.test(method) || seen.has(classPath) || seen.size > 12) return null;
  seen.add(classPath);
  const parts = classPath.split("."), name = parts.pop()!, module = parts.join(".");
  const file = await readModule(root, module);
  if (!file) return null;
  const { lines, path } = file, found = findClass(lines, name);
  if (!found) {
    // A name a package re-exports: follow it to where it is defined.
    const origin = importedFrom(lines, name, module, path.endsWith("__init__.py"));
    return origin ? methodSource(root, origin, method, seen) : null;
  }
  const own = findMethod(lines, found.body, found.end, method);
  if (own) return { file: path.slice(root.length + 1), line: own.start + 1, owner: name, text: lines.slice(own.start, own.end).join("\n"), inherited: seen.size > 1 };
  for (const base of basesOf(found.header)) {
    const origin = findClass(lines, base) ? `${module}.${base}` : importedFrom(lines, base, module, path.endsWith("__init__.py"));
    const inherited = origin ? await methodSource(root, origin, method, seen) : null;
    if (inherited) return { ...inherited, inherited: true };
  }
  return null;
}
