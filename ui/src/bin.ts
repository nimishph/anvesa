#!/usr/bin/env bun
import { startUiServer } from './server.ts';

const args = process.argv.slice(2);
let port: number | undefined;
let root: string | undefined;
let open = true;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = Number(args[++i]);
  } else if (args[i] === '--root' && args[i + 1]) {
    root = args[++i];
  } else if (args[i] === '--no-open') {
    open = false;
  }
}

startUiServer({
  ...(port !== undefined ? { port } : {}),
  ...(root !== undefined ? { root } : {}),
  open,
});
