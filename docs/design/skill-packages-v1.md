# 写法包（Skill Packages）v1

面向：想把别人的优秀文笔炼化进自己库里的作者，以及要改这块代码的人。

相关：[style-engine-v1.md](./style-engine-v1.md)、
[style-engine-boundary-prd-v2.md](./style-engine-boundary-prd-v2.md)、
实施记录见 `docs/dev/ARCH_ANALYSIS_SKILLS.md` 与 `docs/dev/IMPLEMENTATION_PLAN_SKILLS.md`。

## 它是什么，不是什么

**写法包不是新的资产类型。** 它是既有写法资产（`StyleProfile`）的**可携带封装**。
作者炼化出来的写法本来锁死在自己库里，这层格式让它能拷给别人、也能装回来。

装进来之后它就是一条普通的写法资产：照常编辑、照常绑定、照常参与去 AI 味。
没有第二套生命周期，也没有第二个列表。

## 包的形态

```
skill-name/
├─ SKILL.md          # 必需
├─ references/*.md   # 可选，随包携带，不进提示词
├─ templates/*.md
└─ examples/*.md
```

`SKILL.md` 是 frontmatter + 正文：

```markdown
---
name: 慢热恋爱节奏
description: 靠距离变化推进，不靠事件推进
category: 恋爱
tags: 慢热, 情绪递进
applicableGenres: 都市
applicableTasks: writer
---

## 叙事规则
推进靠距离变化，不靠事件密度。

## 人物规则
误读要有依据。

## 语言规则
少解释，多让动作说话。

## 节奏规则
章末停在动作未完成处。
```

四个小节映射到写法资产的四维规则。**没有这四个小节也能导入**——全文会作为写作
说明保留，并在自动命中时按长度上限截断后带入。

## 三条硬规矩

1. **只读。** 解析层不 eval、不 require 包内文件、不发网络请求。包里出现脚本
   （`.sh` / `.py` / 可执行文件等）一律忽略，并在预览里明说不会执行。
2. **认不出不等于可以丢。** frontmatter 里本项目不解读的键，**连值一起**留存，
   导出时原样带回。这是 Phase 3 世界书导入的教训：只留字段名会让值不可逆地消失。
3. **不静默失效。** 声明了合法但当前没有对应环节的适用范围（如 `repair`、
   `replan`），导入预览会直接说明它不会自动命中，而不是让作者以为配好了。

## 自动命中

写法可以声明 `applicableTasks`，在对应环节被自动带入提示词，不必每次手动绑定。

- **接线位置**：`StyleBindingService.resolveForGeneration` ——正文
  （`GenerationContextAssembler`）、章节执行契约、规划都直接调它，提示词工坊预览
  也走同一个入口。**不要**挂到 `StyleRuntimeResolver`：那一层只有改写/检测链会走，
  挂错会造成最坏的一种假象——预览里看得见，真实正文里没有。
- **目前真的会触发的只有三个环节**：writer / planner / reviewer，映射到任务类型
  `writer` / `planner` / `review`（见 `SKILL_EFFECTIVE_TASK_TYPES`）。格式层仍收下
  完整取值域，多出来的会在预览里被点名。
- **人工绑定优先**：已绑定的资产不会再被自动命中，否则会注入两遍、挤占预算，
  预览里还会出现两条一样的。
- **上限 3 条**，避免自动命中把上下文顶满。
- **提示词里分得开**：自动命中渲染成独立的 `matched_skills` 块并标注
  `auto-selected`，优先级 73，低于人工绑定编译出的 `style_contract`（74）——
  预算不够时先丢自动命中的那一块，作者自己绑的东西不会被挤掉。
- **消毒**：自动命中的规则文本同样过禁用实体提取与遮蔽
  （`sanitizeMatchedSkillsForGeneration`）。写法包按定义就是别人的原作，
  "推进靠《寒江雪》里那种距离变化"这类句子里的作品名人名正是这套机制要挡的。

## 导入默认不自动生效

导入时写 `status = archived`，即**不参与自动命中、不参与推荐**；资产本身在库里，
手动绑定随时可用。作者在写法列表点「恢复自动命中」才开始生效。

理由是产品口径，不是技术限制：别人的一套写法，作者还没看过一眼，不该在下一次
生成时就开始左右自己的文字。酒馆玩家体验的是黑箱探索的乐趣，写作要把东西摆到
台面上让作者取舍。

## 导出

任何来源的写法都能导出，不限于导入过的。**导出的永远是当前的资产**——改过名称
或规则后导出的是改后的值；导入包里的附件与未识别字段照旧带走。

导出得到 `<写法名>.zip`，解开就是 `<写法名>/SKILL.md (+ references/ …)` 的同构目录，
可直接交给按目录消费 Skill 的工具。

**没有引第三方库。** ZIP 用 stored 模式自行拼装（`skillPackageZip.ts`）：写法包是
文字、体积以 KB 计，压缩省不下什么，不值得为此装一个库。导入侧接受目录、单个
`SKILL.md`、以及 `.zip`；别人用压缩模式打的包交给浏览器自带的 `DecompressionStream`，
环境不支持时如实报错、不假装读成功。

## 已知缺口

- **作者无法给自己的写法声明适用环节**：`applicableTasks` 只有创建路径会写，
  更新路径和路由 schema 都没有它。结果是只有导入的写法才可能自动命中。
  要让自己炼的写法参与自动命中，眼下得先导出、手改 `SKILL.md`、再导入。
  补齐需要一个环节多选的编辑界面。

## 代码位置

| 关注点 | 文件 |
| --- | --- |
| 格式契约、告警码、生效环节 | `shared/types/skillPackage.ts` |
| 解析 / 序列化（纯函数） | `server/src/services/skillPackage/skillPackageParser.ts` |
| 导入 / 导出 | `server/src/services/skillPackage/SkillPackageService.ts` |
| 自动命中 | `server/src/services/skillPackage/SkillMatcherService.ts` |
| 接线位置 | `server/src/services/styleEngine/StyleBindingService.ts` |
| 消毒 | `server/src/services/styleEngine/styleGenerationSanitizer.ts` |
| 提示词块 | `server/src/prompting/prompts/novel/context/chapterContextBlocks.ts` |
| 界面 | `client/src/pages/writingFormula/components/SkillPackageImportDialog.tsx` |
| 浏览器侧读写（纯函数） | `client/src/pages/writingFormula/skillPackageFiles.ts` |
| ZIP 读写（纯函数、无依赖） | `client/src/pages/writingFormula/skillPackageZip.ts` |
