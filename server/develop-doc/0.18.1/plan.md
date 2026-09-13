# 0.18.1 检索页日期筛选行布局修复

## 需求

0.18.0 检索页第二行过滤区中，「创建」「更新」两组日期范围输入渲染为整行宽：四个日期框各占一行，
「创建」「更新」标签和「–」分隔符被挤在行间孤立显示，看起来像点不动的按钮（用户反馈）。

## 现状与原因

- `apps/web/src/routes/search.tsx` 第二行过滤区的日期 `Input` 直接挂了 `className="h-8 w-36 …"`。
- `Input` 基础类含 `w-full`，而 `cn`（`lib/cn.ts`）只做字符串拼接、不做 Tailwind 冲突合并，
  日期输入上的 `w-36` 不生效，`width:100%` 胜出。
- 结果四个日期框各占满一整行，行内标签与分隔符掉队。

## 方案

- 与第一行过滤区已有写法一致，用定宽容器控制宽度：日期 `Input` 外包 `<div className="w-36">`，
  `className` 去掉无效的 `w-36`；`h-8 text-xs` 与其余过滤控件保持一致写法。
- 「创建」「更新」各自连同类内日期框、分隔符包进 `flex items-center gap-2` 组，
  避免标签与对应日期框被 `flex-wrap` 分行拆散。

## 涉及文件

- `server/apps/web/src/routes/search.tsx`
- `server/package.json`（version 0.18.0 → 0.18.1）

## 任务清单

1. 按上述方案改 `search.tsx`
2. 升 `server/package.json` version
3. `npm test` + `npm run build`
4. Edge 有头实测：日期框约 144px、标签与日期框同行相邻

## 验收标准

- 日期输入不再整行；「创建」「更新」与各自日期范围同行相邻，换行不拆组
- `npm test`、`npm run build` 全绿；依赖不变
