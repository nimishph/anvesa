import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadNativeBinding() {
  const rootDir = join(__dirname, '..', '..');
  const candidates = [
    join(__dirname, 'anvesa_napi.node'),
    join(rootDir, 'target', 'release', 'anvesa_napi.node'),
    join(rootDir, 'target', 'debug', 'anvesa_napi.node'),
    join(rootDir, 'target', 'release', 'anvesa_napi.dll'),
    join(rootDir, 'target', 'debug', 'anvesa_napi.dll'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        return require(candidate);
      } catch {
        // Continue searching
      }
    }
  }

  throw new Error(
    `Failed to load native anvesa_napi binding. Searched:\n${candidates.join('\n')}\nRun 'cargo build -p anvesa-napi' first.`,
  );
}

const nativeBinding = loadNativeBinding();

export const {
  dotProductSimd,
  normalizeSimd,
  batchScanTopK,
  batchDotProduct,
  extractFileOutlineNative,
  parseFilesBatchNative,
} = nativeBinding;

export default nativeBinding;
