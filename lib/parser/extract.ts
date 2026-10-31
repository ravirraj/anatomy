import { Node, SyntaxKind, ts, type ImportClause, type SourceFile } from "ts-morph";
import type { EdgeKind, ParsedSymbol, SymbolKind } from "./types.ts";

export type RawImport = {
  kind: EdgeKind;
  line: number;
  typeOnly: boolean;
} & (
  | { literal: true; specifier: string }
  // import(someVariable), require(someVariable): seen and reported, but there is no path to resolve.
  | { literal: false; expression: string }
);

export function extractImports(sourceFile: SourceFile): RawImport[] {
  const found: RawImport[] = [];

  // Static imports and re-exports are only legal at the top level of a module.
  for (const statement of sourceFile.getStatements()) {
    if (Node.isImportDeclaration(statement)) {
      const clause = statement.getImportClause();
      found.push({
        kind: "import",
        literal: true,
        specifier: statement.getModuleSpecifierValue(),
        line: statement.getStartLineNumber(),
        typeOnly: clause ? isTypeOnlyClause(clause) : false,
      });
    } else if (Node.isExportDeclaration(statement)) {
      const specifier = statement.getModuleSpecifierValue();
      if (specifier === undefined) continue; // `export { a }` names a local, not a file
      found.push({
        kind: "re-export",
        literal: true,
        specifier,
        line: statement.getStartLineNumber(),
        typeOnly: statement.isTypeOnly() || allTypeOnly(statement.getNamedExports()),
      });
    } else if (Node.isImportEqualsDeclaration(statement)) {
      // `import x = require("y")` is TypeScript import syntax, not a require() call.
      const reference = statement.getModuleReference();
      if (Node.isExternalModuleReference(reference)) {
        const expression = reference.getExpression();
        if (expression && Node.isStringLiteral(expression)) {
          found.push({
            kind: "import",
            literal: true,
            specifier: expression.getLiteralValue(),
            line: statement.getStartLineNumber(),
            typeOnly: statement.isTypeOnly(),
          });
        }
      }
    }
  }

  // import() and require() can appear anywhere an expression can. The
  // `require` inside `import x = require("y")` above is not a call expression,
  // so nothing here sees it a second time.
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const kind: EdgeKind | null =
      callee.getKind() === SyntaxKind.ImportKeyword
        ? "dynamic-import"
        : Node.isIdentifier(callee) && callee.getText() === "require"
          ? "require"
          : null;
    if (kind === null) continue;
    const [argument] = call.getArguments();
    const line = call.getStartLineNumber();
    if (argument && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))) {
      found.push({ kind, literal: true, specifier: argument.getLiteralValue(), line, typeOnly: false });
    } else {
      found.push({ kind, literal: false, expression: argument ? argument.getText() : "", line, typeOnly: false });
    }
  }

  return found;
}

/** What `module.exports = <value>` is called when the value's own names can't all be read. */
export const WHOLE_MODULE = "module.exports";

/**
 * The names a file exports, read from its own syntax: ESM export statements at
 * the top level, and CommonJS assignments to module.exports or exports
 * wherever they appear. Source order, each name once.
 */
export type RawImportBinding = {
  /** Local name the module is bound to in this file. */
  local: string;
  /** Name exported by the source module ("default" for default imports). */
  imported: string;
  /** Module specifier as written. */
  specifier: string;
  kind: "named" | "default" | "namespace";
  line: number;
};

/**
 * The names a file imports from other modules, as written. Resolution to a
 * target file happens in the parser (resolve.ts), so this stays pure syntax.
 */
