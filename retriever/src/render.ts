import { randomBytes } from 'node:crypto';

/**
 * Text that came from a card is data, not instructions: a channel can index anything, including
 * text written to steer a model. Wrapped in a fence that the text cannot forge (the marker holds
 * random characters that are checked not to occur in the text), a reader, human or model, can
 * always tell where untrusted content begins and ends.
 */
export function fenceUntrusted(
  text: string,
  meta: { readonly source: string; readonly channel: string; readonly trust: string },
): string {
  let marker = `untrusted-${randomBytes(6).toString('hex')}`;
  while (text.includes(marker)) marker = `untrusted-${randomBytes(6).toString('hex')}`;
  const label = `source=${JSON.stringify(meta.source)} channel=${JSON.stringify(meta.channel)} trust=${meta.trust}`;
  return `<<<${marker} ${label}\n${text}\n${marker}>>>`;
}
