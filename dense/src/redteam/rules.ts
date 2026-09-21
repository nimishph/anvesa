import type { Category, Rule, RuleHit, Severity } from './types.ts';

/**
 * The built-in heuristics. They are fixed on purpose: a predictable list is easier to trust and to
 * test than a clever one. Every rule is data, and `defaultRules()` is only a convenient starting
 * set; a gate takes any list of rules.
 *
 * These are screens, not proofs. They catch the well-known shapes of prompt injection and index
 * poisoning; the gate's other defence is that retrieved cards are always shown to a model as
 * untrusted data with their provenance, never as instructions.
 */

interface RegexRuleSpec {
  readonly id: string;
  readonly category: Category;
  readonly severity: Severity;
  readonly description: string;
  readonly pattern: RegExp;
  readonly message: string;
  /** When set, the rule can sanitize: matches are replaced with this text. */
  readonly replacement?: string;
}

function regexRule(spec: RegexRuleSpec): Rule {
  const global = spec.pattern.global
    ? spec.pattern
    : new RegExp(spec.pattern.source, `${spec.pattern.flags}g`);
  const find = (text: string): readonly RuleHit[] => {
    const hits: RuleHit[] = [];
    for (const match of text.matchAll(global)) {
      if (match[0].length === 0) continue;
      const start = match.index ?? 0;
      hits.push({ span: { start, end: start + match[0].length }, message: spec.message });
    }
    return hits;
  };
  const base = {
    id: spec.id,
    category: spec.category,
    severity: spec.severity,
    description: spec.description,
    find,
  };
  if (spec.replacement === undefined) return base;
  const replacement = spec.replacement;
  return { ...base, sanitize: (text) => text.replace(global, replacement) };
}

// --- obfuscation --------------------------------------------------------------------------------

/** Zero-width and bidirectional-control characters: invisible to a reader, seen by a model. */
/**
 * Code points that render as nothing (or reorder text) yet reach a model as characters. Held as a
 * table of numbers so this file never has to contain the invisible characters themselves.
 */
const INVISIBLE_CODE_POINTS: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space/joiners and directional marks
  [0x202a, 0x202e], // bidirectional embeddings and overrides
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x2066, 0x2069], // bidirectional isolates
  [0xfeff, 0xfeff], // zero-width no-break space
];

const hex = (codePoint: number) => String.raw`\u{${codePoint.toString(16)}}`;
const INVISIBLE = new RegExp(
  `[${INVISIBLE_CODE_POINTS.map(([from, to]) => (from === to ? hex(from) : `${hex(from)}-${hex(to)}`)).join('')}]`,
  'gu',
);

/** The Unicode "tag" block encodes ASCII invisibly, which can carry a whole hidden instruction. */
const UNICODE_TAGS = /[\u{E0000}-\u{E007F}]/gu;

/** A word that mixes Latin letters with Cyrillic or Greek ones, the classic lookalike trick. */
function mixedScriptHits(text: string): readonly RuleHit[] {
  const hits: RuleHit[] = [];
  for (const word of text.matchAll(/[\p{L}\p{M}]+/gu)) {
    const token = word[0];
    const latin = /\p{Script=Latin}/u.test(token);
    const lookalike = /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(token);
    if (latin && lookalike) {
      const start = word.index ?? 0;
      hits.push({
        span: { start, end: start + token.length },
        message: 'A word mixes Latin letters with Cyrillic or Greek lookalikes.',
      });
    }
  }
  return hits;
}

// --- injection ----------------------------------------------------------------------------------

/** "Ignore/disregard/forget ... previous/prior/all ... instructions/rules/context". */
const INSTRUCTION_OVERRIDE =
  /\b(?:ignore|disregard|forget|override|bypass|discard)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|every|your|the|these|those)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules?|guidelines?|directions?|constraints|context|programming)\b/i;

