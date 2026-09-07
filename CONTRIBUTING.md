# 贡献指南(Contributing)

欢迎 Issue 与 PR!提交前请花一分钟阅读本指南。

## 提交 Issue

- **安全漏洞**:请走 [私有安全咨询](SECURITY.md),不要公开描述可利用细节;
- **书源/漫画源失效**:站点极易迁移,请附「站点域名 + 搜索/正文页 URL + 现象(如返回推荐页)」,便于判断是规则失效还是站点死亡;
- **功能建议**:说明使用场景,而不仅是「加一个 X 功能」。

## 提交 PR

1. Fork → 新建分支 → 修改 → 自测 → 提交 PR,一个 PR 聚焦一件事;
2. 代码约定(与现有风格保持一致):
   - Python:中文注释与日志、`type hints` 尽量齐全、异常兜底用 `except Exception as e: # noqa: BLE001` 并带降级,不引入重量级依赖(能用标准库就用标准库);
   - 前端:`static/index.html` 为单文件主体,阅读器共享内核在 `static/reader-core.js`;**改动阅读器 DOM/样式后需重跑 `_build_reader.py`** 重新生成 `reader.html`;
3. 自测清单:
   ```bash
   python -m compileall gui_server.py novel/        # 语法
   node --check static/reader-core.js               # 前端内核
   python start.py --port 8899                      # 冒烟:搜索/下载/阅读主路径
   ```
4. 新增运行时数据文件(书架/缓存/配置类)请同步加入 `.gitignore`——**任何用户个人数据不得入库**;
5. 提交即表示你同意以 **GPL-3.0** 授权你的贡献。
