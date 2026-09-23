import { relative, resolve } from 'node:path';
import * as ts from 'typescript';

/**
 * Ground truth from the TypeScript compiler: a second, independent implementation of what
 * anvesa extracts and resolves. It sees types, so it knows what `client.send()` really calls;
 * code-lens, which never type-checks, has to work that out from names and imports.
 */

export type SymbolGroup = 'callable' | 'class' | 'interface' | 'type' | 'enum' | 'namespace';

export interface TruthSymbol {
  readonly path: string;
  readonly baseName: string;
  readonly group: SymbolGroup;
  readonly line: number;
}

export type ImportTarget =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'external' }
  /** Should resolve inside the workspace and does not. */
  | { readonly kind: 'unresolved' };

export interface TruthImport {
  readonly path: string;
  readonly specifier: string;
  readonly line: number;
  readonly target: ImportTarget;
}

export type CallTarget =
  /** A declaration anvesa extracts as a symbol. `line` is where the declaration starts. */
  | { readonly kind: 'symbol'; readonly path: string; readonly name: string; readonly line: number }
  /** A declaration in the repository that code-lens does not extract (interface members, ...). */
  | { readonly kind: 'untracked'; readonly why: string }
  /** Declared outside the repository: the runtime's library, or a dependency. */
  | { readonly kind: 'external' }
  /** The compiler could not say either (a value typed `any`, a missing dependency). */
  | { readonly kind: 'unknown' };

export interface TruthCall {
  readonly path: string;
  readonly line: number;
  /** The called name: `send` in `client.send()`. */
  readonly name: string;
  readonly member: boolean;
  readonly target: CallTarget;
}

export interface Truth {
  readonly symbols: readonly TruthSymbol[];
  readonly imports: readonly TruthImport[];
  readonly calls: readonly TruthCall[];
  readonly programMs: number;
  readonly filesInProgram: number;
}

const normalize = (path: string): string => path.replaceAll('\\', '/');

/** Build the ground truth for `files` (repository-relative paths), using the repo's own tsconfig. */
export function buildTruth(root: string, files: readonly string[]): Truth {
  const started = performance.now();
  const configPath = resolve(root, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, root);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
    // The dependencies are not installed, so ambient type packages would only be errors.
    types: [],
    allowJs: true,
  };
  const program = ts.createProgram({
    rootNames: files.map((file) => resolve(root, file)),
    options,
  });
  const checker = program.getTypeChecker();
  const programMs = performance.now() - started;

  const toRepoPath = (absolute: string): string | undefined => {
    const path = normalize(relative(root, absolute));
    return path.startsWith('..') || path.includes('node_modules') ? undefined : path;
  };
  const wanted = new Set(files.map(normalize));

  const symbols: TruthSymbol[] = [];
  const imports: TruthImport[] = [];
  const calls: TruthCall[] = [];
  const cache = ts.createModuleResolutionCache(root, (name) => name, options);

  const pathAliasPatterns = Object.keys(options.paths ?? {}).map((pattern) => {
    const star = pattern.indexOf('*');
    return star === -1
      ? (specifier: string) => specifier === pattern
      : (specifier: string) =>
          specifier.startsWith(pattern.slice(0, star)) &&
          specifier.endsWith(pattern.slice(star + 1));
  });

  function resolveImport(specifier: string, from: ts.SourceFile): ImportTarget {
    const resolved = ts.resolveModuleName(specifier, from.fileName, options, ts.sys, cache);
    const module = resolved.resolvedModule;
    if (module) {
      const repoPath = toRepoPath(module.resolvedFileName);
      return module.isExternalLibraryImport || repoPath === undefined
        ? { kind: 'external' }
        : { kind: 'file', path: repoPath };
    }
    if (specifier.startsWith('.')) {
      // Not a module the compiler knows (a stylesheet, an image): still a file if it exists.
      const asset = toRepoPath(resolve(from.fileName, '..', specifier));
      return asset !== undefined && ts.sys.fileExists(resolve(root, asset))
        ? { kind: 'file', path: asset }
        : { kind: 'unresolved' };
    }
    return pathAliasPatterns.some((matches) => matches(specifier))
      ? { kind: 'unresolved' }
      : { kind: 'external' };
  }

  const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  for (const sf of program.getSourceFiles()) {
    const path = toRepoPath(sf.fileName);
    if (path === undefined || !wanted.has(path)) continue;

    const symbol = (node: ts.Node, name: string, group: SymbolGroup) =>
      symbols.push({ path, baseName: name, group, line: lineOf(sf, node) });
    const importOf = (node: ts.Node, specifier: string) =>
      imports.push({
        path,
        specifier,
        line: lineOf(sf, node),
        target: resolveImport(specifier, sf),
      });

    const visit = (node: ts.Node): void => {
      collectSymbol(node, symbol);
      collectImport(node, importOf);
      collectCall(node, sf, path, checker, program, toRepoPath, resolveImport, calls);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return {
    symbols,
    imports,
    calls,
    programMs,
    filesInProgram: program.getSourceFiles().length,
  };
}

// --- symbols --------------------------------------------------------------------------------------

/** The expression inside any parentheses around it. */
function skipParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

const nameOf = (name: ts.Node | undefined): string | undefined => {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  // A computed name is written as it is in the source: `[Symbol.iterator]`.
  if (ts.isComputedPropertyName(name)) return `[${name.expression.getText()}]`;
  return undefined;
};

function collectSymbol(
  node: ts.Node,
  emit: (node: ts.Node, name: string, group: SymbolGroup) => void,
): void {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    const name = nameOf(node.name);
    if (name !== undefined && node.body !== undefined) emit(node, name, 'callable');
  } else if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    const name = nameOf(node.name);
    if (name !== undefined && node.body !== undefined) emit(node, name, 'callable');
  } else if (ts.isConstructorDeclaration(node)) {
    if (node.body !== undefined) emit(node, 'constructor', 'callable');
  } else if (ts.isClassDeclaration(node)) {
    const name = nameOf(node.name);
    if (name !== undefined) emit(node, name, 'class');
  } else if (ts.isInterfaceDeclaration(node)) {
    emit(node, node.name.text, 'interface');
  } else if (ts.isTypeAliasDeclaration(node)) {
    emit(node, node.name.text, 'type');
  } else if (ts.isEnumDeclaration(node)) {
    emit(node, node.name.text, 'enum');
  } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
    emit(node, node.name.text, 'namespace');
  } else if (ts.isVariableDeclaration(node)) {
    const name = nameOf(node.name);
    const init = node.initializer && skipParentheses(node.initializer);
    if (name !== undefined && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      emit(node, name, 'callable');
    }
  }
}

