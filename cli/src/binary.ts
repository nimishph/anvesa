#!/usr/bin/env bun
// The entry of the compiled binary: the same CLI, with the grammars it ships embedded.
import javascript from 'tree-sitter-javascript/tree-sitter-javascript.wasm' with { type: 'file' };
import tsx from 'tree-sitter-typescript/tree-sitter-tsx.wasm' with { type: 'file' };
import typescript from 'tree-sitter-typescript/tree-sitter-typescript.wasm' with { type: 'file' };
import runtimeWasm from 'web-tree-sitter/web-tree-sitter.wasm' with { type: 'file' };
import { runCli } from './cli.ts';
import { processEnvironment } from './environment.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  ...processEnvironment(),
  grammars: { embedded: { javascript, typescript, tsx }, runtimeWasm },
});
