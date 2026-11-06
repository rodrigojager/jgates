"""Regenerates sidecar/config/codespell-ignore-pt-br.txt. The Portuguese (pt-BR) words that codespell's English typo lists would report: every misspelling key of codespell's
`clear` and `rare` dictionaries that the pt-BR Hunspell dictionary (VERO, LibreOffice) accepts as a word, including its
inflected forms. Written one per line, sorted, for codespell's --ignore-words.

Usage: build_ignore.py <codespell_keys.txt> <pt_BR dir> <out.txt>
"""
import sys

from spylls.hunspell import Dictionary

keys_file, dic_dir, out = sys.argv[1], sys.argv[2], sys.argv[3]
pt = Dictionary.from_files(f"{dic_dir}/pt_BR")

keys = set()
for line in open(keys_file, encoding="utf-8"):
    if "->" in line:
        key = line.split("->", 1)[0].strip().lower()
        if key and key.isalpha():
            keys.add(key)

found = sorted(k for k in keys if pt.lookup(k))
with open(out, "w", encoding="utf-8", newline="\n") as f:
    for k in found:
        f.write(k + "\n")
print(len(keys), "codespell keys;", len(found), "are pt-BR words")
print("sample:", ", ".join(found[:40]))
