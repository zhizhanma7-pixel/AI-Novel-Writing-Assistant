-- 见 migrations/20260901160000_style_profile_applicable_tasks/migration.sql。
-- SQLite 没有 ADD COLUMN IF NOT EXISTS，dev 走 db push，这份只为 migrate 链路留痕。
ALTER TABLE "StyleProfile" ADD COLUMN "applicableTasksJson" TEXT;
