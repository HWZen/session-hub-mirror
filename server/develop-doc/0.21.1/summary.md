# 0.21.1 开发总结 — 混合检索结果徽标对齐

## 改动

- 将搜索结果标题栏改为弹性标题列与固定宽度徽标组布局。
- “语义 + 词法”与“距离”徽标保持相邻、靠右、不折行；标题使用剩余宽度。
- `server/package.json` 版本更新为 `0.21.1`。

## 验收

- `npm test`：31 个测试文件、253 个用例全部通过。
- `npm run build`：TypeScript、各子系统类型检查及 Web 生产构建通过。
- 检索数据与排序逻辑未作修改。

## dev 部署

- 部署到 `https://session-hub.example.test`，复用 0.21.x dev 实例。
- `/health` 返回 `version: 0.21.1`，数据库状态正常，日志模式为 `truncate`。
- 首页引用本次构建的 JS/CSS 资源，两个资源均返回 HTTP 200。
