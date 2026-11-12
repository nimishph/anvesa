/**
 * Loaded before every test file (bunfig.toml). Tests that run commands give them a home
 * directory, and a run with a home sends telemetry to the built-in collector once the notice has
 * been shown. A test must never reach the real collector: it would post test events to the
 * production analytics, and wait on the network. Any request to it fails here at once, the way
 * an offline machine does, which the collector code already treats as a failed send.
 */
import { InvalidArgumentError } from '@cntxt-labs/anvesa-core';
import { DEFAULT_TELEMETRY_ENDPOINT } from '../cli/src/telemetry.ts';

const collector = DEFAULT_TELEMETRY_ENDPOINT ? new URL(DEFAULT_TELEMETRY_ENDPOINT).host : undefined;
const realFetch = globalThis.fetch;

const guarded = ((input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (collector !== undefined && URL.canParse(url) && new URL(url).host === collector) {
    return Promise.reject(
      new InvalidArgumentError(
        'fetch',
        'a URL other than the real telemetry collector',
        `${url}: tests may not reach the real telemetry collector`,
      ),
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

globalThis.fetch = Object.assign(guarded, realFetch);
