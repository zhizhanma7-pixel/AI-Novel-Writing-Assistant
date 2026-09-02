-- 按环节绑定写法：StyleBindingTargetType 新增 'agent'。
--
-- SQLite 的 `prisma db push` 会自动跟上枚举变化，所以只跑 SQLite 的测试
-- 全绿并不代表 PostgreSQL 也认识这个值；已部署的库执行 migrate deploy 时
-- 仍会以 'novel' | 'chapter' | 'task' 为准，第一次创建 agent 绑定就会被
-- 数据库拒绝。这份迁移补的正是那个缺口。
--
-- `ADD VALUE` 是幂等安全的写法：IF NOT EXISTS 让重复执行不报错。
ALTER TYPE "StyleBindingTargetType" ADD VALUE IF NOT EXISTS 'agent';
