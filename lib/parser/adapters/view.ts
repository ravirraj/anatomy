// Phase 5 Batch 3.1: the JS/TS builder for the language-neutral FrameworkView.
//
// The view is the handover between the parser and the framework adapters: it
// extracts exactly the syntactic facts the current adapters read (imports and
// their bindings, exports, declarations and decorators, app/router
// registrations, config object properties, directives, JSX), described in the
// language-neutral vocabulary of types.ts. ts-morph is used here, inside the
// builder only — it never appears in the view's types.
//
// Nothing is evaluated or executed. A value the syntax doesn't pin down
// becomes `kind: "other"`; a name the syntax doesn't write is skipped, not
// guessed. Output is deterministic: same input, same view.

import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type CallExpression,
  type Decorator,
  type Node as TsNode,
  type ObjectLiteralExpression,
  type SourceFile,
} from "ts-morph";
import { detectLanguage } from "../../ir/languages.ts";
import type { EdgeKind, ImportStatus } from "../types.ts";
import { withinProject } from "../walk.ts";
import {
  FRAMEWORK_VIEW_VERSION,
  type FrameworkView,
  type ViewCall,
  type ViewDeclaration,
  type ViewDecorator,
  type ViewExport,
  type ViewFile,
  type ViewImport,
  type ViewImportBinding,
  type ViewProperty,
  type ViewResolution,
  type ViewSkippedFile,
  type ViewValue,
} from "./types.ts";

// Beyond this nesting depth an object literal's properties degrade to
// "other": bounded work, no information the adapters could use is lost
// (they never look more than two levels deep).
const VIEW_DEPTH_LIMIT = 8;

export type ViewSourceEntry = {
  /** Repository-relative path. */
  path: string;
  /** Absolute path, for the resolver. */
  absolutePath: string;
  source: SourceFile;
};

export type FrameworkViewInput = {
  /** The project the view is scoped to: "." for the repository root, else the project's repository-relative directory. */
  project: string;
  /** Parsed files of this one project, repository-relative paths. */
  files: readonly ViewSourceEntry[];
  /** Skipped code files of this one project, repository-relative. */
  skipped: readonly ViewSkippedFile[];
  /** The parser's specifier resolver (createResolver in lib/parser/resolve.ts). */
  resolveSpecifier: (fromAbsolute: string, specifier: string, kind: EdgeKind) => ImportStatus;
};

