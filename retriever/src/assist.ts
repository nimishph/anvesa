import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ASSIST_TAGS,
  type Assistant,
  type AssistCandidate,
  type AssistSuggestion,
} from '@cntxt-labs/anvesa-structural';
import { AssistError } from './errors.ts';

export type { Assistant, AssistCandidate, AssistSuggestion };

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_ASSIST_MODEL = 'openrouter/free';

export interface ChatAssistantOptions {
  /** Read from the environment by the caller; never written anywhere. */
  readonly apiKey: string;
  /** Any OpenAI-compatible chat completions endpoint. OpenRouter by default. */
  readonly baseUrl?: string;
  readonly model?: string;
  readonly language: string;
  /**
   * Where answers are kept, keyed by the question. A model does not answer the same way twice, so
   * a kept answer is what makes training again give the same mapping.
   */
  readonly cacheFile?: string;
  /** Ask again even when an answer to this question is kept. */
  readonly refresh?: boolean;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

interface Kept {
  readonly key: string;
  readonly model: string;
  readonly suggestions: readonly AssistSuggestion[];
}

/** A kept answer, or nothing when there is none or it cannot be read: a cache, not a record. */
async function readKept(path: string): Promise<Kept | undefined> {
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text) as Kept;
  } catch (failure) {
    void failure;
    return undefined;
  }
}

/** The question, as the model reads it: statistics about node types, never source text. */
export function assistPrompt(language: string, candidates: readonly AssistCandidate[]): string {
  return [
    `These are tree-sitter node types from ${language} code that a code-outline mapping leaves undecided.`,
    'For each, say which outline tag it should have, judging only from its name and the statistics',
    '(fields it fills and the child types in them, its usual parents and children).',
    `Allowed tags: ${ASSIST_TAGS.join(', ')}; or "none" when it is not one of these, or you are unsure.`,
    'A declaration tag (function, method, class, interface, struct, enum, trait, type, module, constant)',
    'needs "nameChild": the child type that holds its name, taken from its fields or children.',
    'Prefer "none" to a guess. Answer only about the node types listed.',
    'Reply with JSON only: {"suggestions":[{"type":"...","tag":"...","nameChild":"..."}]}',
    '',
    JSON.stringify(candidates),
  ].join('\n');
}

/** The first JSON object in a reply, whether or not the model wrapped it in prose or a fence. */
function parseReply(text: string): readonly AssistSuggestion[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AssistError('the reply held no JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (failure) {
    throw new AssistError('the reply was not valid JSON', { cause: failure });
  }
  const suggestions = (parsed as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(suggestions)) throw new AssistError('the reply had no "suggestions" list');
  return suggestions.filter(
    (entry): entry is AssistSuggestion =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as AssistSuggestion).type === 'string' &&
      typeof (entry as AssistSuggestion).tag === 'string',
  );
}

/**
 * An {@link Assistant} backed by an OpenAI-compatible chat API (OpenRouter by default). It is asked
 * once per distinct question; the answer is kept in `cacheFile` and reused until `refresh`.
 */
export function chatAssistant(options: ChatAssistantOptions): Assistant {
  const model = options.model ?? DEFAULT_ASSIST_MODEL;
  const baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  return async (candidates) => {
    const prompt = assistPrompt(options.language, candidates);
    const key = createHash('sha256').update(`${model}\n${prompt}`).digest('hex');
    if (options.cacheFile && !options.refresh && existsSync(options.cacheFile)) {
      const kept = await readKept(options.cacheFile);
      if (kept?.key === key) return { model: kept.model, suggestions: kept.suggestions };
    }

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          'x-title': 'anvesa mapping train',
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                'You classify tree-sitter syntax node types for a code-outline tool. Reply with JSON only.',
            },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      });
    } catch (failure) {
      throw new AssistError(`could not reach ${baseUrl}`, { cause: failure });
    }
    const body = await response.text();
    if (!response.ok) {
      // The body is the provider's own error message; it never echoes the key.
      const hint =
        response.status === 401
          ? 'Check OPENROUTER_API_KEY (or ANVESA_ASSIST_API_KEY).'
          : response.status === 429
            ? 'The model is rate limited; try again later or pick another with --assist-model.'
            : undefined;
      throw new AssistError(`${baseUrl} answered ${response.status}`, {
        ...(hint ? { hint } : {}),
        context: { status: response.status, response: body },
      });
    }
    let reply: { model?: string; choices?: { message?: { content?: string } }[] };
    try {
      reply = JSON.parse(body);
    } catch (failure) {
      throw new AssistError('the response was not JSON', { cause: failure });
    }
    const content = reply.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new AssistError('the response held no message');
    const answered = { model: reply.model ?? model, suggestions: parseReply(content) };

    if (options.cacheFile) {
      await mkdir(dirname(options.cacheFile), { recursive: true });
      const kept: Kept = { key, ...answered };
      await writeFile(options.cacheFile, `${JSON.stringify(kept, null, 2)}\n`);
    }
    return answered;
  };
}
