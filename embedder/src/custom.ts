import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { type Deadline, InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { openOnnx } from './backend.ts';
import type { ModelCache } from './cache.ts';
import { ModelInstallError, ModelShapeError } from './errors.ts';
import { BUILTIN_MODELS, builtinModel, type ModelSpec, type Pooling, TIERS } from './models.ts';
import { tokenizerFromJson } from './tokenizer.ts';

/** A model id is a folder name and a key of stored vectors: plain characters only. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface CustomModelOptions {
  /** The name the model is kept and selected by (`model` in config). */
  readonly id: string;
  /** A directory holding `model.onnx` and `tokenizer.json` (upstream layouts work), or the `.onnx` file. */
  readonly from: string;
  /** How token states become one vector. Read from `1_Pooling/config.json` when there is one. */
  readonly pooling?: Pooling;
  /** The input window in tokens, specials included. Read from the model's own config when possible. */
  readonly maxTokens?: number;
  /** Accept files that differ from an earlier install of this id. */
  readonly replace?: boolean;
  readonly threads?: number;
  readonly deadline?: Deadline;
}

interface Located {
  readonly model: string;
  readonly tokenizer: string;
  /** The directory that may hold the model's own configuration files. */
  readonly config: string;
}

function onnxFilesIn(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith('.onnx'))
    .map((name) => join(directory, name));
}

function locate(id: string, from: string): Located {
  const searched: string[] = [];
  const first = (candidates: readonly string[]): string | undefined => {
    searched.push(...candidates);
    return candidates.find((path) => existsSync(path) && statSync(path).isFile());
  };

  let model: string | undefined;
  let directory: string;
  if (existsSync(from) && statSync(from).isFile()) {
    model = from;
    directory = dirname(from);
    if (basename(dirname(from)) === 'onnx') directory = dirname(directory);
  } else {
    directory = from;
    model = first([
      join(from, 'model.onnx'),
      join(from, 'onnx', 'model.onnx'),
      join(from, 'model_quantized.onnx'),
      join(from, 'onnx', 'model_quantized.onnx'),
    ]);
    if (!model) {
      const others = [...onnxFilesIn(from), ...onnxFilesIn(join(from, 'onnx'))];
      if (others.length === 1) model = others[0];
      else if (others.length > 1) {
        throw new ModelInstallError(id, `${from} holds several .onnx files; name the one to use`, {
          context: { candidates: others },
          hint: 'Pass the path of the .onnx file itself as --from.',
        });
      }
    }
  }
  if (!model) {
    throw new ModelInstallError(id, `no .onnx model is in ${from}`, { context: { searched } });
  }
  const tokenizer = first([
    join(directory, 'tokenizer.json'),
    join(dirname(model), 'tokenizer.json'),
  ]);
  if (!tokenizer) {
    throw new ModelInstallError(id, `no tokenizer.json is beside the model in ${directory}`, {
      context: { searched },
      hint: 'Only Hugging Face tokenizer.json files are read (WordPiece, BPE and unigram).',
    });
  }
  return { model, tokenizer, config: directory };
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (failure) {
    throw new ModelInstallError(basename(dirname(path)), `${path} is not valid JSON`, {
      cause: failure,
    });
  }
}

/** Pooling from a sentence-transformers `1_Pooling/config.json`, or undefined when there is none. */
async function poolingOf(id: string, directory: string): Promise<Pooling | undefined> {
  const config = await readJson(join(directory, '1_Pooling', 'config.json'));
  if (!config) return undefined;
  if (config.pooling_mode_cls_token === true) return 'cls';
  if (config.pooling_mode_mean_tokens === true) return 'mean';
  throw new ModelInstallError(
    id,
    'its 1_Pooling/config.json asks for a pooling other than mean or CLS',
    { context: { config } },
  );
}

