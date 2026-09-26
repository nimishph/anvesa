import { createInterface } from 'node:readline/promises';
import type { Embedder, GrammarHost, SyntaxRuntime } from '@cntxt-labs/anvesa-retriever';

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
  /** Network fetch for downloads, instead of the global one. Tests supply one. */
  readonly fetch?: typeof fetch | undefined;
  /** Whether stderr is an interactive terminal, so progress can overwrite its own line. */
  readonly isTTY?: boolean | undefined;
  /**
   * Ask the person a question and return their answer, or `undefined` when nobody can answer
   * (input is not a terminal). Tests supply scripted answers.
   */
  prompt?: ((question: string) => Promise<string | undefined>) | undefined;
  stdout(text: string): void;
  stderr(text: string): void;
}

export function processEnvironment(): Environment {
  const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
  return {
    prompt: interactive
      ? async (question) => {
          const lines = createInterface({ input: process.stdin, output: process.stderr });
          try {
            return await lines.question(question);
          } finally {
            lines.close();
          }
        }
      : undefined,
    cwd: process.cwd(),
    env: process.env,
    isTTY: process.stderr.isTTY === true,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}
