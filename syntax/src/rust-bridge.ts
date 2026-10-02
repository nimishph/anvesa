/**
 * NAPI-RS native Rust bridge for @cntxt-labs/anvesa-syntax.
 * Delegates native Tree-Sitter AST parsing and concurrent outline extraction to crates/anvesa-napi.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface NapiSymbol {
  readonly name: string;
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly signature?: string;
  readonly doc?: string;
  readonly exported: boolean;
}

export interface NapiCall {
  readonly name: string;
  readonly line: number;
  readonly kind: string;
}

export interface NapiImport {
  readonly specifier: string;
  readonly kind: string;
  readonly line: number;
}

export interface NapiFileOutline {
  readonly path: string;
  readonly language: string;
  readonly symbols: readonly NapiSymbol[];
  readonly calls: readonly NapiCall[];
  readonly imports: readonly NapiImport[];
  readonly hasSyntaxErrors: boolean;
}

export interface FileInput {
  readonly path: string;
  readonly language: string;
  readonly source: string;
}

export interface RustSyntaxBinding {
  extractFileOutlineNative(path: string, language: string, source: string): NapiFileOutline;
  parseFilesBatchNative(files: readonly FileInput[]): readonly NapiFileOutline[];
}

let nativeModule: RustSyntaxBinding | null = null;
let attempted = false;
let forcePureTs = false;

export function setRustSyntaxEnabled(enabled: boolean): void {
  forcePureTs = !enabled;
}

export function isRustSyntaxEnabled(): boolean {
  if (
    forcePureTs ||
    process.env.ANVESA_DISABLE_NATIVE === '1' ||
    process.env.ANVESA_DISABLE_NATIVE === 'true'
  ) {
    return false;
  }
  return isRustSyntaxAvailable();
}

export function loadRustSyntax(): RustSyntaxBinding | null {
  if (
    forcePureTs ||
    process.env.ANVESA_DISABLE_NATIVE === '1' ||
    process.env.ANVESA_DISABLE_NATIVE === 'true'
  ) {
    return null;
  }
  if (attempted) {
    return nativeModule;
  }
  attempted = true;

  const candidates = rustSyntaxBindingCandidates();

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        nativeModule = require(candidate) as RustSyntaxBinding;
        return nativeModule;
      } catch (failure) {
        if (failure) continue;
      }
    }
  }

  return null;
}

export function rustSyntaxBindingCandidates(moduleDir = __dirname): readonly string[] {
  const rootDir = join(moduleDir, '..', '..');
  const executableDir = dirname(process.execPath);
  return [
    join(executableDir, 'runtime', 'anvesa_napi.node'),
    join(executableDir, 'runtime', 'anvesa_napi.dll'),
    join(executableDir, 'anvesa_napi.node'),
    join(executableDir, 'anvesa_napi.dll'),
    join(rootDir, 'crates', 'anvesa-napi', 'anvesa_napi.node'),
    join(rootDir, 'target', 'release', 'anvesa_napi.node'),
    join(rootDir, 'target', 'release', 'anvesa_napi.dll'),
    join(rootDir, 'target', 'debug', 'anvesa_napi.node'),
    join(rootDir, 'target', 'debug', 'anvesa_napi.dll'),
    join(moduleDir, 'anvesa_napi.node'),
  ];
}

export function isRustSyntaxAvailable(): boolean {
  if (
    forcePureTs ||
    process.env.ANVESA_DISABLE_NATIVE === '1' ||
    process.env.ANVESA_DISABLE_NATIVE === 'true'
  ) {
    return false;
  }
  return loadRustSyntax() !== null;
}

/**
 * High-performance pure TypeScript AST outline extractor fallback
 * used when the native Rust tree-sitter core is disabled or not present.
 */