/** The window from the model's own files, best evidence first. */
async function windowOf(directory: string): Promise<number | undefined> {
  const sentence = await readJson(join(directory, 'sentence_bert_config.json'));
  if (typeof sentence?.max_seq_length === 'number') return sentence.max_seq_length;
  const tokenizer = await readJson(join(directory, 'tokenizer_config.json'));
  const declared = tokenizer?.model_max_length;
  // Some files say a huge number to mean "unset".
  if (typeof declared === 'number' && declared > 0 && declared < 1_000_000) return declared;
  const config = await readJson(join(directory, 'config.json'));
  if (typeof config?.max_position_embeddings === 'number') {
    // RoBERTa-family position tables start after the padding index: two positions are not text.
    const offset = /roberta|camembert/.test(String(config.model_type)) ? 2 : 0;
    return config.max_position_embeddings - offset;
  }
  return undefined;
}

export interface CustomModelPlan {
  readonly model: string;
  readonly tokenizer: string;
  readonly pooling: Pooling;
  readonly maxTokens: number;
  readonly source: string;
}

/**
 * What installing would do, decided from the files alone: where the model and tokenizer are, how
 * it pools and how long its window is. Pooling and the window come from the model's own
 * configuration when it has one, and are refused, not guessed, when it does not.
 */
export async function planCustomModel(options: CustomModelOptions): Promise<CustomModelPlan> {
  const { id } = options;
  if (!MODEL_ID.test(id)) {
    throw new InvalidArgumentError(
      'model',
      'letters, digits, ".", "_" and "-", starting with a letter or digit',
      id,
    );
  }
  if (builtinModel(id)) {
    throw new InvalidArgumentError(
      'model',
      `an id that is not built in (${TIERS.map((tier) => BUILTIN_MODELS[tier].id).join(', ')})`,
      id,
    );
  }
  const from = resolve(options.from);
  const found = locate(id, from);

  const pooling = options.pooling ?? (await poolingOf(id, found.config));
  if (pooling === undefined) {
    throw new InvalidArgumentError(
      '--pooling',
      'mean or cls: the model has no 1_Pooling/config.json to say which',
      undefined,
    );
  }
  const maxTokens = options.maxTokens ?? (await windowOf(found.config));
  if (maxTokens === undefined) {
    throw new InvalidArgumentError(
      '--max-tokens',
      'the input window in tokens: the model has no config that says',
      undefined,
    );
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 3) {
    throw new InvalidArgumentError(
      '--max-tokens',
      'a whole number of at least 3',
      String(maxTokens),
    );
  }
  return { model: found.model, tokenizer: found.tokenizer, pooling, maxTokens, source: from };
}

/**
 * Install a model the user brought: an ONNX file and its `tokenizer.json`. The tokenizer must be
 * one this package reproduces exactly; the model must run, and the number of dimensions it gives
 * is read from that run, not asked for. The files are pinned by their checksums at this first
 * install (see `ModelCache.installCustom`).
 */
export async function installCustomModel(
  cache: ModelCache,
  options: CustomModelOptions,
): Promise<ModelSpec> {
  const { id } = options;
  const plan = await planCustomModel(options);
  return cache.installCustom({
    id,
    maxTokens: plan.maxTokens,
    pooling: plan.pooling,
    source: plan.source,
    files: { model: plan.model, tokenizer: plan.tokenizer },
    ...(options.replace ? { replace: true } : {}),
    ...(options.deadline ? { deadline: options.deadline } : {}),
    validate: async ({ modelPath, tokenizerPath }) => {
      const tokenizer = tokenizerFromJson(await readFile(tokenizerPath, 'utf8'), plan.tokenizer);
      const backend = await openOnnx({
        modelId: id,
        modelPath,
        ...(options.threads === undefined ? {} : { threads: options.threads }),
      });
      try {
        const ids = tokenizer.encode('dimension probe');
        const output = await backend.run({
          batch: 1,
          length: ids.length,
          ids: BigInt64Array.from(ids, (value) => BigInt(value)),
          mask: new BigInt64Array(ids.length).fill(1n),
        });
        const width = output.dims.at(-1);
        if (width === undefined || width < 1) {
          throw new ModelShapeError(id, 'it produced no vectors', {
            context: { dims: output.dims },
          });
        }
        return width;
      } finally {
        await backend.dispose();
      }
    },
  });
}