// --- imports --------------------------------------------------------------------------------------

function collectImport(node: ts.Node, emit: (node: ts.Node, specifier: string) => void): void {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    emit(node, node.moduleSpecifier.text);
  } else if (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    emit(node, node.moduleSpecifier.text);
  } else if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteral(node.moduleReference.expression)
  ) {
    emit(node, node.moduleReference.expression.text);
  } else if (ts.isCallExpression(node)) {
    const [first] = node.arguments;
    const loads =
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require');
    if (
      loads &&
      first &&
      (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
    ) {
      emit(node, first.text);
    }
  }
}

// --- calls ----------------------------------------------------------------------------------------

/** The name a call is made by, and whether it is a member call. `undefined` for anything else. */
function calleeName(
  callee: ts.Expression,
): { name: string; member: boolean; leftmost: ts.Node } | undefined {
  if (ts.isIdentifier(callee)) return { name: callee.text, member: false, leftmost: callee };
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    let leftmost: ts.Expression = callee.expression;
    while (ts.isPropertyAccessExpression(leftmost)) leftmost = leftmost.expression;
    return { name: callee.name.text, member: true, leftmost };
  }
  return undefined;
}

function collectCall(
  node: ts.Node,
  sf: ts.SourceFile,
  path: string,
  checker: ts.TypeChecker,
  program: ts.Program,
  toRepoPath: (absolute: string) => string | undefined,
  resolveImport: (specifier: string, from: ts.SourceFile) => ImportTarget,
  out: TruthCall[],
): void {
  let callee: ts.Expression | undefined;
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) callee = node.expression;
  else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    callee = node.tagName as ts.Expression;
  if (callee === undefined) return;

  // Not references to a symbol, and skipped by code-lens by design.
  if (callee.kind === ts.SyntaxKind.SuperKeyword || callee.kind === ts.SyntaxKind.ImportKeyword)
    return;
  if (ts.isIdentifier(callee) && callee.text === 'require' && ts.isCallExpression(node)) return;

  const called = calleeName(callee);
  if (called === undefined) return;
  const isJsx = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
  if (isJsx && !/^[A-Z]/.test(called.name) && !called.member) return;

  const target = targetOf(node, callee, called, sf, checker, program, toRepoPath, resolveImport);
  out.push({
    path,
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    name: called.name,
    member: called.member,
    target,
  });
}

