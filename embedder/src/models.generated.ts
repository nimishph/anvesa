// Written by embedder/scripts/gen-model-index.ts from embedder/models/. Do not edit by hand.

import model_anvesa_code_1b from '../models/anvesa-code-1b.json' with { type: 'json' };
import model_anvesa_code_150m from '../models/anvesa-code-150m.json' with { type: 'json' };
import model_anvesa_code_400m from '../models/anvesa-code-400m.json' with { type: 'json' };
import model_gte_modernbert_base from '../models/gte-modernbert-base.json' with { type: 'json' };

/** Every built-in model config, as `buildRegistry` takes them. */
export const MODEL_CONFIGS: readonly { readonly source: string; readonly config: unknown }[] = [
  { source: 'embedder/models/anvesa-code-1b.json', config: model_anvesa_code_1b },
  { source: 'embedder/models/anvesa-code-150m.json', config: model_anvesa_code_150m },
  { source: 'embedder/models/anvesa-code-400m.json', config: model_anvesa_code_400m },
  { source: 'embedder/models/gte-modernbert-base.json', config: model_gte_modernbert_base },
];
