import { describe, expect, test } from 'bun:test';
import type { Environment } from './environment.ts';
import { DownloadProgress, formatBytes, renderBar } from './progress.ts';

function environment(isTTY: boolean) {
  let err = '';
  const env: Environment = {
    cwd: '.',
    env: {},
    isTTY,
    stdout: () => undefined,
    stderr: (text) => {
      err += text;
    },
  };
  return { env, written: () => err };
}

describe('download progress', () => {
  test('sizes are written as a person reads them', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(23 * 1024 * 1024)).toBe('23.0 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.50 GB');
  });

  test('the bar fills with what has arrived and shows percent, sizes and speed', () => {
    const half = renderBar('model.onnx', 5 * 1024 * 1024, 10 * 1024 * 1024, 2 * 1024 * 1024);
    expect(half).toContain('model.onnx');
    expect(half).toContain(' 50%');
    expect(half).toContain('5.0 MB / 10.0 MB');
    expect(half).toContain('2.0 MB/s');
    expect(half.match(/█/g)).toHaveLength(12);
    expect(renderBar('x', 999, 10).match(/█/g)).toHaveLength(24);
  });

  test('a download of unknown size shows what has arrived instead of a bar', () => {
    const line = renderBar('parser', 3000, 0);
    expect(line).toContain('parser');
    expect(line).toContain('3 KB');
    expect(line).not.toContain('█');
  });

  test('off a terminal, a line is written as each quarter completes, not one per chunk', () => {
    const { env, written } = environment(false);
    const progress = new DownloadProgress(env);
    progress.start('model.onnx');
    for (let received = 0; received <= 100; received += 5) progress.update(received, 100);
    progress.done();
    const lines = written().trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toContain('100%');
    expect(written()).not.toContain('\r');
  });

  test('on a terminal one line is rewritten in place and ends with a newline', () => {
    const { env, written } = environment(true);
    const progress = new DownloadProgress(env);
    progress.start('model.onnx');
    progress.update(10, 100);
    progress.update(100, 100);
    progress.done();
    expect(written().startsWith('\r')).toBe(true);
    expect(written()).toContain('100%');
    expect(written().endsWith('\n')).toBe(true);
    expect(written().match(/\n/g)).toHaveLength(1);
  });
});
