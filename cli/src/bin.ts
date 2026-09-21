#!/usr/bin/env bun
import { runCli } from './cli.ts';
import { processEnvironment } from './environment.ts';

process.exitCode = await runCli(process.argv.slice(2), processEnvironment());
