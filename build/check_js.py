import os, re, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
html = open(os.path.join(ROOT, "static", "index.html"), encoding="utf-8").read()
blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S)
fails = 0
for i, b in enumerate(blocks):
    p = os.path.join(ROOT, "build", f"chk_{i}.js")
    open(p, "w", encoding="utf-8").write(b)
    r = subprocess.run([r"C:\Program Files\nodejs\node.exe", "--check", p], capture_output=True, text=True)
    print(f"  块{i} {'ok' if r.returncode==0 else 'FAIL'} ({len(b)} 字符)")
    if r.returncode: print(r.stderr[:300]); fails += 1
print("JS 全部通过" if not fails else "JS 有错误")
sys.exit(1 if fails else 0)

