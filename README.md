# DSH Wiki

**面向 DeepSeek Harness 的可追溯文档知识库。** 把 Markdown 语料变成能检索、读原文、看变更、按预算交给 Agent 的本地工具。内置 38 篇 DSH 官方中英开发文档，也支持现有 claude-wiki 目录及任意 Markdown 资料。

## 立即运行

需要 Node.js 22 或更新版本。工作台没有运行时依赖，不需要模型 API Key，也不需要先运行 `npm install`。

```sh
cd dsh-wiki
npm start
```

打开 **http://127.0.0.1:4310**。首次启动从已附带的真实文档快照建立索引；导入或同步后原子保存到 `.local-data/state.json`，重启优先读取这份数据。`DSH_WIKI_DATA_DIR=/absolute/path` 可切换库，`PORT=4311` 可切换端口。

## 快速体验与验收

1. 搜索「插件配置」或「创建工具」，切换中文／英文，打开命中页，核对原始来源、commit、内容 SHA-256 和采集时间。
2. 选择两篇文档加入上下文篮，设置预算，生成并复制或下载 Context Pack。结果带来源、章节及哈希，明确 token 为估算值。
3. 在「来源」导入自己的 `.md` 文件。检索它，停止并重启服务，再次检索，确认已持久保存。
4. 修改同名 Markdown 再次导入，在「更新记录」查看实际新增／删除行及版本。来源时间未知的资料显示「时间未知」，不会因刚导入就冒充新鲜。每篇文档保留最近一次全文差异，更早变更保留摘要记录。
5. 「检查更新」读取配置的 GitHub 来源；成功时固定到一个 commit 后批量更新，任一下载失败都保留旧库并显示错误。离线时搜索、阅读、导入和导出仍可用。
6. 在隔离 DSH profile 安装原生 bundle，调用 `wiki_search`、`wiki_read`、`wiki_context`、`wiki_status`。完整说明见 [DSH 集成](docs/dsh-integration.md)。

独立验收结果与覆盖边界见 [验收记录](docs/acceptance.md)。

## 原生 Agent 工具

DSH Wiki 是一个真实 Cordis bundle；工作台与 Agent 共享同一知识库。工具只读，不会因 Agent 查询而联网或修改文档。插件通过当前官方 `ctx.tools.register()` 和 canonical output 契约注册，安装方法与已验证运行时版本见 [集成说明](docs/dsh-integration.md)。

| 工具 | 用途 |
|---|---|
| `wiki_search` | 中英检索，返回命中段落与出处 |
| `wiki_read` | 按稳定文档 ID 读取内容和来源证据 |
| `wiki_context` | 根据查询或文档选择生成有预算、有引用的上下文 |
| `wiki_status` | 查看覆盖范围、版本、新鲜度 |

## 命令行

```sh
node cli/wiki.mjs search "插件配置" --language en
node cli/wiki.mjs status --json
node cli/wiki.mjs import ./my-docs --source-id my-docs
node cli/wiki.mjs context "如何创建工具" --budget 4000 --out context.md
node cli/wiki.mjs export --format manifest --out manifest.json
node cli/wiki.mjs export --format crossrefs --out crossrefs.json
node cli/wiki.mjs export --format markdown --out ./wiki-snapshot
node cli/wiki.mjs sync
node cli/wiki.mjs doctor
```

`read <id>` 读取全文；`export` 还支持 `index`、`llms`。本地导入默认合并，明确传 `--replace` 才删除该来源中缺席的旧页。请停止工作台再用 CLI 对同一数据目录执行 import/sync；该版本的写入协调范围是单进程。浏览器中的所有写入已串行处理。

`--format markdown` 导出原项目风格的可 grep 目录：`documents/<source>/<path>.md`、YAML frontmatter、`INDEX.md`、`TAGS.md`、`tags.json`、`llms.txt`、`manifest.json`、`crossrefs.json` 和许可证说明。目标目录必须不存在，避免覆盖已有文件。Manifest 同时记录规范化来源哈希与导出文件的实际 SHA-256；正文保持不变，标准元数据重序列化。源码仓库不包含生成的快照目录；运行上述导出命令即可生成内置 38 篇官方文档的 Markdown 快照。

## 比参考项目增加了什么

| 参考 claude-wiki 的公开交付 | DSH Wiki 当前交付 |
|---|---|
| Markdown 镜像、索引、标签、回链、全文拼接 | 保留这些可移植产物，同时提供真正可运行的本地索引与工作台 |
| README 中的 grep / jq 检索 | 字段加权全文检索、章节命中、中英词表扩展、分类与语言过滤 |
| 下游自行接入 RAG / MCP | 直接注册 DSH 原生只读工具，无需模型 Key |
| 分类 `llms.txt` 全文 | 可选择文档、按估算预算输出引用完整的 Context Pack |
| 已生成的同步产物 | 公开可执行的固定 commit 同步代码、原子导入、失败保留、实际 diff |
| 每页来源时间元数据 | UI 明示来源、采集／验证时间、过期／未知状态与内容哈希 |

这不是覆盖规模领先的声明：首发选集为 **38 篇**，参考镜像固定版本含 **4,358 页**。本项目的目标是可执行、可核验、适合 DSH 使用的工作流；不把有限样例检索结果泛化成模型质量优势。详细研究见 [参考项目研究](docs/research.md)。

## 数据、来源和边界

- 内置 DSH 文档固定提交 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，实际获取时间保存在 seed 中，遵循 [DeepSeek MIT 许可](licenses/DEEPSEEK-MIT.txt)。原文未改写。
- 不附带 Anthropic 文档镜像。用户可导入已有 Markdown；导入保留 `source_url`、`fetched_at`、`tags` 等 frontmatter。导入不是再分发授权。
- 搜索采用确定性词法检索和双语词表，不调用向量模型或生成答案。Context Pack 是有出处的资料选段，文档内容明确作为不可信参考数据。
- Token 数使用估算，不是某一模型的 tokenizer。很小的预算可能放不下一条完整引用，此时返回说明，不伪造结果。
- 过期标准为 14 天；采集时间不代表内容正确，内容哈希不证明来源可信。未知时间不会被导入时间覆盖。
- 本地界面绑定回环地址；没有远程多人权限系统。远程部署、向量检索、定时同步任务与插件市场发布不在此版本交付范围。
- 同步依赖机器可访问 GitHub；本次开发环境的 shell DNS 无外网解析，在线失败路径已如实保留，附带语料经已连接的 GitHub 读取通道获取。

## 开发与结构

```sh
npm run check
npm test
npm run evaluate:search
npm run test:dsh
npm run test:dsh:host
npm pack
```

| 路径 | 职责 |
|---|---|
| `packages/core/` | Markdown 归一化、索引、检索、上下文、历史与持久化 |
| `packages/dsh-plugin/` | 原生 Cordis bundle 与真实运行时集成测试 |
| `server/` | 回环 HTTP API、GitHub 同步、标准导出 |
| `web/` | 无依赖知识工作台 |
| `cli/` | 批量导入与自动化 CLI |
| `data/` | 38 篇真实种子文档及显式来源清单 |
| `tests/` | 核心与独立端到端验证 |

本项目代码 MIT；内置上游文档保留各自许可证。没有复用 claude-wiki 的文档正文或其未公开同步实现。
