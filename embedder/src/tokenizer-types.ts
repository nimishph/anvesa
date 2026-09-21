/**
 * Turns text into the ids a model reads. It is the model's own tokenizer, so `count` says exactly
 * how much of the model's window a text will take, and card budgets built on it are exact.
 */
export interface Tokenizer {
  /** Ids of the text itself, with none of the tokens the model adds around it. */
  tokenize(text: string): number[];
  /** Tokens `text` takes, not counting the ones the model adds around it. */
  count(text: string): number;
  /** `[CLS] text [SEP]`: what the model is given. */
  encode(text: string): number[];
  /** Tokens the model adds around every text. */
  readonly specialTokens: number;
  readonly padId: number;
  readonly vocabSize: number;
}
