# 甘老师智能排课系统

面向教师长期运营的智能排课系统。学生通过公开链接提交时间和上课需求；教师通过 Supabase Auth 与 allowlist 进入工作台，审核学生、管理地点、通勤与班级，并生成和应用云端排课方案。

正式入口：

- 学生端：https://ganlu6633-source.github.io/gan-schedule/#/student
- 教师端：https://ganlu6633-source.github.io/gan-schedule/#/teacher

## 技术栈

- React + TypeScript + Vite
- Supabase Database、Auth、RLS
- Vitest 单元测试
- Playwright Chromium / WebKit 端到端冒烟测试
- GitHub Actions + GitHub Pages

## 本地运行

1. 复制 .env.example 为 .env.local，填写 Supabase URL 与 Publishable Key。
2. 执行 npm ci。
3. 执行 npm run dev。

生产构建与测试依次执行：npm run typecheck、npm test、npm run build、npx playwright install chromium webkit、npm run e2e。

## Supabase 与数据安全

正式数据统一写入现有 sched_* 表。浏览器端只使用 VITE_SUPABASE_URL 与 VITE_SUPABASE_PUBLISHABLE_KEY，不使用也不提交 service role、数据库密码或 GitHub Token。

匿名学生只能读取生效公开表单与启用地点，并只能新增自己的 intake。教师全部读写依赖 Supabase Auth、sched_teacher_allowlist 和 RLS。数据库迁移保存在 supabase/migrations；其中公开地点策略仅暴露 active = true 的地点。学生无法读取学生库、课程、班级、通勤或教师信息。

## GitHub Pages 部署

Vite 的 Pages base 固定为 /gan-schedule/。Actions 读取仓库 Variables VITE_SUPABASE_URL 和 VITE_SUPABASE_PUBLISHABLE_KEY。

Supabase Auth 的 Site URL 与 Additional Redirect URLs 必须包含以下地址：

    https://ganlu6633-source.github.io/gan-schedule/
    https://ganlu6633-source.github.io/gan-schedule/#/teacher

## 维护原则

- 不把 LocalStorage 当作正式数据库；仅保留学生未提交草稿与界面临时状态。
- 地点停用、课程取消、班级结束均保留历史，避免误删正式数据。
- E2E 测试数据必须以 E2E_TEST_ 标记，并在验收后只按标记清理。
