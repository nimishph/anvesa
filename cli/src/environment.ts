import type { Embedder, GrammarHost, SyntaxRuntime } from '@sutras/code-lens-retriever';

/** What the CLI reads from and writes to, so it can be driven by tests as well as by a terminal. */
export interface Environment {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** An embedder to use instead of looking for an installed model. Tests supply one. */
  readonly embedder?: Embedder | undefined;
  /** The grammar runtime to use instead of the standard layout. Tests supply one. */
  readonly runtime?: SyntaxRuntime | undefined;
  /** Grammars the host ships, and where to find the parser runtime. A compiled binary sets this. */
  readonly grammars?: GrammarHost | undefined;
  stdout(text: string): void;
  stderr(text: string): void;
}

export function processEnvironment(): Environment {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}
