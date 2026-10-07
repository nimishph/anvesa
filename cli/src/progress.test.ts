import { describe, expect, test } from 'bun:test';
import type { Environment } from './environment.ts';
import {
  DownloadProgress,
  formatBytes,
  formatDuration,
  renderBar,
  renderIndexBar,
} from './progress.ts';

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

describe('the index progress bar', () => {
  const base = { done: 0, total: 100, embedded: 0, cards: 0, quarantined: 0, elapsedMs: 0 };

  test('says it is listing until the total is known', () => {
    expect(renderIndexBar({ ...base, total: undefined })).toBe('indexing: listing files…');
  });

  test('fills against the total, with counts', () => {
    const line = renderIndexBar({ ...base, done: 50, total: 1200, embedded: 10, cards: 1234 });
    expect(line).toContain(`[${'█'.repeat(1)}${'░'.repeat(23)}]   4%  50/1,200 files`);
    expect(line).toContain('10 embedded (1,234 cards)');
    expect(renderIndexBar({ ...base, done: 0, total: 0 })).toContain('100%');
  });

  test('gives a rate and the time left once it has run long enough to measure', () => {
    expect(renderIndexBar({ ...base, done: 5, elapsedMs: 1000 })).not.toContain('left');
    const line = renderIndexBar({ ...base, done: 50, elapsedMs: 10_000 });
    expect(line).toContain('5.0 files/s');
    expect(line).toContain('~10 s left');
    expect(renderIndexBar({ ...base, done: 100, elapsedMs: 10_000 })).not.toContain('left');
  });

  test('names a slow file, and drops it first when the line would not fit', () => {
    const state = { ...base, done: 10, embedding: { path: 'src/big.ts', forMs: 12_000 } };
    expect(renderIndexBar(state)).toContain(' · embedding src/big.ts (12 s)');
    const narrow = renderIndexBar(state, 60);
    expect(narrow).not.toContain('big.ts');
    expect(narrow.length).toBeLessThan(60);
    expect(renderIndexBar(state, 20)).toHaveLength(19);
  });

  test('formats durations', () => {
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(185_000)).toBe('3 m 05 s');
    expect(formatDuration(4_320_000)).toBe('1 h 12 m');
  });
});