export function extractImportBindings(sourceFile: SourceFile): RawImportBinding[] {
  const found: RawImportBinding[] = [];
  for (const statement of sourceFile.getStatements()) {
    if (!Node.isImportDeclaration(statement)) continue;
    const specifier = statement.getModuleSpecifierValue();
    const clause = statement.getImportClause();
    if (!clause) continue;
    const line = statement.getStartLineNumber();
    const defaultImport = clause.getDefaultImport();
    if (defaultImport) {
      found.push({ local: defaultImport.getText(), imported: "default", specifier, kind: "default", line });
    }
    const namespaceImport = clause.getNamespaceImport();
    if (namespaceImport) {
      found.push({ local: namespaceImport.getText(), imported: "*", specifier, kind: "namespace", line });
    }
    for (const named of clause.getNamedImports()) {
      const imported = named.getNameNode().getText();
      const local = named.getAliasNode()?.getText() ?? imported;
      found.push({ local, imported, specifier, kind: "named", line });
    }
  }
  return found;
}

export function extractExports(sourceFile: SourceFile): string[] {
  const found: { name: string; at: number }[] = [];
  const add = (name: string, at: Node) => found.push({ name, at: at.getStart() });

  for (const statement of sourceFile.getStatements()) {
    if (Node.isExportDeclaration(statement)) {
      // `export * from` names nothing here; `export * as ns from` names ns.
      const namespace = statement.getNamespaceExport();
      if (namespace) add(namespace.getName(), statement);
      for (const specifier of statement.getNamedExports()) {
        add(specifier.getAliasNode()?.getText() ?? specifier.getName(), specifier);
      }
    } else if (Node.isExportAssignment(statement)) {
      // `export = x` is TypeScript's spelling of module.exports = x.
      if (statement.isExportEquals()) addWholeModule(statement.getExpression(), add);
      else add("default", statement);
    } else if (Node.isVariableStatement(statement)) {
      if (!statement.hasExportKeyword()) continue;
      for (const declaration of statement.getDeclarations()) {
        const name = declaration.getNameNode();
        if (Node.isIdentifier(name)) add(name.getText(), name);
        // `export const { a, b: c } = x` exports a and c.
        else for (const element of name.getDescendantsOfKind(SyntaxKind.BindingElement)) {
          const bound = element.getNameNode();
          if (Node.isIdentifier(bound)) add(bound.getText(), bound);
        }
      }
    } else if (
      Node.isFunctionDeclaration(statement) ||
      Node.isClassDeclaration(statement) ||
      Node.isInterfaceDeclaration(statement) ||
      Node.isTypeAliasDeclaration(statement) ||
      Node.isEnumDeclaration(statement) ||
      Node.isModuleDeclaration(statement) ||
      Node.isImportEqualsDeclaration(statement)
    ) {
      if (!statement.hasExportKeyword()) continue;
      if (statement.hasDefaultKeyword()) {
        add("default", statement);
        continue;
      }
      const name = statement.getNameNode();
      // `declare module "x"` is named by a string and exports nothing from this file.
      if (name && Node.isIdentifier(name)) add(name.getText(), name);
    }
  }

  for (const assignment of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    const target = assignment.getLeft();
    if (isModuleExports(target)) {
      addWholeModule(assignment.getRight(), add);
      continue;
    }
    // module.exports.name = …, exports.name = …, and the ["name"] forms.
    if (Node.isPropertyAccessExpression(target) || Node.isElementAccessExpression(target)) {
      const object = target.getExpression();
      if (!isModuleExports(object) && !(Node.isIdentifier(object) && object.getText() === "exports")) continue;
      const name = Node.isPropertyAccessExpression(target) ? target.getName() : literalText(target.getArgumentExpression());
      if (name !== null) add(name, target);
    }
  }

  // Object.defineProperty(exports, "name", …) is how compiled CommonJS writes
  // them. "__esModule" is the compiler's own marker, not something exported.
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== "Object.defineProperty") continue;
    const [object, key] = call.getArguments();
    if (!object || !(isModuleExports(object) || object.getText() === "exports")) continue;
    const name = literalText(key);
    if (name !== null && name !== "__esModule") add(name, call);
  }

  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.name))];
}

