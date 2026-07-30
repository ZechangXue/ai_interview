# 过了么AI — 官网静态页（下载 / 演示）

## Cloudflare Pages 配置建议

1. **构建命令**：留空或 `exit 0`（纯静态，无需构建）。
2. **输出目录（Root / Output）**：填 **`ai-interview`**（若仓库根目录下本文件夹即站点根，则填 `/` 对应你实际上传的目录）。
3. **环境**：连接 GitHub 后，每次 **push 到 `main`（或你绑定的分支）** 会自动部署；仅发布 GitHub Release **不会**触发 Pages，需改页面并 push。

## 发新版本时要改的地方

打开 **`index.html`**，搜索并统一替换（当前站点已标为 **v1.3.0**）：

| 位置 | 示例（与 `package.json` / `npm run dist:win` 产物一致） |
|------|------|
| `<meta name="app-version" …>` | `1.3.0` |
| 主下载按钮 `href` | `https://github.com/你的仓库/releases/download/v1.3.0/过了么AI.Setup.1.3.0.exe`（路径含中文时建议对「文件名」做 URL 编码，与页面里现用链接一致） |
| 按钮文案「v…」与页脚 `<strong>v…</strong>` | `v1.3.0` |

同时务必：

1. 在 **GitHub Releases** 新建 **`v1.3.0`**（或 `1.3.0`，与链接里的 tag 一致），并上传与链接**完全一致**的 **`过了么AI.Setup.1.3.0.exe`**（来自本仓库 `release/` 目录）。
2. **Cloudflare Pages**：把本次修改 **commit 并 push** 到绑定分支；或在控制台 **「重试部署」** 拉最新提交。若首页仍像旧版，到 Cloudflare **Caching → 对该 URL 执行 Purge**（或全站清理一次）。
## 静态资源

见 **`assets/README.md`**。将截图、视频、二维码放入 **`assets/`** 后再提交，否则页内图片/视频会 404。

## `_headers`

用于减轻 **HTML 被 CDN 长期缓存** 导致「页面还是旧版」的问题；部署后若仍看不到更新，可在 Cloudflare 控制台对该 URL **清除缓存** 一次。
