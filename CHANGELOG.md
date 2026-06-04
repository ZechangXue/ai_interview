# 更新日志

## v1.1.0

- 应用版本与安装包：`AI.Setup.1.1.0.exe`（由 `package.json` → electron-builder 生成）
- 静态下载页（`ai-interview/`、`download-site/`）：`meta app-version`、下载链接与文案已同步 **v1.1.0**
- 设置页：移除 System Prompt 相关展示；底层 prompt 拼接逻辑不变
- 极简模式：预取展开仅更新界面；**点击「可读答案」** 后将当前卡片的「一句 + 展开」写入会话实录与 `[CONVERSATION]` 摘要，与一键导出一致

发布 GitHub Release 时请上传 **`AI.Setup.1.1.0.exe`**，并与页面链接 `.../v1.1.0/AI.Setup.1.1.0.exe` 一致。
