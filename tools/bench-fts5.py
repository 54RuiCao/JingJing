"""P0-7 补充：用 SQLite FTS5 验证"全文检索 < 1s"是否可达（不需要 API Key，可独立完成）。
重点回答两个工程问题：
  1. 中文检索该用哪种 tokenizer（unicode61 对 CJK 几乎不可用；trigram 要求查询 >= 3 字符）
  2. 索引构建耗时、体积、查询延迟到底是多少
"""
import os, re, sqlite3, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXT = os.path.join(ROOT, "fixtures", "huge.txt")
DBDIR = os.path.join(ROOT, "fixtures")

text = open(TEXT, encoding="utf-8").read()
chapters = [c for c in re.split(r"\n(?=第\d+章)", text) if c.strip()]
print(f"文本 {len(text):,} 字符，切出 {len(chapters)} 章")
print("sqlite:", sqlite3.sqlite_version)

def build(mode: str):
    path = os.path.join(DBDIR, f"fts-{mode}.db")
    if os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path)
    con.execute("CREATE VIRTUAL TABLE ft USING fts5(title, body, tokenize=%s)" % (
        "'trigram'" if mode == "trigram" else "'unicode61'"))
    rows = []
    for ch in chapters:
        head, _, body = ch.partition("\n")
        if mode == "spaced":
            rows.append((" ".join(head), " ".join(ch)))
        else:
            rows.append((head, ch))
    t0 = time.time()
    con.executemany("INSERT INTO ft VALUES (?, ?)", rows)
    con.commit()
    build_s = time.time() - t0
    size_mb = os.path.getsize(path) / 1048576
    return con, build_s, size_mb

def query_ms(con, sql, params=()):
    t0 = time.time()
    try:
        n = len(con.execute(sql, params).fetchall())
        return round((time.time() - t0) * 1000, 2), n, None
    except Exception as e:
        return None, None, str(e)

for mode in ("unicode61", "spaced", "trigram"):
    con, build_s, size_mb = build(mode)
    print(f"\n== {mode} ==  构建 {build_s:.2f}s，库体积 {size_mb:.1f}MB")
    if mode == "trigram":
        for q in ("记忆", "雨声", "路灯下"):
            ms, n, err = query_ms(con, "SELECT rowid FROM ft WHERE ft MATCH ?", (q,))
            print(f"  MATCH {q!r:>8}: {ms} ms, 命中 {n} 行 {err or ''}")
    elif mode == "spaced":
        for q in ("记忆", "雨声", "路灯"):
            phrase = '"' + " ".join(q) + '"'
            ms, n, err = query_ms(con, "SELECT rowid FROM ft WHERE ft MATCH ?", (phrase,))
            print(f"  MATCH {q!r:>8} (逐字短语): {ms} ms, 命中 {n} 行 {err or ''}")
    else:
        for q in ("记忆", "雨声"):
            ms, n, err = query_ms(con, "SELECT rowid FROM ft WHERE ft MATCH ?", (q,))
            print(f"  MATCH {q!r:>8}: {ms} ms, 命中 {n} 行 {err or ''}")
        ms, n, err = query_ms(con, "SELECT rowid FROM ft WHERE body LIKE ?", ("%记忆%",))
        print(f"  LIKE   '记忆': {ms} ms, 命中 {n} 行 {err or ''}")
    con.close()