/**
 * The top-level declarations a file makes, definitions rather than only the
 * exports: a helper no one imports is a symbol too, and `exported` says which
 * it is. Source order, each declaration once. CommonJS assignment isn't a
 * declaration, so it makes no symbol here; the names it exports are already
 * in extractExports.
 */
function jsDocText(node: Node): string | undefined {
  // ts-morph exposes getJsDocs on declarations that can carry JSDoc.
  const docs = (node as { getJsDocs?: () => { getInnerText(): string }[] }).getJsDocs?.();
  if (!docs || docs.length === 0) return undefined;
  const text = docs.map((d) => d.getInnerText().trim()).filter(Boolean).join("\n").trim();
  return text.length > 0 ? text : undefined;
}

function paramType(p: { getTypeNode?: () => Node | undefined; getType?: () => { getText: () => string } }): string {
  const node = p.getTypeNode?.();
  if (node) return node.getText();
  try { return p.getType?.()?.getText() ?? "unknown"; } catch { return "unknown"; }
}

function enrichDeclaration(
  name: string,
  kind: SymbolKind,
  node: Node,
  exported: boolean,
  defaultExport: boolean,
): Omit<ParsedSymbol, "file"> {
  const out: Omit<ParsedSymbol, "file"> = {
    name,
    kind,
    line: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
    exported,
    exportKind: defaultExport ? "default" : exported ? "named" : "none",
  };
  const doc = jsDocText(node);
  if (doc) out.documentation = doc;

  // Function-like declarations carry parameters and a return type.
  const fnLike = node as {
    getParameters?: () => { getName(): string; getTypeNode?: () => Node | undefined; getType?: () => { getText: () => string } }[];
    getReturnTypeNode?: () => Node | undefined;
    getReturnType?: () => { getText: () => string };
  };
  if (typeof fnLike.getParameters === "function") {
    const params = fnLike.getParameters().map((p) => ({ name: p.getName(), type: paramType(p) }));
    out.parameters = params;
    let rt: string | undefined;
    if (typeof fnLike.getReturnTypeNode === "function") rt = fnLike.getReturnTypeNode()?.getText();
    if (!rt && typeof fnLike.getReturnType === "function") {
      try { rt = fnLike.getReturnType().getText(); } catch { rt = undefined; }
    }
    if (rt) out.returnType = rt;
    const paramText = params.map((p) => `${p.name}: ${p.type}`).join(", ");
    out.signature = `${name}(${paramText})${rt ? `: ${rt}` : ""}`;
  } else {
    // Non-function declarations: signature is the first line, trimmed.
    const firstLine = node.getText().split("\n")[0]?.trim();
    if (firstLine) out.signature = firstLine.length > 200 ? firstLine.slice(0, 200) + "…" : firstLine;
  }

  return out;
}

export function extractSymbols(sourceFile: SourceFile): Omit<ParsedSymbol, "file">[] {
  const found: Omit<ParsedSymbol, "file">[] = [];

  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement) || Node.isClassDeclaration(statement) || Node.isInterfaceDeclaration(statement) || Node.isTypeAliasDeclaration(statement) || Node.isEnumDeclaration(statement)) {
      const exported = statement.hasExportKeyword();
      const kind: SymbolKind = Node.isFunctionDeclaration(statement)
        ? "function"
        : Node.isClassDeclaration(statement)
          ? "class"
          : Node.isInterfaceDeclaration(statement)
            ? "interface"
            : Node.isTypeAliasDeclaration(statement)
              ? "type"
              : "enum";
      if (statement.hasDefaultKeyword()) {
        found.push(enrichDeclaration("default", kind, statement, true, true));
        continue;
      }
      const name = statement.getNameNode();
      if (name) found.push(enrichDeclaration(name.getText(), kind, statement, exported, false));
    } else if (Node.isModuleDeclaration(statement) && Node.isIdentifier(statement.getNameNode())) {
      found.push(enrichDeclaration(statement.getName(), "namespace", statement, statement.hasExportKeyword(), false));
    } else if (Node.isVariableStatement(statement)) {
      const exported = statement.hasExportKeyword();
      const kind: SymbolKind = statement.getDeclarationList().getFlags() & ts.NodeFlags.Const
        ? "const"
        : statement.getDeclarationList().getFlags() & ts.NodeFlags.Let
          ? "let"
          : "var";
      for (const declaration of statement.getDeclarations()) {
        const name = declaration.getNameNode();
        if (Node.isIdentifier(name)) {
          found.push(enrichDeclaration(name.getText(), kind, declaration, exported, false));
        } else {
          for (const element of name.getDescendantsOfKind(SyntaxKind.BindingElement)) {
            const bound = element.getNameNode();
            if (Node.isIdentifier(bound)) {
              found.push(enrichDeclaration(bound.getText(), kind, element, exported, false));
            }
          }
        }
      }
    }
  }

  return found;
}

