/**
 * Names the language or its usual runtime provides without an import. A call to one is a call
 * into the runtime, not a symbol that is missing from the workspace, and is recorded as such.
 *
 * The lists are fixed and explicit rather than read from the process that happens to run the
 * indexer, so the same source gives the same graph under Bun, Node or a browser.
 */

const ECMASCRIPT_GLOBALS: ReadonlySet<string> = new Set(
  `Object Function Array String Number Boolean Symbol BigInt Math JSON Date RegExp
   Error TypeError RangeError SyntaxError ReferenceError EvalError URIError AggregateError
   Promise Map Set WeakMap WeakSet WeakRef FinalizationRegistry Proxy Reflect Atomics Intl
   ArrayBuffer SharedArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array
   Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array
   parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI
   eval globalThis console setTimeout clearTimeout setInterval clearInterval setImmediate
   clearImmediate queueMicrotask structuredClone fetch Request Response Headers URL
   URLSearchParams AbortController AbortSignal TextEncoder TextDecoder Blob FormData WebSocket
   Event EventTarget performance crypto atob btoa process Buffer Bun Deno window document
   navigator localStorage sessionStorage`.split(/\s+/),
);

const PYTHON_BUILTINS: ReadonlySet<string> = new Set(
  `abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod
   compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset
   getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals
   map max memoryview min next object oct open ord pow print property range repr reversed round
   set setattr slice sorted staticmethod str sum super tuple type vars zip
   BaseException Exception ArithmeticError AssertionError AttributeError EOFError ImportError
   IndexError KeyError KeyboardInterrupt LookupError MemoryError NameError NotImplementedError
   OSError OverflowError RecursionError RuntimeError StopIteration SyntaxError SystemExit
   TypeError ValueError ZeroDivisionError FileNotFoundError PermissionError TimeoutError
   ConnectionError`.split(/\s+/),
);

/** Whether `name` is provided by the runtime of `language` without an import. */
export function isBuiltin(language: string, name: string): boolean {
  if (language === 'python') return PYTHON_BUILTINS.has(name);
  if (language === 'javascript' || language === 'typescript' || language === 'tsx') {
    return ECMASCRIPT_GLOBALS.has(name);
  }
  return false;
}