function targetOf(
  node: ts.Node,
  callee: ts.Expression,
  called: { name: string; member: boolean; leftmost: ts.Node },
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  program: ts.Program,
  toRepoPath: (absolute: string) => string | undefined,
  resolveImport: (specifier: string, from: ts.SourceFile) => ImportTarget,
): CallTarget {
  const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  let symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);

  const declarations: ts.Declaration[] = [];
  // For `new X()` the class is what is named, even when the constructor it runs is inherited.
  if (ts.isCallExpression(node)) {
    const declaration = checker.getResolvedSignature(node)?.declaration;
    if (declaration) declarations.push(declaration);
  }
  declarations.push(...(symbol?.declarations ?? []));

  if (declarations.length === 0) {
    // Nothing declared: a member of something unresolved, or a value from a missing dependency.
    // If the chain starts at an import from outside the repository, the call is external.
    return importedFromOutside(called.leftmost, checker, sf, resolveImport)
      ? { kind: 'external' }
      : { kind: 'unknown' };
  }

  const first = declarations[0] as ts.Declaration;
  const file = first.getSourceFile();
  if (program.isSourceFileDefaultLibrary(file) || program.isSourceFileFromExternalLibrary(file)) {
    return { kind: 'external' };
  }
  const repoPath = toRepoPath(file.fileName);
  if (repoPath === undefined || file.isDeclarationFile) return { kind: 'external' };

  const chosen = declarations.find((candidate) => trackedDeclaration(candidate) !== undefined);
  const tracked = chosen ? trackedDeclaration(chosen) : undefined;
  if (!chosen || !tracked) {
    return { kind: 'untracked', why: ts.SyntaxKind[first.kind] ?? 'declaration' };
  }
  const chosenFile = chosen.getSourceFile();
  const chosenPath = toRepoPath(chosenFile.fileName);
  if (chosenPath === undefined) return { kind: 'external' };
  return {
    kind: 'symbol',
    path: chosenPath,
    name: tracked.name,
    line: chosenFile.getLineAndCharacterOfPosition(tracked.node.getStart(chosenFile)).line + 1,
  };
}

/** Whether the chain's first identifier is bound by an import that resolves outside the repo. */
function importedFromOutside(
  leftmost: ts.Node,
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  resolveImport: (specifier: string, from: ts.SourceFile) => ImportTarget,
): boolean {
  if (!ts.isIdentifier(leftmost)) return false;
  const symbol = checker.getSymbolAtLocation(leftmost);
  for (const declaration of symbol?.declarations ?? []) {
    let current: ts.Node | undefined = declaration;
    while (current && !ts.isImportDeclaration(current)) current = current.parent;
    if (current && ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)) {
      return resolveImport(current.moduleSpecifier.text, sf).kind === 'external';
    }
  }
  return false;
}

/**
 * The declaration code-lens would have extracted as a symbol for this one, or `undefined` when it
 * is something code-lens deliberately does not extract.
 */
function trackedDeclaration(
  declaration: ts.Declaration,
): { node: ts.Node; name: string } | undefined {
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
    const name = nameOf(declaration.name);
    return name !== undefined && declaration.body !== undefined
      ? { node: declaration, name }
      : undefined;
  }
  if (ts.isGetAccessor(declaration) || ts.isSetAccessor(declaration)) {
    const name = nameOf(declaration.name);
    return name !== undefined && declaration.body !== undefined
      ? { node: declaration, name }
      : undefined;
  }
  if (ts.isClassDeclaration(declaration)) {
    const name = nameOf(declaration.name);
    return name !== undefined ? { node: declaration, name } : undefined;
  }
  if (ts.isConstructorDeclaration(declaration) && ts.isClassDeclaration(declaration.parent)) {
    return trackedDeclaration(declaration.parent);
  }
  if (ts.isVariableDeclaration(declaration)) {
    const name = nameOf(declaration.name);
    const init = declaration.initializer && skipParentheses(declaration.initializer);
    return name !== undefined && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
      ? { node: declaration, name }
      : undefined;
  }
  if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
    const parent = declaration.parent;
    return ts.isVariableDeclaration(parent) ? trackedDeclaration(parent) : undefined;
  }
  return undefined;
}