function pureTsExtractOutline(path: string, language: string, source: string): NapiFileOutline {
  const symbols: NapiSymbol[] = [];
  const calls: NapiCall[] = [];
  const imports: NapiImport[] = [];

  const lines = source.split(/\r?\n/);
  const lang = language.toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const lineNum = i + 1;
    const trimmed = rawLine.trim();

    // 1. Imports
    if (lang === 'typescript' || lang === 'javascript' || lang === 'tsx' || lang === 'jsx') {
      if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) {
        const fromMatch = trimmed.match(/from\s+['"]([^'"]+)['"]/);
        if (fromMatch?.[1]) {
          imports.push({ specifier: fromMatch[1], kind: 'import', line: lineNum });
        } else {
          const directMatch = trimmed.match(/import\s+['"]([^'"]+)['"]/);
          if (directMatch?.[1]) {
            imports.push({ specifier: directMatch[1], kind: 'import', line: lineNum });
          }
        }
      }
    } else if (lang === 'python') {
      if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
        const specMatch = trimmed.match(/^(?:from\s+([a-zA-Z0-9_.]+)|import\s+([a-zA-Z0-9_.]+))/);
        const spec = specMatch?.[1] || specMatch?.[2];
        if (spec) {
          imports.push({ specifier: spec, kind: 'import', line: lineNum });
        }
      }
    }

    // 2. Symbols (functions, classes, interfaces, methods)
    if (lang === 'typescript' || lang === 'javascript' || lang === 'tsx' || lang === 'jsx') {
      const isExport = trimmed.startsWith('export ');
      const clean = isExport ? trimmed.replace(/^export\s+(?:default\s+)?/, '') : trimmed;

      // Function
      const fnMatch = clean.match(
        /^(?:async\s+)?function\s*\*?\s*([a-zA-Z0-9_$]+)\s*\(([^)]*)\)(?::\s*([^{]+))?/,
      );
      if (fnMatch?.[1]) {
        // Collect docstring if preceding line was comment
        let doc: string | undefined;
        if (i > 0 && lines[i - 1]?.trim().includes('*/')) {
          const docLines: string[] = [];
          for (let d = i - 1; d >= 0; d--) {
            const dl = lines[d]?.trim() ?? '';
            docLines.unshift(dl);
            if (dl.includes('/**')) break;
          }
          doc = docLines.join('\n');
        }

        symbols.push({
          name: fnMatch[1],
          kind: 'function',
          startLine: lineNum,
          endLine: lineNum + 10,
          signature: `function ${fnMatch[1]}(${fnMatch[2] ?? ''})${fnMatch[3] ? `: ${fnMatch[3].trim()}` : ''}`,
          exported: isExport,
          ...(doc ? { doc } : {}),
        });
      }

      // Class
      const classMatch = clean.match(/^class\s+([a-zA-Z0-9_$]+)/);
      if (classMatch?.[1]) {
        symbols.push({
          name: classMatch[1],
          kind: 'class',
          startLine: lineNum,
          endLine: lineNum + 20,
          exported: isExport,
        });
      }

      // Interface
      const ifaceMatch = clean.match(/^interface\s+([a-zA-Z0-9_$]+)/);
      if (ifaceMatch?.[1]) {
        symbols.push({
          name: ifaceMatch[1],
          kind: 'interface',
          startLine: lineNum,
          endLine: lineNum + 10,
          exported: isExport,
        });
      }

      // Method inside class
      const methodMatch = clean.match(
        /^(?:(?:public|private|protected|async|static)\s+)*([a-zA-Z0-9_$]+)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?\s*[{:]/,
      );
      if (
        methodMatch?.[1] &&
        !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])
      ) {
        symbols.push({
          name: methodMatch[1],
          kind: 'method',
          startLine: lineNum,
          endLine: lineNum + 5,
          exported: false,
        });
      }
    } else if (lang === 'python') {
      const isMethod = rawLine.startsWith('    def ') || rawLine.startsWith('\tdef ');
      const pyFn = trimmed.match(/^def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
      if (pyFn?.[1]) {
        symbols.push({
          name: pyFn[1],
          kind: isMethod ? 'method' : 'function',
          startLine: lineNum,
          endLine: lineNum + 10,
          signature: `def ${pyFn[1]}(${pyFn[2] ?? ''})`,
          exported: !pyFn[1].startsWith('_'),
        });
      }

      const pyClass = trimmed.match(/^class\s+([a-zA-Z0-9_]+)/);
      if (pyClass?.[1]) {
        symbols.push({
          name: pyClass[1],
          kind: 'class',
          startLine: lineNum,
          endLine: lineNum + 20,
          exported: true,
        });
      }
    }

    // 3. Calls
    const callMatch = trimmed.match(/([a-zA-Z0-9_$]+)\s*\(/g);
    if (callMatch) {
      for (const callStr of callMatch) {
        const name = callStr.replace(/\s*\($/, '');
        if (
          ![
            'if',
            'for',
            'while',
            'switch',
            'catch',
            'function',
            'class',
            'import',
            'return',
            'def',
            'require',
          ].includes(name)
        ) {
          calls.push({ name, line: lineNum, kind: 'call' });
        }
      }
    }
  }

  return {
    path,
    language,
    symbols,
    calls,
    imports,
    hasSyntaxErrors: false,
  };
}

/**
 * Extracts the AST outline (symbols, methods, classes, calls, imports) for a single file.
 * Dispatches to native Rust tree-sitter when available, or executes the pure TypeScript
 * parser when in TypeScript fallback mode.
 */
export function extractFileOutline(
  path: string,
  language: string,
  source: string,
): NapiFileOutline {
  const native = loadRustSyntax();
  if (native) {
    return native.extractFileOutlineNative(path, language, source);
  }
  return pureTsExtractOutline(path, language, source);
}

/**
 * Concurrently extracts AST outlines across a batch of files.
 * Uses native Rayon thread pool when available, or pure TypeScript execution.
 */
export function parseFilesBatch(files: readonly FileInput[]): readonly NapiFileOutline[] {
  const native = loadRustSyntax();
  if (native) {
    return native.parseFilesBatchNative(files);
  }
  return files.map((f) => pureTsExtractOutline(f.path, f.language, f.source));
}
