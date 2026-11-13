# 参考项目研究与产品决策

研究日期：2026-11-12 UTC。这里区分固定提交可验证事实、README 声明和本项目决策。

## 原项目是什么

[`johnzfitch/claude-wiki`](https://github.com/johnzfitch/claude-wiki) 是非官方 Anthropic 文档 Markdown 镜像，而不是带编辑器的通用 wiki Web 应用。研究固定到 `5f907d21e91f7aec485a75556c36c9539e31d13c`，其 [INDEX.md](https://github.com/johnzfitch/claude-wiki/blob/5f907d21e91f7aec485a75556c36c9539e31d13c/INDEX.md) 列出 4,358 页、22 个分类，API Reference 为 2,107 页。历史搜索缓存中的较低页数不代表这个版本。

公开产物包括：

- 每页 YAML frontmatter：`title`、`source_url`、`category`、`fetched_at`、`tags`，部分页面含 `last_modified`。
- 全局／分类 INDEX、TAGS 与适合模型读入的 `llms.txt`，API 大类继续按子目录分拆。
- JSON manifest（来源与别名、哈希）、tag index、crossrefs（出链与回链）和更新记录。
- README 使用方式是 clone 后 grep/jq；RAG 为下游集成建议。

README 声明定时任务每日检查，有变化才发布。公开根目录和 README 未提供可运行的采集、构建或搜索服务。最近所查同步提交日期为 11 月 10 日、10 月 24 日、10 月 11 日；这些只能证明确有产物发布，不能单独证明每天任务实际执行。

其 [LICENSE](https://github.com/johnzfitch/claude-wiki/blob/5f907d21e91f7aec485a75556c36c9539e31d13c/LICENSE) 是 Anthropic 保留权利与镜像参考／教育用途的说明，未授予我们重新打包整批正文的许可。本项目复现组织方法与工作流，不附送 Anthropic 语料。

## DSH 是什么，怎样接入

相邻项目已有研究把 DSH 指向 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)。又对官方 README、基础插件教程、工具 subsystem、发布指南、CLI 配置方式核实：DSH 使用 Cordis 插件组合，模块导出 `apply`、`inject`，工具通过 `ctx.tools.register` 注册，工具成功结果采用 canonical JSON value 加 output schema/render。

参考官方当前文档固定到 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`：

- [基础插件](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/user/develop/basic/index.md)
- [工具契约](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/subsystems/tools.md)
- [插件发布](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/docs/user/develop/basic/publish.md)
- [仓库 MIT 许可](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/LICENSE)

本机安装的 DSH Desktop 内置运行时与当前文档版本不完全相同。因此除源码对照外，交付必须在隔离 profile 运行真实工具管线；测试实测的支持范围写入集成与验收文档，不能把 API 形状相似称作已验证所有版本。

## 决策

1. **语料开放，首发聚焦。** 支持通用 Markdown／claude-wiki 目录结构，内置明确 MIT 授权的 DSH 中英文档选集。38 篇覆盖入门、插件开发、工具执行、架构、模型／MCP／网络配置，不冒充全站镜像。
2. **知识可核验。** 每个搜索命中、原文与 Context Pack 带 source URL、固定 commit 与内容 hash。更新、未验证和过期有不同含义。
3. **产品真正可运行。** 索引与持久化、检索与回链、GitHub 同步、局部 diff、标准导出都公开实现，CLI／UI／DSH 共用核心。
4. **把上下文缩到任务需要。** 章节检索与预算包解决直接全文拼接的体积问题。token 只是估算；不编造摘要或答案。
5. **无 Key 的确定性基础。** 第一版不靠远程大模型维持核心能力；中文查询通过词表扩展帮助命中英文 API 文档，能力以实际样例检验，未来再比较 embedding 是否值得加入。

## 未被本轮证明的事项

没有声称比 claude-wiki 覆盖更多文档、比向量检索普遍更准确、天然能抵御所有提示注入，或已获 Anthropic 内容再分发授权。没有将同步代码存在等同于已在无外网的本机完成生产 GitHub 在线更新。真正执行的检查与限制以验收记录为准。
