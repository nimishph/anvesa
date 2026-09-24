/**
 * Detection of minified bundles, compressed assets, and generated artifacts.
 *
 * Such files (e.g. checked-in webpack/vite bundles in public/js/) balloon index
 * size, consume gigabytes of AST memory during tree-sitter parsing, and pollute
 * the symbol index with mangled single-character identifiers.
 */

export interface MinifiedDetection {
  readonly isMinified: boolean;
  readonly reason?: string;
}

const MINIFIED_EXTENSIONS = ['.min.js', '.min.mjs', '.min.cjs', '.min.css'];

const ASSET_OR_DIST_DIRS = [
  '/public/js/',
  '/public/dist/',
  '/public/assets/',
  '/dist/js/',
  '/dist/assets/',
  '/build/static/',
  '/assets/js/',
];

const BUNDLE_SIGNATURES = [
  'webpackChunk',
  '__webpack_require__',
  '/*! For license information please see',
  '/* webpackChunkName',
  'parcelRequire',
  'System.register(',
];

/**
 * Inspects a file's path and text content to determine whether it is a minified bundle
 * or generated artifact rather than human-authored source code.
 */
export function detectMinified(path: string, content: string, size: number): MinifiedDetection {
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();

  // 1. Files with explicit minified extensions (size > 512 bytes to avoid empty stubs)
  for (const ext of MINIFIED_EXTENSIONS) {
    if (normalizedPath.endsWith(ext) && size > 512) {
      return {
        isMinified: true,
        reason: `file has minified extension ${ext}`,
      };
    }
  }

  // Small files (< 1.5 KB) are unlikely to cause performance issues and can have high false positive rates.
  if (content.length < 1536) {
    return { isMinified: false };
  }

  // 2. Sample analysis: check first 50,000 characters
  // biome-ignore lint/plugin: inspecting a sample window bounds CPU cost on multi-megabyte files
  const sampleLength = Math.min(content.length, 50000);
  const sample = content.slice(0, sampleLength);

  let maxLineLength = 0;
  let currentLineLength = 0;
  let lineCount = 1;

  for (let i = 0; i < sample.length; i++) {
    const ch = sample.charCodeAt(i);
    if (ch === 10) {
      if (currentLineLength > maxLineLength) {
        maxLineLength = currentLineLength;
      }
      currentLineLength = 0;
      lineCount++;
    } else if (ch !== 13) {
      currentLineLength++;
    }
  }
  if (currentLineLength > maxLineLength) {
    maxLineLength = currentLineLength;
  }

  const avgLineLength = sampleLength / lineCount;

  // 3. Long lines (> 1,000 chars) combined with bundle signatures or asset paths
  const inAssetDir = ASSET_OR_DIST_DIRS.some((dir) => normalizedPath.includes(dir));
  const hasBundleSig = BUNDLE_SIGNATURES.some((sig) => sample.includes(sig));

  if (maxLineLength > 1000 && (inAssetDir || hasBundleSig)) {
    const context = inAssetDir ? 'in public/dist asset directory' : 'contains bundle signatures';
    return {
      isMinified: true,
      reason: `max line length is ${maxLineLength.toLocaleString()} chars and file ${context}`,
    };
  }

  // 4. Extreme single line (> 10,000 chars): definitively minified / packed / single-line generated code.
  if (maxLineLength > 10000) {
    return {
      isMinified: true,
      reason: `extreme line length (${maxLineLength.toLocaleString()} chars)`,
    };
  }

  // 5. Very high average line length (> 500 chars) with low line count: typical of minified JS/CSS.
  if (avgLineLength > 500 && lineCount <= 15) {
    return {
      isMinified: true,
      reason: `average line length is ${Math.round(avgLineLength).toLocaleString()} chars across ${lineCount} lines`,
    };
  }

  // 6. General threshold: line > 2,000 chars and average line length > 200 chars
  if (maxLineLength > 2000 && avgLineLength > 200) {
    return {
      isMinified: true,
      reason: `max line length is ${maxLineLength.toLocaleString()} chars (average ${Math.round(avgLineLength)})`,
    };
  }

  return { isMinified: false };
}