/** Attempts to reassign the model's role or reveal its configuration. */
const ROLE_REASSIGNMENT = new RegExp(
  [
    String.raw`\byou\s+are\s+(?:now|no\s+longer)\b`,
    String.raw`(?:^|[.!?]\s+)(?:act|behave|respond|pretend)\s+(?:as|like)\s+(?:a|an|if)\b`,
    String.raw`\bnew\s+(?:instructions?|task|role|objective)\s*:`,
    String.raw`\b(?:reveal|print|repeat|output|show)\b[^.\n]{0,30}\b(?:system|initial|hidden)\s+prompt\b`,
    String.raw`\bdo\s+not\s+(?:tell|inform|mention|reveal)[^.\n]{0,30}\b(?:user|human|operator)\b`,
  ].join('|'),
  'im',
);

/** Chat-template control tokens and role delimiters. */
const CHAT_ROLE_MARKERS = new RegExp(
  [
    String.raw`<\|(?:im_start|im_end|system|user|assistant|endoftext|begin_of_text|eot_id)\|>`,
    String.raw`\[/?INST\]`,
    String.raw`<<\/?SYS>>`,
    String.raw`<\/?(?:system|assistant|instructions?)>`,
    String.raw`^#{2,4}\s*(?:system|instruction|assistant)\s*:?\s*$`,
  ].join('|'),
  'im',
);

/** Text shaped like a tool or function call, which some models will act on. */
const TOOL_CALL_SYNTAX = new RegExp(
  [
    String.raw`<\/?(?:tool_call|tool_use|function_calls?|invoke|antml:[a-z_]+)\b`,
    String.raw`"(?:tool|function)_?(?:name|call)"\s*:`,
    String.raw`\`\`\`\s*(?:tool|function)[_-]?call`,
  ].join('|'),
  'i',
);