export function buildFrameworkView(input: FrameworkViewInput): FrameworkView {
  return {
    viewVersion: FRAMEWORK_VIEW_VERSION,
    project: input.project,
    files: [...input.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((entry) => viewFile(input.project, entry, input.resolveSpecifier)),
    skipped: [...input.skipped]
      .map((file) => ({ path: withinProject(input.project, file.path), reason: file.reason }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function viewFile(project: string, entry: ViewSourceEntry, resolve: FrameworkViewInput["resolveSpecifier"]): ViewFile {
  const source = entry.source;
  return {
    path: withinProject(project, entry.path),
    language: detectLanguage(entry.path),
    directives: collectDirectives(source),
    flags: { jsx: hasJsx(source) },
    imports: collectImports(entry, resolve),
    exports: collectExports(source),
    declarations: collectDeclarations(source),
    calls: collectCalls(source),
    objectProperties: collectObjectProperties(source),
  };
}

// ---- Imports ----

function collectImports(entry: ViewSourceEntry, resolve: FrameworkViewInput["resolveSpecifier"]): ViewImport[] {
  const found: ViewImport[] = [];
  const push = (
    specifier: string,
    kind: ViewImport["kind"],
    line: number,
    bindings: readonly ViewImportBinding[],
    extra?: { importEquals?: boolean },
  ) => {
    found.push({
      specifier,
      kind,
      line,
      resolution: viewResolution(resolve(entry.absolutePath, specifier, kind)),
      bindings: [...bindings],
      ...extra,
    });
  };

  for (const statement of entry.source.getStatements()) {
    if (Node.isImportDeclaration(statement)) {
      const bindings: ViewImportBinding[] = [];
      const clause = statement.getImportClause();
      if (clause) {
        const def = clause.getDefaultImport();
        if (def) bindings.push({ local: def.getText(), imported: "default", defaultSlot: true });
        const namespace = clause.getNamespaceImport();
        if (namespace) bindings.push({ local: namespace.getText(), imported: "*" });
        for (const named of clause.getNamedImports()) {
          bindings.push({ local: named.getAliasNode()?.getText() ?? named.getName(), imported: named.getName() });
        }
      }
      push(statement.getModuleSpecifierValue(), "import", statement.getStartLineNumber(), bindings);
    } else if (Node.isImportEqualsDeclaration(statement)) {
      // `import x = require("./m")` — TypeScript's CommonJS interop spelling.
      // ts-morph exposes the reference's expression as the module specifier
      // literal itself (no require-call wrapper), so it never double-counts
      // in the require() scan below.
      const reference = statement.getModuleReference();
      if (!Node.isExternalModuleReference(reference)) continue; // `import x = Ns.Deep` is internal syntax, not a module import
      const specifier = literalText(reference.getExpression());
      if (specifier === null) continue;
      push(specifier, "import", statement.getStartLineNumber(), [{ local: statement.getName(), imported: "*" }], {
        importEquals: true,
      });
    }
  }

  // CommonJS require() and literal dynamic import(), wherever they appear —
  // a require inside a function binds a local name just the same.
  for (const call of entry.source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (Node.isIdentifier(callee) && callee.getText() === "require") {
      const specifier = literalText(call.getArguments()[0]);
      if (specifier === null) continue; // a computed path has nothing to resolve
      push(specifier, "require", call.getStartLineNumber(), requireBindings(call));
    } else if (callee.getKind() === SyntaxKind.ImportKeyword) {
      const specifier = literalText(call.getArguments()[0]);
      if (specifier === null) continue;
      push(specifier, "dynamic-import", call.getStartLineNumber(), []);
    }
  }

  return found;
}

/** The local names a require() call binds, read off the variable declaration it initializes, if any. */
function requireBindings(call: CallExpression): ViewImportBinding[] {
  const declaration = call.getParentIfKind(SyntaxKind.VariableDeclaration);
  if (!declaration) return []; // a bare require() executes the module and binds nothing
  const nameNode = declaration.getNameNode();
  if (Node.isIdentifier(nameNode)) return [{ local: nameNode.getText(), imported: "default" }];
  if (!Node.isObjectBindingPattern(nameNode)) return []; // array destructuring binds nothing the adapters read
  const bindings: ViewImportBinding[] = [];
  for (const element of nameNode.getElements()) {
    const exported = element.getPropertyNameNode() ?? element.getNameNode();
    const imported = Node.isStringLiteral(exported)
      ? exported.getLiteralValue()
      : Node.isIdentifier(exported)
        ? exported.getText()
        : null;
    // A computed key names nothing statically, but the local binding is
    // written: the Express adapter traces mounts through that local name, so
    // the element is recorded with an unknown imported name rather than
    // dropped.
    bindings.push({ local: element.getNameNode().getText(), imported });
  }
  return bindings;
}

function viewResolution(outcome: ImportStatus): ViewResolution {
  switch (outcome.status) {
    case "internal":
      return { status: "internal", target: outcome.target };
    case "external":
      return { status: "external", external: outcome.external };
    case "excluded":
      return { status: "excluded" };
    case "unresolved":
      return { status: "unresolved" };
  }
}

// ---- Exports ----

function collectExports(source: SourceFile): ViewExport[] {
  const found: ViewExport[] = [];
  for (const statement of source.getStatements()) {
    if (Node.isExportDeclaration(statement)) {
      const line = statement.getStartLineNumber();
      // `export * as ns from "./m"` names the namespace; a bare `export *`
      // hides every name behind it.
      const namespace = statement.getNamespaceExport();
      if (namespace) found.push({ form: "alias", name: namespace.getName(), line });
      else if (statement.isNamespaceExport()) found.push({ form: "star", line });
      // `export { handler as GET }`, with or without a module specifier.
      for (const specifier of statement.getNamedExports()) {
        found.push({
          form: "alias",
          name: specifier.getAliasNode()?.getText() ?? specifier.getName(),
          line: specifier.getStartLineNumber(),
        });
      }
    } else if (Node.isVariableStatement(statement) && statement.hasExportKeyword() && !statement.hasDefaultKeyword()) {
      // `export const GET = …` and `export const { GET, POST } = handlers`.
      for (const declaration of statement.getDeclarations()) {
        const binding = declaration.getNameNode();
        if (Node.isIdentifier(binding)) {
          found.push({ form: "declaration", name: binding.getText(), kind: "variable", line: declaration.getStartLineNumber() });
        } else if (Node.isObjectBindingPattern(binding)) {
          for (const element of binding.getElements()) {
            if (Node.isIdentifier(element.getNameNode())) {
              found.push({
                form: "declaration",
                name: element.getNameNode().getText(),
                kind: "variable",
                line: element.getStartLineNumber(),
              });
            }
          }
        }
      }
    } else if (Node.isFunctionDeclaration(statement) && statement.hasExportKeyword() && !statement.hasDefaultKeyword()) {
      const name = statement.getName();
      if (name) found.push({ form: "declaration", name, kind: "function", line: statement.getStartLineNumber() });
    }
  }
  return found;
}

// ---- Declarations ----

function collectDeclarations(source: SourceFile): ViewDeclaration[] {
  const found: ViewDeclaration[] = [];

  // Classes and their methods: the surface the NestJS adapter reads. The
  // qualified name carries the scope, as the parser's symbols do.
  for (const cls of source.getClasses()) {
    const name = cls.getName();
    if (name === undefined) continue; // an anonymous class binds nothing by name
    found.push({
      name,
      kind: "class",
      line: cls.getStartLineNumber(),
      decorators: collectDecorators(cls.getDecorators()),
      initializerCall: null,
    });
    for (const method of cls.getMethods()) {
      const methodName = method.getNameNode();
      if (!Node.isIdentifier(methodName)) continue; // a computed method name is not a static name
      found.push({
        name: `${name}.${methodName.getText()}`,
        kind: "function", // methods persist as functions in the parser's lexicon
        line: method.getStartLineNumber(),
        decorators: collectDecorators(method.getDecorators()),
        initializerCall: null,
      });
    }
  }

  // Variables with an identifier name, at any depth — an app or router can be
  // declared inside a function too. The initializer's callee is the fact the
  // Express adapter keys on; binding patterns are the import collectors' job.
  for (const declaration of source.getVariableDeclarations()) {
    const nameNode = declaration.getNameNode();
    if (!Node.isIdentifier(nameNode)) continue;
    const list = declaration.getParentOrThrow();
    if (!Node.isVariableDeclarationList(list)) continue;
    const initializer = declaration.getInitializer();
    const initializerCallNode = initializer && Node.isCallExpression(initializer) ? initializer.getExpression() : null;
    found.push({
      name: nameNode.getText(),
      kind:
        list.getDeclarationKind() === VariableDeclarationKind.Const
          ? "const"
          : list.getDeclarationKind() === VariableDeclarationKind.Let
            ? "let"
            : "var",
      line: declaration.getStartLineNumber(),
      decorators: [],
      initializerCall: initializerCallNode ? initializerCallNode.getText() : null,
      ...(initializerCallNode && { initializerCallee: calleeParts(initializerCallNode) }),
    });
  }

  return found;
}

/**
 * The structural callee pair the adapters read: a plain-identifier callee is
 * `{ receiver, member: null }`; a `receiver.member` / `receiver?.member`
 * access over a plain identifier is `{ receiver, member }`; anything else
 * (chained, parenthesised, element access, a call result) is
 * `{ receiver: null, member: null }`. Node names, never source text, so
 * comment trivia between the parts cannot leak in.
 */
function calleeParts(callee: TsNode): { receiver: string | null; member: string | null } {
  if (Node.isIdentifier(callee)) return { receiver: callee.getText(), member: null };
  if (Node.isPropertyAccessExpression(callee) && Node.isIdentifier(callee.getExpression())) {
    return { receiver: callee.getExpression().getText(), member: callee.getName() };
  }
  return { receiver: null, member: null };
}

function collectDecorators(decorators: readonly Decorator[]): ViewDecorator[] {
  return decorators.map((decorator) => {
    const call = decorator.getCallExpression();
    return {
      // The callee as written: "Controller", "ns.Controller" — the adapter
      // resolves aliases through its own imports.
      name: call ? call.getExpression().getText() : decorator.getExpression().getText(),
      arguments: (call?.getArguments() ?? []).map((argument) => viewValue(argument, 0)),
      line: decorator.getStartLineNumber(),
    };
  });
}

// ---- Calls ----

function collectCalls(source: SourceFile): ViewCall[] {
  const found: ViewCall[] = [];
  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    // Receiver.method(...) only: the framework registration shape. Bare
    // identifier calls have no framework consumer (an app/router factory is
    // read off its variable's initializer), and require()/import() are
    // collected as imports.
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const receiverNode = callee.getExpression();
    found.push({
      callee: callee.getText(),
      receiver: Node.isIdentifier(receiverNode) ? receiverNode.getText() : null,
      member: callee.getName(),
      arguments: call.getArguments().map((argument) => viewValue(argument, 0)),
      line: call.getStartLineNumber(),
    });
  }
  return found;
}

// ---- Directives, JSX, config objects ----

/** The leading run of string-literal expression statements — the directive prologue, exactly what the adapters scan. */
function collectDirectives(source: SourceFile): string[] {
  const values: string[] = [];
  for (const statement of source.getStatements()) {
    if (!Node.isExpressionStatement(statement)) break;
    const expression = statement.getExpression();
    if (!Node.isStringLiteral(expression)) break;
    values.push(expression.getLiteralValue());
  }
  return values;
}

function hasJsx(source: SourceFile): boolean {
  return (
    source.getFirstDescendant((node) =>
      Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node),
    ) !== undefined
  );
}

/**
 * Properties of the object literals a config file is written as: a top-level
 * variable's initializer, `module.exports = { … }` and `export default { … }`.
 * Object literals inside decorators and calls reach the view through those
 * arguments instead, so this stays the config-object surface only.
 */
function collectObjectProperties(source: SourceFile): ViewProperty[] {
  const found: ViewProperty[] = [];
  const push = (literal: ObjectLiteralExpression) => found.push(...objectProperties(literal, 0));

  for (const statement of source.getStatements()) {
    if (Node.isVariableStatement(statement)) {
      for (const declaration of statement.getDeclarations()) {
        const initializer = declaration.getInitializer();
        if (initializer && Node.isObjectLiteralExpression(initializer)) push(initializer);
      }
    } else if (Node.isExportAssignment(statement)) {
      const expression = statement.getExpression();
      if (Node.isObjectLiteralExpression(expression)) push(expression);
    } else if (Node.isExpressionStatement(statement)) {
      const expression = statement.getExpression();
      if (
        Node.isBinaryExpression(expression) &&
        expression.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
        isModuleExports(expression.getLeft())
      ) {
        const right = expression.getRight();
        if (Node.isObjectLiteralExpression(right)) push(right);
      }
    }
  }
  return found;
}

/** `module.exports` (the whole module), as written: property access, or the bracket spellings of the same thing. */
function isModuleExports(node: TsNode): boolean {
  if (Node.isPropertyAccessExpression(node)) {
    return node.getExpression().getText() === "module" && node.getName() === "exports";
  }
  if (Node.isElementAccessExpression(node)) {
    const object = node.getExpression();
    const argument = node.getArgumentExpression();
    return (
      (object.getText() === "module" || object.getText() === "exports") &&
      argument !== undefined &&
      literalText(argument) === "exports"
    );
  }
  return false;
}

function objectProperties(literal: ObjectLiteralExpression, depth: number): ViewProperty[] {
  const found: ViewProperty[] = [];
  for (const property of literal.getProperties()) {
    const line = property.getStartLineNumber();
    if (Node.isPropertyAssignment(property)) {
      const nameNode = property.getNameNode();
      if (Node.isComputedPropertyName(nameNode)) continue; // a computed key is not a static name
      found.push({ name: nameNode.getText().replace(/^["']|["']$/g, ""), value: viewValue(property.getInitializer(), depth), line });
    } else if (Node.isShorthandPropertyAssignment(property)) {
      // `{ basePath }` binds the name it is written as — the same fact an
      // identifier value would carry.
      found.push({ name: property.getName(), value: { kind: "identifier", name: property.getName() }, line });
    }
    // Spread assignments and computed keys bind no static name: skipped.
  }
  return found;
}

// ---- Values ----

function viewValue(expression: TsNode | undefined, depth: number): ViewValue {
  if (!expression || depth > VIEW_DEPTH_LIMIT) return { kind: "other" };
  if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
    return { kind: "string", value: expression.getLiteralValue() };
  }
  if (Node.isArrayLiteralExpression(expression)) {
    const elements = expression.getElements().map((element) => literalText(element));
    // An array every element of which is a string literal is the shape the
    // adapters read as several paths; anything else is unknown as a whole.
    return elements.every((value) => value !== null)
      ? { kind: "string-array", values: elements as string[] }
      : { kind: "other" };
  }
  if (Node.isIdentifier(expression)) return { kind: "identifier", name: expression.getText() };
  if (Node.isObjectLiteralExpression(expression)) {
    return { kind: "object", properties: objectProperties(expression, depth + 1) };
  }
  // Numbers, booleans, calls, member expressions, templates with
  // substitutions, spreads: unknown, never evaluated.
  return { kind: "other" };
}

/** A string literal or no-substitution template's value, else null. The adapters' own `literalString`. */
function literalText(node: TsNode | undefined): string | null {
  if (!node) return null;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
  return null;
}
