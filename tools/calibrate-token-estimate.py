import pathlib, sys
from tokenizers import Tokenizer
ROOT = pathlib.Path(__file__).resolve().parent.parent
tk = Tokenizer.from_file(str(ROOT / "tools" / "deepseek-tokenizer" / "deepseek_v4_tokenizer" / "tokenizer.json"))
p = pathlib.Path(sys.argv[1])
text = p.read_text(encoding="utf-8")
cjk = sum(1 for ch in text if 0x2e80 <= ord(ch) <= 0xffef)
other = len(text) - cjk
n = len(tk.encode(text, add_special_tokens=False).ids)
print(f"file={p.name} chars={len(text):,} cjk={cjk:,} ({cjk/len(text)*100:.1f}%) other={other:,}")
print(f"real_tokens={n:,}  ratio_overall={n/len(text):.4f}")
# 分档估算：把非 CJK 按经验 0.25 计，反推 CJK 单价
est_other = other * 0.25
print(f"if other=0.25/char -> {est_other:,.0f} tokens; implies cjk ratio = {(n-est_other)/cjk:.4f}")
# 逐块抽样：纯中文段落 vs 空白
import re
zh_only = "".join(ch for ch in text if 0x2e80 <= ord(ch) <= 0xffef)
nz = len(tk.encode(zh_only, add_special_tokens=False).ids)
print(f"only-cjk tokens={nz:,} ratio={nz/len(zh_only):.4f}")
ws = "".join(ch for ch in text if ch in "\n ")
nw = len(tk.encode(ws, add_special_tokens=False).ids)
print(f"whitespace-only chars={len(ws):,} tokens={nw:,} ratio={nw/max(1,len(ws)):.4f}")
ascii_other = "".join(ch for ch in text if ord(ch) < 0x2e80 and ch not in "\n ")
na = len(tk.encode(ascii_other, add_special_tokens=False).ids) if ascii_other else 0
print(f"ascii-other chars={len(ascii_other):,} tokens={na:,} ratio={na/max(1,len(ascii_other)):.4f}")
