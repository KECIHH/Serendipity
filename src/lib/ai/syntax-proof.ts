import { cleanAiOutput } from "./json-parser";

/** Conservative proof: preserve ordered structure and every scalar, allowing only unambiguous formatting. */
function tokens(raw: string): string[] | null {
  if (typeof raw !== "string" || raw.length > 16384 || !raw.isWellFormed()) return null;
  const text = cleanAiOutput(raw);
  const result: string[] = [],
    closing: string[] = [];
  const lexical =
    /"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|'(?:[^'\\\u0000-\u001f]|\\['"\\/bfnrt]|\\u[0-9a-fA-F]{4})*'|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?(?![A-Za-z0-9_.+-])|[A-Za-z_][A-Za-z0-9_]*|[{}\[\]:,]/y;
  for (let offset = 0; offset < text.length; ) {
    if (/[ \t\r\n]/.test(text[offset])) {
      offset++;
      continue;
    }
    lexical.lastIndex = offset;
    const match = lexical.exec(text);
    if (!match) return null;
    const token = match[0];
    offset = lexical.lastIndex;
    if (token === ":" || token === ",") {
      // Existing separators carry key/value and item boundaries. Only a trailing comma is redundant.
      if (token !== "," || !/^\s*[}\]]/.test(text.slice(offset))) result.push(token);
      continue;
    }
    if (token === "{" || token === "[") {
      closing.push(token === "{" ? "}" : "]");
      if (closing.length > 40) return null;
      result.push(token);
    } else if (token === "}" || token === "]") {
      if (closing.pop() !== token) return null;
      result.push(token);
    } else if (token === "null" || token === "true" || token === "false")
      result.push(`literal:${token}`);
    else if (token.startsWith('"')) result.push(`string:${JSON.parse(token) as string}`);
    else if (token.startsWith("'")) {
      // Decode a quoted string without eval and without dropping any content character.
      const body = token.slice(1, -1).replace(/\\'|"/g, (part) => (part === "\\'" ? "'" : '\\"'));
      try {
        result.push(`string:${JSON.parse(`"${body}"`) as string}`);
      } catch {
        return null;
      }
    } else if (/^-?\d/.test(token)) result.push(`number:${token}`);
    else {
      // Bare identifiers are provably keys only when followed by their colon in an object.
      if (closing.at(-1) !== "}" || !/^\s*:/.test(text.slice(offset))) return null;
      result.push(`string:${token}`);
    }
  }
  return [...result, ...closing.reverse()];
}

export function preservesJsonFacts(original: string, repaired: string): boolean {
  try {
    const before = tokens(original),
      after = tokens(repaired);
    if (!before || !after) return false;
    let index = 0;
    for (const token of after) {
      if (token === before[index]) index++;
      else if (token !== ":" && token !== ",") return false;
    }
    if (index !== before.length) return false;
    JSON.parse(cleanAiOutput(repaired));
    return true;
  } catch {
    return false;
  }
}
