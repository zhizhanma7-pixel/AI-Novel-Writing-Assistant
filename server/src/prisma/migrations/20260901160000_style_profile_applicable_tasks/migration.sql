-- Skill 包的任务匹配维度：写法资产新增 applicableTasksJson。
--
-- 取值域复用既有的模型路由任务类型（shared/types/novel.ts 的
-- MODEL_ROUTE_TASK_TYPES），不自造一套字符串。列存 JSON 数组，与同表的
-- tagsJson / applicableGenresJson 保持一致的存法。
--
-- 可空：既有写法资产没有这一维，留空表示"不参与按任务自动命中"，
-- 仍可像以前一样人工绑定。
ALTER TABLE "StyleProfile" ADD COLUMN IF NOT EXISTS "applicableTasksJson" TEXT;
