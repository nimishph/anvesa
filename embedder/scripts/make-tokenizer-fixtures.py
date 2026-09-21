"""Regenerate src/__fixtures__/{bpe,unigram,unigram-precompiled}.* with Hugging Face `tokenizers`.

The tokenizers here are trained on this repository's own text, so the fixtures are small; the
expected ids are what the reference implementation gives, and the tests assert ours match.

    pip install tokenizers
    python scripts/make-tokenizer-fixtures.py [path/to/multilingual-e5-small/tokenizer.json]

The optional argument supplies a real SentencePiece charsmap for the Precompiled normaliser test.
"""
import glob
import json
import os
import random
import sys

from tokenizers import Regex, Tokenizer, models, normalizers, pre_tokenizers, processors, trainers

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, "..", "src", "__fixtures__")
root = os.path.join(here, "..", "..")

lines = []
for path in sorted(glob.glob(os.path.join(root, "*", "src", "*.ts"))):
    with open(path, encoding="utf-8") as handle:
        lines += [line for line in handle.read().split("\n") if line.strip()]
random.seed(11)
random.shuffle(lines)
corpus = lines[:1200]

extra = [
    "def f(x):\n    return x  # comment\n\tif y:\n\t\tpass",
    "snake_case camelCase PascalCase kebab-case HTTPServer parseURL getX2",
    "  indented and   spaced  ",
    "don't we'll they're I'm you've he'd",
    "3.14159e-10 0xDEADBEEF 1_000_000",
    "日本語 mixed with english and 中文",
    "ǅ İstanbul café ﬁnance ①②③ ｆｕｌｌｗｉｄｔｈ",
    "emoji 🎉 and 😀 and tab\tand\nnewlines\r\n",
    "",
    " ",
    "a" * 150,
    "\u00a0nbsp and \u200bzero width",
]
texts = corpus[:150] + extra
special = ["<s>", "<pad>", "</s>", "<unk>"]


def golden(tokenizer, name):
    rows = []
    for text in texts:
        encoded = tokenizer.encode(text, add_special_tokens=True)
        bare = tokenizer.encode(text, add_special_tokens=False)
        rows.append({"text": text, "ids": encoded.ids, "bare": len(bare.ids)})
    with open(os.path.join(out, f"{name}.golden.json"), "w", encoding="utf-8") as handle:
        json.dump(rows, handle, ensure_ascii=False)


# Byte-level BPE, as RoBERTa: no normaliser, ByteLevel pre-tokenizer, <s> ... </s>.
bpe = Tokenizer(models.BPE())
bpe.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
bpe.train_from_iterator(
    corpus,
    trainers.BpeTrainer(
        vocab_size=700,
        special_tokens=special,
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
    ),
)
bpe.post_processor = processors.RobertaProcessing(
    sep=("</s>", bpe.token_to_id("</s>")), cls=("<s>", bpe.token_to_id("<s>")), add_prefix_space=False
)
bpe.save(os.path.join(out, "bpe.tokenizer.json"))
golden(bpe, "bpe")

# Unigram, as a SentencePiece model: NFKC, collapsed spaces, Metaspace, <s> ... </s>.
uni = Tokenizer(models.Unigram())
uni.normalizer = normalizers.Sequence([normalizers.NFKC(), normalizers.Replace(Regex(" {2,}"), " ")])
uni.pre_tokenizer = pre_tokenizers.Metaspace()
uni.train_from_iterator(
    corpus,
    trainers.UnigramTrainer(vocab_size=600, special_tokens=special, unk_token="<unk>"),
)
uni.post_processor = processors.TemplateProcessing(
    single="<s> $A </s>",
    special_tokens=[("<s>", uni.token_to_id("<s>")), ("</s>", uni.token_to_id("</s>"))],
)
uni.save(os.path.join(out, "unigram.tokenizer.json"))
golden(uni, "unigram")

# The same unigram model behind SentencePiece's own normalisation table, when one is supplied.
if len(sys.argv) > 1:
    with open(sys.argv[1], encoding="utf-8") as handle:
        real = json.load(handle)
    charsmap = real["normalizer"]["normalizers"][0]["precompiled_charsmap"]
    pre = Tokenizer.from_file(os.path.join(out, "unigram.tokenizer.json"))
    document = json.loads(pre.to_str())
    document["normalizer"] = {
        "type": "Sequence",
        "normalizers": [
            {"type": "Precompiled", "precompiled_charsmap": charsmap},
            {"type": "Replace", "pattern": {"Regex": " {2,}"}, "content": " "},
        ],
    }
    document["pre_tokenizer"] = {"type": "Metaspace", "replacement": "\u2581", "add_prefix_space": True}
    with open(os.path.join(out, "unigram-precompiled.tokenizer.json"), "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False)
    golden(Tokenizer.from_file(os.path.join(out, "unigram-precompiled.tokenizer.json")), "unigram-precompiled")
