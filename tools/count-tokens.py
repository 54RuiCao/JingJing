import json, re, sys, pathlib
from tokenizers import Tokenizer

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOK = ROOT / "tools" / "deepseek-tokenizer" / "deepseek_v4_tokenizer" / "tokenizer.json"
tk = Tokenizer.from_file(str(TOK))

def count(text: str) -> int:
    return len(tk.encode(text, add_special_tokens=False).ids)

samples = {
    "短句": "他站在窗前，看着楼下的街道被暮色一点点浸透。",
    "英文句": "The quick brown fox jumps over the lazy dog.",
    "中英混排": "这是一段包含 English words 与数字 12345 的段落。",
}

print("== 样本 ==")
for name, s in samples.items():
    n = count(s)
    print(f"{name}: {len(s)} 字符 -> {n} token ({n/len(s):.3f} token/字符)")

big = ROOT / "fixtures" / "huge.txt"
if big.exists():
    text = big.read_text(encoding="utf-8")
    n = count(text)
    print()
    print("== fixtures/huge.txt ==")
    print(f"字符数: {len(text):,}")
    print(f"token 数: {n:,}")
    print(f"比例: {n/len(text):.3f} token/字符")
    print()
    print("== 外推到常见书籍体量 ==")
    ratio = n / len(text)
    for chars in (100_000, 200_000, 300_000, 500_000, 1_000_000, 1_500_000, 3_000_000):
        t = int(chars * ratio)
        print(f"{chars/10000:>6.0f} 万字 -> 约 {t:,} token  (占 1M 上下文 {t/1_000_000*100:.1f}%)")