// `module.exports = <value>` exports a and b. Anything else, including an
// object with a spread or a computed key, is one value whose names aren't all
// written here, so it's recorded as that value rather than as a partial list.
function addWholeModule(value: Node, add: (name: string, at: Node) => void): void {
  if (Node.isObjectLiteralExpression(value)) {
    const names: { name: string; at: Node }[] = [];
    for (const property of value.getProperties()) {
      if (Node.isSpreadAssignment(property)) return add(WHOLE_MODULE, value);
      const nameNode = property.getNameNode();
      const name = Node.isIdentifier(nameNode) ? nameNode.getText() : literalText(nameNode);
      if (name === null) return add(WHOLE_MODULE, value);
      names.push({ name, at: property });
    }
    for (const n of names) add(n.name, n.at);
    return;
  }
  add(WHOLE_MODULE, value);
}

function isModuleExports(node: Node): boolean {
  return (
    Node.isPropertyAccessExpression(node) &&
    node.getName() === "exports" &&
    Node.isIdentifier(node.getExpression()) &&
    node.getExpression().getText() === "module"
  );
}

function literalText(node: Node | undefined): string | null {
  if (node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))) return node.getLiteralValue();
  return null;
}

export type RawCall = {
  /** Callee expression text as written, e.g. "foo", "obj.method", "new Bar". */
  callee: string;
  line: number;
  constructor: boolean;
};

/**
 * Call sites in a file: every CallExpression and NewExpression, except the
 * import()/require() calls already captured by extractImports. Nested calls
 * are recorded individually. The enclosing caller symbol and the target file
 * are resolved by the parser afterwards.
 */
export function extractCalls(sourceFile: SourceFile): RawCall[] {
  const found: RawCall[] = [];
  const seen = new Set<string>();
  const add = (callee: string, line: number, constructor: boolean) => {
    const key = `${callee}\\0${line}\\0${constructor}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ callee, line, constructor });
  };

  for (const ne of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    add(ne.getExpression().getText(), ne.getStartLineNumber(), true);
  }
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (callee.getKind() === SyntaxKind.ImportKeyword) continue;
    if (Node.isIdentifier(callee) && callee.getText() === "require") continue;
    add(callee.getText(), call.getStartLineNumber(), false);
  }

  found.sort((a, b) => a.line - b.line);
  return found;
}

function isTypeOnlyClause(clause: ImportClause): boolean {
  if (clause.isTypeOnly()) return true;
  // `import { type A, type B } from` erases entirely; one value binding keeps it.
  if (clause.getDefaultImport() || clause.getNamespaceImport()) return false;
  return allTypeOnly(clause.getNamedImports());
}

function allTypeOnly(specifiers: { isTypeOnly(): boolean }[]): boolean {
  return specifiers.length > 0 && specifiers.every((specifier) => specifier.isTypeOnly());
}
