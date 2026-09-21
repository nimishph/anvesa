import { defineTransformer, type InputFile, type Transformer } from './card.ts';
import { ChannelConflictError, ChannelNotFoundError } from './errors.ts';

/**
 * The channels an engine knows: named groups of transformers that feed one vector index.
 * Instance-scoped, so two engines never share channels.
 */
export class ChannelRegistry {
  readonly #byChannel = new Map<string, Transformer[]>();
  readonly #names = new Set<string>();

  constructor(initial: Iterable<Transformer> = []) {
    for (const transformer of initial) this.register(transformer);
  }

  /** Add a transformer to its channel, creating the channel if it is new. Names must be unique. */
  register(transformer: Transformer): void {
    defineTransformer(transformer);
    if (this.#names.has(transformer.name)) {
      throw new ChannelConflictError(
        transformer.channel,
        `a transformer named "${transformer.name}" is already registered`,
      );
    }
    const existing = this.#byChannel.get(transformer.channel) ?? [];
    const clash = existing.find((other) => other.categoryId !== transformer.categoryId);
    if (clash) {
      throw new ChannelConflictError(
        transformer.channel,
        `holds category "${clash.categoryId}", but "${transformer.name}" produces "${transformer.categoryId}"`,
      );
    }
    this.#names.add(transformer.name);
    this.#byChannel.set(transformer.channel, [...existing, transformer]);
  }

  has(channel: string): boolean {
    return this.#byChannel.has(channel);
  }

  /** The transformers of a channel, or `ChannelNotFoundError` naming the channels that exist. */
  require(channel: string): readonly Transformer[] {
    const found = this.#byChannel.get(channel);
    if (!found) throw new ChannelNotFoundError(channel, this.channels());
    return found;
  }

  channels(): readonly string[] {
    return [...this.#byChannel.keys()].sort();
  }

  /** Every transformer that wants `file`, across all channels, in registration order. */
  claimants(file: InputFile): readonly Transformer[] {
    return [...this.#byChannel.values()].flat().filter((transformer) => transformer.claim(file));
  }

  /** Remove a whole channel's transformers. Its stored vectors are the store's to drop. */
  unregister(channel: string): boolean {
    const removed = this.#byChannel.get(channel);
    if (!removed) return false;
    for (const transformer of removed) this.#names.delete(transformer.name);
    return this.#byChannel.delete(channel);
  }
}
