"""检查生成的 EPUB 结构（mimetype 是否首个条目、zip 能否通过校验）。

用法：python tools/verify-epub.py [fixtures/huge.epub]
"""
import zipfile, sys

p = sys.argv[1] if len(sys.argv) > 1 else "fixtures/huge.epub"
z = zipfile.ZipFile(p)
names = z.namelist()
print("条目数:", len(names))
print("前 6 项:", names[:6])
print("bad:", z.testzip())
print("mimetype 是首个条目:", names[0] == "mimetype")
