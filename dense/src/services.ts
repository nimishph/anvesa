import type { StructuralEngine } from '@sutras/code-lens-structural';
import type { ParseTarget, SyntaxRuntime } from '@sutras/code-lens-syntax';
import type { InputFile, TransformServices } from './card.ts';

function targetOf(file: InputFile): ParseTarget {
  return file.language === undefined ? { path: file.path } : { language: file.language };
}

/** The services transformers get, backed by a syntax runtime and a structural engine. */
export function createTransformServices(engine: StructuralEngine): TransformServices {
  const runtime: SyntaxRuntime = engine.runtime;
  return {
    withTree: (file, work) =>
      runtime.withTree(file.content, targetOf(file), work, { path: file.path }),
    encode: (file, options = {}) =>
      engine.encode(file.content, targetOf(file), {
        path: file.path,
        ...(options.docs === undefined ? {} : { docs: options.docs }),
      }),
  };
}
