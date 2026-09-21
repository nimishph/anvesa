import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InferenceError, ModelShapeError } from './errors.ts';

/** One padded batch, as the model reads it: `batch` rows of `length` ids, row-major. */
export interface TokenBatch {
  readonly batch: number;
  readonly length: number;
  readonly ids: BigInt64Array;
  /** 1 for a real token, 0 for padding. */
  readonly mask: BigInt64Array;
}

export interface ModelOutput {
  /** `[batch, length, dimensions]` token states, or `[batch, dimensions]` already pooled. */
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

/**
 * What the encoder needs from an inference runtime, so the batching, pooling and validation can
 * be exercised without a model and the runtime can be swapped.
 */
export interface InferenceBackend {
  run(input: TokenBatch): Promise<ModelOutput>;
  dispose(): Promise<void>;
}

export interface OnnxOptions {
  readonly modelId: string;
  readonly modelPath: string;
  /** Threads for one operator. Unset lets the runtime decide (all cores). */
  readonly threads?: number;
}

const NATIVE_LIBRARIES: Readonly<Record<string, readonly string[]>> = {
  win32: ['onnxruntime.dll'],
  darwin: ['libonnxruntime.1.dylib', 'libonnxruntime.dylib'],
  linux: ['libonnxruntime.so.1', 'libonnxruntime.so'],
};

/**
 * Make the ONNX runtime's shared libraries findable when the program is a compiled binary: they
 * ship beside it (not inside it: the addon must sit beside its library), and the dynamic linker looks where the
 * environment says. Returns the directories that hold them.
 */
export function prepareNativeRuntime(): readonly string[] {
  const names = NATIVE_LIBRARIES[process.platform] ?? [];
  const candidates = [
    dirname(process.execPath),
    join(dirname(process.execPath), 'lib'),
    process.cwd(),
  ];
  const holding = candidates.filter((directory) =>
    names.some((name) => existsSync(join(directory, name))),
  );
  const variable =
    process.platform === 'win32'
      ? 'PATH'
      : process.platform === 'darwin'
        ? 'DYLD_FALLBACK_LIBRARY_PATH'
        : 'LD_LIBRARY_PATH';
  const current = (process.env[variable] ?? '').split(delimiter).filter((part) => part !== '');
  for (const directory of holding) {
    if (!current.includes(directory)) current.unshift(directory);
  }
  if (holding.length > 0) process.env[variable] = current.join(delimiter);
  return holding;
}

/** Folders that may hold a `node_modules/onnxruntime-node` shipped with a compiled binary. */
export function runtimeFolders(environment: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [
    ...(environment.CODE_LENS_RUNTIME ? [environment.CODE_LENS_RUNTIME] : []),
    join(dirname(process.execPath), 'runtime'),
    join(environment.CODE_LENS_HOME ?? join(homedir(), '.code-lens'), 'runtime'),
  ];
}

/**
 * The runtime shipped beside a compiled binary when there is one, else the installed package. It
 * must be loaded from its own folder: the native addon finds its shared library next to itself,
 * and on Windows a copy of the library elsewhere (System32 has one) would win and fail.
 */
async function loadOnnxRuntime(): Promise<typeof import('onnxruntime-node')> {
  for (const folder of runtimeFolders()) {
    const entry = join(folder, 'node_modules', 'onnxruntime-node', 'dist', 'index.js');
    if (existsSync(entry)) return (await import(pathToFileURL(entry).href)) as never;
  }
  return await import('onnxruntime-node');
}

/** The ONNX runtime running the model on the CPU. */
export async function openOnnx(options: OnnxOptions): Promise<InferenceBackend> {
  prepareNativeRuntime();
  let ort: typeof import('onnxruntime-node');
  try {
    ort = await loadOnnxRuntime();
  } catch (failure) {
    throw new InferenceError(options.modelId, 'the ONNX runtime could not be loaded', {
      cause: failure,
      hint: `Put the "runtime" folder that ships with the program beside it, or in ${join(homedir(), '.code-lens', 'runtime')}.`,
    });
  }

  let session: import('onnxruntime-node').InferenceSession;
  try {
    session = await ort.InferenceSession.create(options.modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      ...(options.threads === undefined ? {} : { intraOpNumThreads: options.threads }),
      // Each batch is a different shape; an arena keeps every peak it has seen.
      enableCpuMemArena: false,
    });
  } catch (failure) {
    throw new InferenceError(options.modelId, `cannot open ${options.modelPath}`, {
      cause: failure,
    });
  }

  const inputs = new Set(session.inputNames);
  for (const required of ['input_ids', 'attention_mask']) {
    if (!inputs.has(required)) {
      throw new ModelShapeError(options.modelId, `it has no "${required}" input`, {
        context: { inputs: session.inputNames },
      });
    }
  }
  const outputName = ['sentence_embedding', 'last_hidden_state'].find((name) =>
    session.outputNames.includes(name),
  );
  if (!outputName) {
    throw new ModelShapeError(
      options.modelId,
      'it has neither a "sentence_embedding" nor a "last_hidden_state" output',
      { context: { outputs: session.outputNames } },
    );
  }

  return {
    async run(input) {
      const shape = [input.batch, input.length];
      const feeds: Record<string, import('onnxruntime-node').Tensor> = {
        input_ids: new ort.Tensor('int64', input.ids, shape),
        attention_mask: new ort.Tensor('int64', input.mask, shape),
      };
      // BERT models that ask for segment ids get all zeros: a single sentence.
      if (inputs.has('token_type_ids')) {
        feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(input.ids.length), shape);
      }
      try {
        const result = await session.run(feeds, [outputName]);
        const tensor = result[outputName];
        if (!tensor) throw new ModelShapeError(options.modelId, `no "${outputName}" came back`);
        return { data: tensor.data as Float32Array, dims: tensor.dims };
      } catch (failure) {
        if (failure instanceof ModelShapeError) throw failure;
        throw new InferenceError(options.modelId, 'the model failed on a batch', {
          cause: failure,
          context: { batch: input.batch, length: input.length },
        });
      }
    },
    async dispose() {
      await session.release();
    },
  };
}
