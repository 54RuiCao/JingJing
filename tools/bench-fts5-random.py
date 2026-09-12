"""P0-7 补充（续）：用**非重复**语料复核 FTS5 的构建耗时与体积，避免被重复文本误导。"""
import os, random, sqlite3, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DBDIR = os.path.join(ROOT, "fixtures")

# 用常用汉字表生成 210 万字的非重复语料
random.seed(42)
BASE = "的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感"
DIGITS = "0123456789"
LATIN = "abcdefghijklmnopqrstuvwxyz "

def make_corpus(total_chars):
    parts = []
    n = 0
    while n < total_chars:
        # 随机长度 20-60 的"句子"
        L = random.randint(20, 60)
        s = "".join(random.choice(BASE) for _ in range(L))
        # 偶尔混入数字/英文/标点
        if random.random() < 0.3:
            s += random.choice(["2026", "ABC", " ", "，", "。", "："])
        parts.append(s)
        n += len(s) + 1
    return "\n".join(parts)

text = make_corpus(2_100_000)
print(f"非重复语料 {len(text):,} 字符，去重字符数 {len(set(text))}")

path = os.path.join(DBDIR, "fts-random.db")
if os.path.exists(path):
    os.remove(path)
con = sqlite3.connect(path)
con.execute("CREATE VIRTUAL TABLE ft USING fts5(body, tokenize='unicode61')")

# 按 2000 字分块入库
chunks = [text[i:i + 2000] for i in range(0, len(text), 2000)]
rows = [(" ".join(c),) for c in chunks]
t0 = time.time()
con.executemany("INSERT INTO ft VALUES (?)", rows)
con.commit()
build_s = time.time() - t0
size_mb = os.path.getsize(path) / 1048576
print(f"分块 {len(chunks)}，构建 {build_s:.2f}s，库体积 {size_mb:.1f}MB（{size_mb*1024*1024/len(text):.2f} 字节/字符）")

def q(term):
    phrase = '"' + " ".join(term) + '"'
    t = time.time()
    rows = con.execute("SELECT count(*) FROM ft WHERE ft MATCH ?", (phrase,)).fetchone()
    return round((time.time() - t) * 1000, 3), rows[0]

# 从语料里挑真实存在的 2/3/4 字串做查询
for L in (2, 3, 4):
    probe = text[500000:500000 + L]
    ms, n = q(probe)
    print(f"查询 {probe!r}（{L} 字）: {ms} ms，命中块 {n}")
con.close()
