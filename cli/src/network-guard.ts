import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { CodeLensError, type ErrorInit } from '@cntxt-labs/anvesa-core';

/** Something tried to reach the network while `--no-network` was in force. */
export class NetworkBlockedError extends CodeLensError {
  readonly code = 'CLI_NETWORK_BLOCKED';
  readonly subsystem = 'cli' as const;

  constructor(attempts: readonly string[], init: ErrorInit = {}) {
    super(
      attempts.length === 1
        ? `--no-network: blocked an outbound connection to ${attempts[0]}`
        : `--no-network: blocked ${attempts.length} outbound connections (${attempts.join(', ')})`,
      { ...init, context: { attempts, ...init.context } },
    );
  }
}

/** What the guard saw. It is the proof: an empty list means nothing tried to leave the process. */
export interface NetworkGuard {
  /** Every outbound attempt, as `host:port` or URL, in the order they were made. */
  readonly attempts: readonly string[];
  /** Put everything back as it was. */
  release(): void;
}

type Restore = () => void;

/**
 * Make the process unable to reach the network, and record every attempt. Blocks `fetch`, TCP and
 * TLS sockets (so `http`, `https` and every client built on them), DNS lookups, `WebSocket`,
 * `Bun.connect` and UDP sockets. A blocked call throws `NetworkBlockedError` at the caller, which
 * is how a module that tries to phone home fails loudly instead of quietly succeeding.
 *
 * It guards this process, including channel modules and red-team sources that run in it. It does
 * not police programs the CLI starts as separate processes (a browser for `issue`, `git`).
 */
export function blockNetwork(): NetworkGuard {
  const attempts: string[] = [];
  const restores: Restore[] = [];
  const refuse = (target: string): never => {
    attempts.push(target);
    throw new NetworkBlockedError([target]);
  };
  /** Swap a property. Some (`Bun.connect`) are writable but cannot be redefined, so those are assigned. */
  const set = <T extends object, K extends keyof T>(owner: T, key: K, value: T[K]): void => {
    if (Object.getOwnPropertyDescriptor(owner, key)?.configurable === false) {
      owner[key] = value;
      return;
    }
    Object.defineProperty(owner, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: Object.getOwnPropertyDescriptor(owner, key)?.enumerable ?? true,
    });
  };
  const replace = <T extends object, K extends keyof T>(
    owner: T,
    key: K,
    make: (original: T[K]) => T[K],
  ): void => {
    const original = owner[key];
    set(owner, key, make(original));
    restores.push(() => set(owner, key, original));
  };

  replace(globalThis, 'fetch', (original) =>
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = describeRequest(input);
        if (staysOnMachine(url)) return original(input, init);
        return refuse(url);
      },
      original,
    ),
  );

  replace(
    net.Socket.prototype,
    'connect',
    (original) =>
      function connect(this: net.Socket, ...args: unknown[]): net.Socket {
        const target = describeConnect(args);
        if (staysOnMachine(target)) {
          return (original as (...rest: unknown[]) => net.Socket).apply(this, args);
        }
        return refuse(target);
      } as net.Socket['connect'],
  );
  replace(
    tls,
    'connect',
    (original) =>
      ((...args: unknown[]) => {
        const target = describeConnect(args);
        if (staysOnMachine(target)) return (original as (...rest: unknown[]) => unknown)(...args);
        return refuse(target);
      }) as typeof tls.connect,
  );
  replace(
    dns,
    'lookup',
    (original) =>
      ((hostname: string, ...rest: unknown[]) => {
        if (staysOnMachine(hostname))
          return (original as (...a: unknown[]) => unknown)(hostname, ...rest);
        return refuse(`dns:${hostname}`);
      }) as unknown as typeof dns.lookup,
  );
  replace(
    dns.promises,
    'lookup',
    (original) =>
      (async (hostname: string, ...rest: unknown[]) => {
        if (staysOnMachine(hostname))
          return (original as (...a: unknown[]) => unknown)(hostname, ...rest);
        return refuse(`dns:${hostname}`);
      }) as unknown as typeof dns.promises.lookup,
  );

  const globals = globalThis as { WebSocket?: unknown };
  if (globals.WebSocket !== undefined) {
    replace(
      globals as { WebSocket: unknown },
      'WebSocket',
      () =>
        function WebSocket(url: string | URL): never {
          return refuse(String(url));
        },
    );
  }
  const bun = (globalThis as { Bun?: Record<string, unknown> }).Bun;
  if (bun) {
    for (const name of ['connect', 'udpSocket']) {
      if (typeof bun[name] !== 'function') continue;
      replace(
        bun,
        name,
        () => (options: unknown) => refuse(`${name}:${describeConnect([options])}`),
      );
    }
  }

  return {
    attempts,
    release() {
      for (const restore of restores.splice(0).reverse()) restore();
    },
  };
}

/**
 * Whether a target cannot leave the machine: this host's own loopback, a local socket path, or a
 * scheme that names data instead of a place (`data:`, `blob:`, `file:`).
 */
function staysOnMachine(target: string): boolean {
  if (/^(?:data|blob|file):/i.test(target)) return true;
  if (target.startsWith('/') || target.startsWith('\\')) return true;
  return /^(?:[a-z]+:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::\d+)?(?:[/?#]|$)/i.test(
    target,
  );
}

function describeRequest(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** `host:port` from the arguments of `Socket.connect` or `tls.connect`, in any of their forms. */
function describeConnect(args: readonly unknown[]): string {
  // Node normalizes the arguments of `net.connect` into one array before it calls `connect`.
  const [first, second] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  if (typeof first === 'number')
    return `${typeof second === 'string' ? second : 'localhost'}:${first}`;
  if (typeof first === 'string') return first;
  if (first !== null && typeof first === 'object') {
    const options = first as { host?: unknown; hostname?: unknown; port?: unknown; path?: unknown };
    if (typeof options.path === 'string') return options.path;
    const host = options.host ?? options.hostname ?? 'localhost';
    return `${String(host)}:${String(options.port ?? '')}`;
  }
  return 'unknown';
}
