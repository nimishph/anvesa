import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistCandidate } from '@cntxt-labs/anvesa-structural';
import { assistPrompt, chatAssistant, OPENROUTER_BASE_URL } from './assist.ts';
import { AssistError } from './errors.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'anvesa-assist-'));
  dirs.push(dir);
  return dir;
};

const CANDIDATES: AssistCandidate[] = [
  {
    type: 'yield',
    occurrences: 6,
    files: 3,
    fields: {},
    parents: ['expression_statement'],
    children: ['integer'],
  },
];

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: { model: string; temperature: number; messages: { content: string }[] };
}

/** A stand-in for the chat API: records each request and answers with `content`. */
function fakeApi(content: string, status = 200) {
  const seen: Seen[] = [];
  const fetchFake = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    const payload =
      status === 200
        ? { model: 'vendor/model-a', choices: [{ message: { content } }] }
        : { error: { message: 'No auth credentials found', code: status } };
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { seen, fetch: fetchFake };
}

describe('the chat assistant', () => {
  test('asks once with the key, temperature 0 and statistics only, and reads a fenced reply', async () => {
    const api = fakeApi(
      'Here you go:\n```json\n{"suggestions":[{"type":"yield","tag":"yield"},{"oops":1}]}\n```',
    );
    const assistant = chatAssistant({
      apiKey: 'test-key',
      language: 'python',
      model: 'some/model:free',
      fetch: api.fetch,
    });
    const answer = await assistant(CANDIDATES);
    expect(answer).toEqual({
      model: 'vendor/model-a',
      suggestions: [{ type: 'yield', tag: 'yield' }],
    });
    expect(api.seen).toHaveLength(1);
    const [request] = api.seen as [Seen];
    expect(request.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect(request.headers.authorization).toBe('Bearer test-key');
    expect(request.body.model).toBe('some/model:free');
    expect(request.body.temperature).toBe(0);
    expect(request.body.messages.at(-1)?.content).toBe(assistPrompt('python', CANDIDATES));
  });

  test('a kept answer to the same question is reused; refresh or a new question asks again', async () => {
    const cacheFile = join(scratch(), 'assist', 'python.json');
    const api = fakeApi('{"suggestions":[{"type":"yield","tag":"yield"}]}');
    const options = { apiKey: 'k', language: 'python', cacheFile, fetch: api.fetch };
    await chatAssistant(options)(CANDIDATES);
    expect(existsSync(cacheFile)).toBe(true);
    const again = await chatAssistant(options)(CANDIDATES);
    expect(again.suggestions).toEqual([{ type: 'yield', tag: 'yield' }]);
    expect(api.seen).toHaveLength(1);

    await chatAssistant({ ...options, refresh: true })(CANDIDATES);
    expect(api.seen).toHaveLength(2);
    await chatAssistant(options)([{ ...CANDIDATES[0], occurrences: 7 } as AssistCandidate]);
    expect(api.seen).toHaveLength(3);
  });

  test('a refused key or an unreadable reply is an AssistError, never a silent empty answer', async () => {
    const denied = fakeApi('', 401);
    const failure = await chatAssistant({ apiKey: 'bad', language: 'python', fetch: denied.fetch })(
      CANDIDATES,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AssistError);
    expect((failure as AssistError).message).toContain('401');
    expect((failure as AssistError).message).not.toContain('bad');

    const prose = fakeApi('I think yield is a statement.');
    await expect(
      chatAssistant({ apiKey: 'k', language: 'python', fetch: prose.fetch })(CANDIDATES),
    ).rejects.toBeInstanceOf(AssistError);
  });
});
