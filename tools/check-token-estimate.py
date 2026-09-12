import sys, pathlib
from tokenizers import Tokenizer

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOK = ROOT / "tools" / "deepseek-tokenizer" / "deepseek_v4_tokenizer" / "tokenizer.json"
tk = Tokenizer.from_file(str(TOK))

path = pathlib.Path(sys.argv[1])
stored = int(sys.argv[2]) if len(sys.argv) > 2 else None
text = path.read_text(encoding="utf-8")
real = len(tk.encode(text, add_special_tokens=False).ids)
print("文件:", path)
print("字符数:", f"{len(text):,}")
print("官方 tokenizer 实测:", f"{real:,}")
print("比例:", f"{real/len(text):.4f} token/字符")
if stored:
    err = (stored - real) / real * 100
    print("界面估算:", f"{stored:,}")
    print("偏差:", f"{err:+.1f}%")
