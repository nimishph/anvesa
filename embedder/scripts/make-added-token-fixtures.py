"""Regenerate src/__fixtures__/*-added.* with Hugging Face `tokenizers`.

The tokenizers are the existing bpe and unigram fixtures with ordinary (non-special) added tokens
put on them, the way ModernBERT ships placeholders and runs of spaces. The expected ids are what the
reference gives with special tokens read as text (`encode_special_tokens`), which is what anvesa does.

    pip install tokenizers
    python scripts/make-added-token-fixtures.py
"""
import json
import os

from tokenizers import AddedToken, Tokenizer, pre_tokenizers, processors

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, "..", "src", "__fixtures__")

texts = [
    "",
    " ",
    "plain text with nothing added",
    "|||IP_ADDRESS|||",
    "connect to |||IP_ADDRESS||| now",
    "mail |||EMAIL|||,|||PHONE_NUMBER||| or |||EMAIL|||.",
    "|||EMAIL||||||EMAIL|||",
    "||| not a token |||",
    "|||IP_ADDRESS",
    "a  b   c    d     e        f         g",
    "def f(x):\n    return x\n        deeper",
    "        leading spaces and trailing        ",
    "TODO: fix TODOs and xTODO and TODO_ but TODO.",
    "TODO",
    "日本TODO語 and 🎉TODO🎉",
    "left   <<   strip and @@   right strip",
    "<<<<@@@@",
    "ＴＯＤＯ in fullwidth, and ＴＯＤＯ: again",
    "the <s> and </s> and <pad> stay text",
    "snake_case camelCase |||EMAIL|||kebab-case",
    "emoji 🎉 |||EMAIL||| tab\tand\nnewlines\r\n",
]

added = [
    AddedToken("|||IP_ADDRESS|||", normalized=False, special=False),
    AddedToken("|||EMAIL|||", normalized=False, special=False),
    AddedToken("|||PHONE_NUMBER|||", normalized=False, special=False),
    AddedToken("  ", normalized=False, special=False),
    AddedToken("    ", normalized=False, special=False),
    AddedToken("        ", normalized=False, special=False),
    AddedToken("TODO", single_word=True, normalized=False, special=False),
    AddedToken("<<", lstrip=True, normalized=False, special=False),
    AddedToken("@@", rstrip=True, normalized=False, special=False),
]


def golden(tokenizer, name, literals=True):
    tokenizer.encode_special_tokens = True
    tokenizer.save(os.path.join(out, f"{name}.tokenizer.json"))
    rows = []
    for text in texts:
        # A unigram model can still pick the piece "<s>" from its vocabulary; anvesa keeps special
        # pieces out of reach of text on purpose (see the "literal special tokens" test), so those
        # texts are compared for byte-level BPE only, where the reference agrees.
        if not literals and "<s>" in text:
            continue
        encoded = tokenizer.encode(text, add_special_tokens=True)
        bare = tokenizer.encode(text, add_special_tokens=False)
        rows.append({"text": text, "ids": encoded.ids, "bare": len(bare.ids)})
    with open(os.path.join(out, f"{name}.golden.json"), "w", encoding="utf-8") as handle:
        json.dump(rows, handle, ensure_ascii=False)


bpe = Tokenizer.from_file(os.path.join(out, "bpe.tokenizer.json"))
bpe.add_tokens(added)
golden(bpe, "bpe-added")

prefixed = Tokenizer.from_file(os.path.join(out, "bpe.tokenizer.json"))
prefixed.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=True)
prefixed.post_processor = processors.RobertaProcessing(
    ("</s>", prefixed.token_to_id("</s>")),
    ("<s>", prefixed.token_to_id("<s>")),
    add_prefix_space=True,
)
prefixed.add_tokens(added)
golden(prefixed, "bpe-added-prefix")

# Unigram behind NFKC: tokens left to be normalized are found in the normalized text, by their own
# normalized content, so a fullwidth ＴＯＤＯ is the TODO token.
uni = Tokenizer.from_file(os.path.join(out, "unigram.tokenizer.json"))
uni.add_tokens(
    [
        AddedToken("|||EMAIL|||", normalized=False, special=False),
        AddedToken("TODO", single_word=True, normalized=True, special=False),
        AddedToken("ＩＰ", normalized=True, special=False),
    ]
)
golden(uni, "unigram-added", literals=False)

first = Tokenizer.from_file(os.path.join(out, "unigram.tokenizer.json"))
first.pre_tokenizer = pre_tokenizers.Metaspace(prepend_scheme="first")
first.add_tokens([AddedToken("|||EMAIL|||", normalized=False, special=False)])
golden(first, "unigram-added-first", literals=False)
