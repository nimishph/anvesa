import { describe, expect, test } from 'bun:test';
import net from 'node:net';
import { blockNetwork, NetworkBlockedError } from './network-guard.ts';

describe('network guard', () => {
  test('fetch to a remote host is refused and recorded, then allowed again on release', async () => {
    const original = globalThis.fetch;
    const guard = blockNetwork();
    try {
      await expect(fetch('https://example.com/model.onnx')).rejects.toBeInstanceOf(
        NetworkBlockedError,
      );
      expect(guard.attempts).toEqual(['https://example.com/model.onnx']);
    } finally {
      guard.release();
    }
    expect(globalThis.fetch).toBe(original);
  });

  test('sockets and lookups to remote hosts are refused', () => {
    const guard = blockNetwork();
    try {
      expect(() => new net.Socket().connect(443, 'example.com')).toThrow(NetworkBlockedError);
      expect(() => net.connect({ host: 'example.org', port: 80 })).toThrow(NetworkBlockedError);
      expect(guard.attempts).toEqual(['example.com:443', 'example.org:80']);
    } finally {
      guard.release();
    }
  });

  test('what stays on the machine is not blocked', async () => {
    const guard = blockNetwork();
    try {
      const response = await fetch('data:text/plain,hello');
      expect(await response.text()).toBe('hello');
      expect(guard.attempts).toEqual([]);
    } finally {
      guard.release();
    }
  });
});
