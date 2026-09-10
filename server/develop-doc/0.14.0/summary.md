# 0.14.0 品牌图标（Web / README）：实际改动记录

需求：为 Session Hub 设计一枚图标，用于 README 展示与服务端 Web 的站点图标（favicon）及侧栏 Logo。

## 实际改动

- `assets/icon.svg`（新增）：图标源文件，512×512。渐变圆角方块（`#6366f1 → #7c3aed → #3b82f6`）+ 左上高光；前景为白色放大镜，镜内为 hub 节点网络（中心节点 + 三卫星节点，用线相连），表达"会话 + 检索 + 多源聚合"
- `server/apps/web/public/icon.svg`（新增）：Web 静态资源副本；Vite 构建时拷贝到 `dist/` 根，服务端 `staticRoutes` 已支持 `.svg` MIME
- `server/apps/web/index.html`：新增 `<link rel="icon" type="image/svg+xml" href="/icon.svg">` 与 `<meta name="theme-color" content="#7c3aed">`
- `server/apps/web/src/components/app-shell.tsx`：侧栏顶部 Logo 由 lucide `BoxesIcon` 主色方块改为 `<img src="/icon.svg" className="size-7 rounded-lg">`；`BoxesIcon` 仍用于"会话"导航项，import 保留
- `README.md`：标题上方居中展示 `assets/icon.svg`（120×120）
- `server/package.json`：`0.13.0 → 0.14.0`

## 与计划的偏差

- 本版未单独写 `plan.md`，也未走 worktree 工作流（经用户指示直接在 master 实施，事后补记本 summary）
- 图标源文件放仓库根 `assets/`（跨 README 使用的全局资产），并镜像一份到 web `public/`；两处内容一致，后续改动需同步

## 测试 / 验收结果

- `npm test`：24 文件 190 用例全绿（本版为纯静态资源/展示层改动，无新增用例）
- `npm run build`：`tsc -b` + 三插件 typecheck + web 构建（tsr generate / tsc / vite）全绿
- 本地 `npm run dev`（127.0.0.1:7428）实测：
  - `GET /` 页面渲染，侧栏 Logo 与图标一致，左下角版本显示 `Session Hub v0.14.0`
  - `GET /icon.svg` → `200 image/svg+xml`（1240 B）
  - `GET /health` → `version=0.14.0, ok=true`
- 图标在 16/32/64/128/256 px 下肉眼核对（深浅背景），小尺寸仍可辨认为放大镜

## 遗留事项

- 未提供 PNG/ICO 位图兜底；如需兼容不支持 SVG favicon 的旧环境，后续可补 `favicon.ico`
- `assets/icon.svg` 与 `server/apps/web/public/icon.svg` 为手工同步的双副本，若纳入常规构建可考虑单一源 + 拷贝脚本
