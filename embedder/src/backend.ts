import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
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
  /** Where the model runs: `cpu`, or the GPU execution provider in use. Absent means `cpu`. */
  readonly device?: string;
}

/**
 * Which device to run on. `auto` uses a GPU when one is plainly there and starts, else the CPU;
 * `gpu` requires one and fails if none starts; `cpu` never tries.
 */
export type DeviceSetting = 'auto' | 'gpu' | 'cpu';

export interface OnnxOptions {
  readonly modelId: string;
  readonly modelPath: string;
  /** Threads for one operator. Unset lets the runtime decide (all cores). */
  readonly threads?: number;
  /** Unset reads `ANVESA_DEVICE`, then `auto`. */
  readonly device?: DeviceSetting;
}

/** `ANVESA_DEVICE`, or `auto`. */
export function deviceSetting(environment: NodeJS.ProcessEnv = process.env): DeviceSetting {
  const value = (environment.ANVESA_DEVICE ?? 'auto').trim().toLowerCase();
  if (value === 'auto' || value === 'gpu' || value === 'cpu') return value;
  throw new InvalidArgumentError('ANVESA_DEVICE', 'auto, gpu or cpu', value);
}

/**
 * GPU execution providers to try, in order. Under `auto` only CUDA, and only with an NVIDIA driver
 * loaded: it is the one measured to pay off. DirectML and CoreML are tried only when a GPU is asked
 * for, since on small encoders and changing batch shapes they can be slower than the CPU.
 */
export function gpuProviders(
  device: DeviceSetting,
  platform: NodeJS.Platform = process.platform,
  hasNvidiaDriver: () => boolean = () => existsSync('/proc/driver/nvidia/version'),
): readonly string[] {
  if (device === 'cpu') return [];
  if (platform === 'linux') return device === 'gpu' || hasNvidiaDriver() ? ['cuda'] : [];
  if (device !== 'gpu') return [];
  if (platform === 'win32') return ['cuda', 'dml'];
  if (platform === 'darwin') return ['coreml'];
  return [];
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
    ...(environment.ANVESA_RUNTIME ? [environment.ANVESA_RUNTIME] : []),
    join(dirname(process.execPath), 'runtime'),
    join(environment.ANVESA_HOME ?? join(homedir(), '.anvesa'), 'runtime'),
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

/** The ONNX runtime running the model on a GPU when one is chosen and starts, else on the CPU. */
export async function openOnnx(options: OnnxOptions): Promise<InferenceBackend> {
  prepareNativeRuntime();
  let ort: typeof import('onnxruntime-node');
  try {
    ort = await loadOnnxRuntime();
  } catch (failure) {
    throw new InferenceError(options.modelId, 'the ONNX runtime could not be loaded', {
      cause: failure,
      hint: `Put the "runtime" folder that ships with the program beside it, or in ${join(homedir(), '.anvesa', 'runtime')}.`,
    });
  }

  const device = options.device ?? deviceSetting();
  let session: import('onnxruntime-node').InferenceSession | undefined;
  let used = 'cpu';
  const tried: string[] = [];
  for (const provider of gpuProviders(device)) {
    try {
      session = await ort.InferenceSession.create(options.modelPath, {
        // The CPU stays listed for the few operators a GPU provider does not implement.
        executionProviders: [provider, 'cpu'],
        graphOptimizationLevel: 'all',
        // DirectML needs both; they cost the others nothing for one model run at a time.
        enableMemPattern: false,
        executionMode: 'sequential',
      });
      used = provider;
      break;
    } catch (failure) {
      // CUDA without its libraries (cuDNN, or the provider files onnxruntime-node did not install)
      tried.push(
        `${provider}: ${failure instanceof Error ? failure.message.split('\n')[0] : String(failure)}`,
      );
    }
  }
  if (!session && device === 'gpu') {
    throw new InferenceError(options.modelId, 'no GPU execution provider could be started', {
      context: { tried: tried.length > 0 ? tried : [`none for ${process.platform}`] },
      hint: 'On Linux, onnxruntime-node needs its CUDA 12 files (run its install script with --onnxruntime-node-install=cuda12) and cuDNN 9 on the library path. ANVESA_DEVICE=auto falls back to the CPU instead.',
    });
  }
  try {
    session ??= await ort.InferenceSession.create(options.modelPath, {
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
  const opened = session;

  const inputs = new Set(opened.inputNames);
  for (const required of ['input_ids', 'attention_mask']) {
    if (!inputs.has(required)) {
      throw new ModelShapeError(options.modelId, `it has no "${required}" input`, {
        context: { inputs: opened.inputNames },
      });
    }
  }
  const outputName = ['sentence_embedding', 'last_hidden_state'].find((name) =>
    opened.outputNames.includes(name),
  );
  if (!outputName) {
    throw new ModelShapeError(
      options.modelId,
      'it has neither a "sentence_embedding" nor a "last_hidden_state" output',
      { context: { outputs: opened.outputNames } },
    );
  }

  return {
    device: used,
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
        const result = await opened.run(feeds, [outputName]);
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
      await opened.release();
    },
  };
}