/** Second-person imperatives aimed at the reader, in bulk. */
const IMPERATIVE =
  /\b(?:you\s+(?:must|should|will|need\s+to|are\s+to)|always|never|make\s+sure\s+(?:to|that)|do\s+not|don't|remember\s+to|ensure\s+that\s+you)\b/gi;

function imperativeDensityHits(
  text: string,
  minHits: number,
  perWords: number,
): readonly RuleHit[] {
  const matches = [...text.matchAll(IMPERATIVE)];
  if (matches.length < minHits) return [];
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  if (words === 0 || matches.length * perWords < words) return [];
  return [
    {
      span: { start: 0, end: text.length },
      message: `${matches.length} imperative phrases in ${words} words reads like instructions, not description.`,
    },
  ];
}

// --- exfiltration & hidden content --------------------------------------------------------------

const HIDDEN_MARKUP = new RegExp(
  [
    String.raw`<!--[\s\S]*?-->`,
    String.raw`^\[\/\/\]:\s*#\s*[("'].*$`,
    String.raw`<\s*(?:script|iframe|object|embed)\b[\s\S]*?(?:<\/\s*(?:script|iframe|object|embed)\s*>|$)`,
    String.raw`<[^>]+style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?(?:<\/[a-z]+>|$)`,
  ].join('|'),
  'gim',
);

/** A remote image: fetching it can carry data out in the URL. */
const EXFILTRATION_IMAGE =
  /!\[[^\]]*\]\((?:https?:)?\/\/[^)\s]+\)|<img\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\/[^"']+["'][^>]*>/gi;

// --- secrets ------------------------------------------------------------------------------------

const SECRET_MATERIAL = new RegExp(
  [
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{36,}\b`,
    String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}\b`,
    String.raw`\bsk-[A-Za-z0-9_-]{20,}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{35}\b`,
    String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`,
    String.raw`\b(?:api[_-]?key|secret|token|passw(?:or)?d)\b\s*[:=]\s*["'][^"'\s]{16,}["']`,
  ].join('|'),
  'gi',
);

export interface RuleOptions {
  /** Shortest run of base64 or hex characters treated as an encoded blob. */
  readonly blobMinLength?: number;
  /** Imperative phrases needed before density is judged. */
  readonly imperativeMinHits?: number;
  /** One imperative per this many words, or denser, is flagged. */
  readonly imperativeEveryWords?: number;
}

/**
 * Detection thresholds, named and overridable. They tune what counts as "a lot", not how much
 * data is allowed, so they are settings of the rules and not limits on the index.
 */
const DEFAULT_BLOB_MIN_LENGTH = 200;
const DEFAULT_IMPERATIVE_MIN_HITS = 3;
const DEFAULT_IMPERATIVE_EVERY_WORDS = 40;

export function defaultRules(options: RuleOptions = {}): readonly Rule[] {
  const blobMin = options.blobMinLength ?? DEFAULT_BLOB_MIN_LENGTH;
  const minHits = options.imperativeMinHits ?? DEFAULT_IMPERATIVE_MIN_HITS;
  const everyWords = options.imperativeEveryWords ?? DEFAULT_IMPERATIVE_EVERY_WORDS;

  return [
    regexRule({
      id: 'invisible-characters',
      category: 'obfuscation',
      severity: 'medium',
      description: 'Zero-width or bidirectional control characters.',
      pattern: INVISIBLE,
      message: 'Invisible control character.',
      replacement: '',
    }),
    regexRule({
      id: 'unicode-tag-characters',
      category: 'obfuscation',
      severity: 'high',
      description: 'Unicode tag characters, which can encode a hidden instruction.',
      pattern: UNICODE_TAGS,
      message: 'Unicode tag character (invisible ASCII smuggling).',
    }),
    {
      id: 'mixed-script-words',
      category: 'obfuscation',
      severity: 'medium',
      description: 'Words that mix Latin with Cyrillic or Greek lookalike letters.',
      find: mixedScriptHits,
    },
    regexRule({
      id: 'instruction-override',
      category: 'injection',
      severity: 'high',
      description: 'Text telling a model to ignore or replace its instructions.',
      pattern: INSTRUCTION_OVERRIDE,
      message: 'Tells the reader to ignore or override its instructions.',
    }),
    regexRule({
      id: 'role-reassignment',
      category: 'injection',
      severity: 'medium',
      description: "Text trying to reassign a model's role or extract its configuration.",
      pattern: ROLE_REASSIGNMENT,
      message: "Tries to reassign the reader's role or reveal its configuration.",
    }),
    regexRule({
      id: 'chat-role-markers',
      category: 'injection',
      severity: 'high',
      description: 'Chat-template control tokens or role delimiters.',
      pattern: CHAT_ROLE_MARKERS,
      message: 'Contains a chat-template role marker.',
    }),
    regexRule({
      id: 'tool-call-syntax',
      category: 'injection',
      severity: 'high',
      description: 'Text shaped like a tool or function call.',
      pattern: TOOL_CALL_SYNTAX,
      message: 'Contains tool-call syntax.',
    }),
    {
      id: 'imperative-density',
      category: 'injection',
      severity: 'low',
      description: 'Prose that is mostly second-person commands.',
      find: (text) => imperativeDensityHits(text, minHits, everyWords),
    },
    regexRule({
      id: 'hidden-markup',
      category: 'obfuscation',
      severity: 'medium',
      description: 'HTML comments, hidden elements and scripts.',
      pattern: HIDDEN_MARKUP,
      message: 'Hidden markup that a reader would not see.',
      replacement: '',
    }),
    regexRule({
      id: 'exfiltration-markup',
      category: 'exfiltration',
      severity: 'medium',
      description: 'Remote images, whose fetch can leak data in the URL.',
      pattern: EXFILTRATION_IMAGE,
      message: 'Remote image that could carry data out.',
      replacement: '',
    }),
    regexRule({
      id: 'encoded-blob',
      category: 'obfuscation',
      severity: 'medium',
      description: 'Long runs of base64 or hexadecimal.',
      pattern: new RegExp(
        `(?:[A-Za-z0-9+/]{${blobMin},}={0,2}|\\b[0-9a-fA-F]{${blobMin},}\\b)`,
        'g',
      ),
      message: 'Long encoded blob.',
      replacement: '[encoded data removed]',
    }),
    regexRule({
      id: 'secret-material',
      category: 'secrets',
      severity: 'high',
      description: 'Credentials, private keys and tokens.',
      pattern: SECRET_MATERIAL,
      message: 'Looks like a credential.',
      replacement: '[redacted]',
    }),
  ];
}
