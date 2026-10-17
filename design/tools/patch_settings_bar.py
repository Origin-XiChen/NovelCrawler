# -*- coding: utf-8 -*-
"""阶段二 D:设置页改为"单一吸底保存条"。

问题:通用/小说/漫画等分类各自在页面中部放一个"保存设置"按钮,
用户在下方改完设置得往回滚才能保存;不同分类的按钮位置还不一致。
改法:
  * 删掉分类内的两个(仅有的)保存按钮;
  * 在 .settings-main 末尾放一条吸底操作条(保存 / 放弃修改 + 提示);
  * 提示文案说明"部分设置需重启生效",降低"改了没生效"的误解。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, "static", "index.html")

INLINE_SAVE = ('            <div style="margin-top:16px">'
               '<button class="btn btn-primary" onclick="saveSettingsPage()">保存设置</button></div>\n')

CSS_ANCHOR = "  .settings-main h3 { font-size:15px; font-weight:700; color:var(--text); }"
CSS_NEW = """  .settings-main h3 { font-size:15px; font-weight:700; color:var(--text); }
  /* 单一吸底保存条:原来每个分类中部各有一个"保存设置",改完下方的设置要往回滚 */
  .settings-savebar {
    position:sticky; bottom:0; z-index:6;
    display:flex; align-items:center; gap:10px; flex-wrap:wrap;
    margin:22px -26px -20px; padding:12px 26px;
    background:var(--card); border-top:1px solid var(--border);
    box-shadow:0 -6px 18px color-mix(in srgb, #000 9%, transparent);
  }
  .settings-savebar .sb-hint { font-size:12px; color:var(--muted); flex:1; min-width:180px; }
  [data-theme="dark"] .settings-savebar { box-shadow:0 -6px 18px rgba(0,0,0,.45); }"""


def main() -> int:
    text = io.open(TARGET, encoding="utf-8").read()

    # 1) CSS
    if CSS_ANCHOR in text:
        text = text.replace(CSS_ANCHOR, CSS_NEW, 1)
        print("  [OK] 吸底保存条样式")
    else:
        print("  [跳过] CSS 锚点未匹配")

    # 2) 删掉分类内的保存按钮
    n = text.count(INLINE_SAVE)
    if n:
        text = text.replace(INLINE_SAVE, "")
        print(f"  [OK x{n}] 移除分类内保存按钮")
    else:
        print("  [跳过] 分类内保存按钮未匹配(缩进可能不同)")
        # 退化处理:用正则兜住缩进差异
        import re
        pat = re.compile(r'[ \t]*<div style="margin-top:16px">'
                         r'<button class="btn btn-primary" onclick="saveSettingsPage\(\)">保存设置</button>'
                         r'</div>\n')
        text, k = pat.subn("", text)
        print(f"  [正则回退 x{k}] 移除分类内保存按钮")

    # 3) 在设置主体末尾插入吸底条
    bar = """
      <div class="settings-savebar">
        <span class="sb-hint" id="setSaveHint">修改后记得保存;代理 / 局域网访问等设置需重启应用生效</span>
        <button class="btn btn-ghost" onclick="loadSettingsPage()" title="重新读取已保存的设置,丢弃当前修改">放弃修改</button>
        <button class="btn btn-primary" onclick="saveSettingsPage()">保存设置</button>
      </div>
"""
    # .settings-main 的闭合 </div> 在最后一个 setcat 之后:找 "id=\"setcat-phone\"" 之后第一个
    # 顶格缩进的 "    </div>"(结束 settings-main)
    anchor = "    </div>\n  </div>\n</div>\n"
    idx = text.find('id="setcat-phone"')
    if idx > 0:
        end = text.find(anchor, idx)
        if end > 0:
            text = text[:end] + bar + text[end:]
            print("  [OK] 插入吸底保存条")
        else:
            print("  [跳过] 未找到 settings-main 结束锚点")
    else:
        print("  [跳过] 未找到 setcat-phone")

    io.open(TARGET, "w", encoding="utf-8", newline="\n").write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())