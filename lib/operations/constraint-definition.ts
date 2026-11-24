type BooleanTree = { atom: string } | { operator: "AND" | "OR"; args: BooleanTree[] };

/** Find a complete parenthesized SQL operand, respecting quoted literals/identifiers. */
function groupEnd(text: string, start: number) {
  if (text[start] !== "(") return -1;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        if (text[index + 1] === quote) index++;
        else quote = undefined;
      }
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index;
  }
  return -1;
}

function booleanTree(input: string): BooleanTree {
  let text = input.trim();
  while (text.startsWith("(") && groupEnd(text, 0) === text.length - 1)
    text = text.slice(1, -1).trim();
  const atom = { atom: text };
  const operands: BooleanTree[] = [];
  let operator: "AND" | "OR" | undefined;
  let cursor = 0;
  while (cursor < text.length) {
    const end = groupEnd(text, cursor);
    if (end < 0) return atom;
    operands.push(booleanTree(text.slice(cursor, end + 1)));
    cursor = end + 1;
    if (cursor === text.length) break;
    const separator = /^\s+(AND|OR)\s+/.exec(text.slice(cursor));
    if (!separator) return atom;
    const nextOperator = separator[1] as "AND" | "OR";
    // Mixed ungrouped operators and other SQL constructs remain opaque.
    if (operator && nextOperator !== operator) return atom;
    operator = nextOperator;
    cursor += separator[0].length;
    if (cursor === text.length) return atom;
  }
  if (!operator || operands.length < 2) return atom;
  return {
    operator,
    args: operands.flatMap((operand) =>
      "operator" in operand && operand.operator === operator ? operand.args : [operand],
    ),
  };
}

/**
 * PostgreSQL dump/restore can flatten nested AND/OR nodes when reparsing CHECKs.
 * Normalize only complete, parenthesized operands of the same Boolean operator.
 * Keep operand order, atomic SQL, mixed operators and validation suffixes intact.
 * No SQL is executed and neither database needs temporary DDL or write access.
 */
export function canonicalConstraintDefinition(definition: string): string {
  const expression = /^CHECK \(([\s\S]*)\)$/.exec(definition)?.[1];
  // Fail closed on escaped/dollar strings or comments; these need a full SQL parser.
  if (expression === undefined || /\\|\$|--|\/\*/.test(expression)) return definition;
  return `CHECK:${JSON.stringify(booleanTree(expression))}`;
}
