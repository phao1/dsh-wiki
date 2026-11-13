# DeepSeek Harness 原生插件

仓库根包 `dsh-wiki` 是可安装的 Harness bundle。Cordis 加载它后，Harness 的工具注册表会提供四个 Wiki 工具。工具直接读取与工作台相同的知识库目录，即使工作台服务器未运行也能调用。

## 安装与验证

从仓库根目录运行以下命令。需要一个可用的 `dsh` 命令。npm 版 Harness 使用 Node.js 24.9 或更新版本。

```sh
dsh_wiki_harness_home="$(mktemp -d)"
export DSH_HOME="$dsh_wiki_harness_home"

dsh plugin --profile web add "$PWD"
dsh web --dump-config
dsh web --no-open
```

`--dump-config` 的输出应包含 `dsh-wiki` 层。用终端显示的地址打开 Harness。配置模型后，可以让它调用 `wiki_search` 查找 Cordis 插件配置，再调用 `wiki_read` 读取原文并引用来源。上面的命令在临时 Harness home 中创建 Web profile。要从该 profile 卸载，运行 `dsh plugin --profile web remove dsh-wiki`。

开发目录的链接由 `dsh plugin add` 保留。也可以在仓库根目录运行 `npm pack`，然后把生成的 `dsh-wiki-0.1.0.tgz` 绝对路径传给 `dsh plugin --profile web add`。使用独立打包安装时，请显式配置与工作台共享的数据目录。

## 共享知识库

默认数据目录是包根目录下的 `.local-data`，种子是 `data/seed.json`。工作台和插件可以通过相同的绝对路径环境变量 `DSH_WIKI_DATA_DIR` 使用同一份数据。每次工具调用都会打开当前状态，所以工作台同步或导入的内容会出现在下一次工具调用中。

也可以在目标 profile 的 `cordis.patch.yml` 中覆写插件配置。可选的 `seedPath` 指定首次读取时使用的种子。相对路径以安装包根目录为基准。已有持久化数据时优先读取该数据。

```yaml
- id: dsh-wiki
  config:
    dataDir: /absolute/path/to/dsh-wiki-data
    seedPath: /absolute/path/to/seed.json
```

## 工具

| 工具 | 参数 | 返回值 |
| --- | --- | --- |
| `wiki_search` | `query`、`category`、`tag`、`language`、`sourceId`、`limit` | 匹配文档、来源、片段与章节锚点 |
| `wiki_read` | 必填 `id`，可选 `sectionAnchor`、`offset`、`maxChars` | 文档或章节正文、来源、修订、哈希与分页信息 |
| `wiki_context` | `query`、`ids`、`budget` | 含引用的 Markdown、预计 token 数、截断信息 |
| `wiki_status` | 空对象 | 文档与章节数量、来源修订、分类与时效状态 |

工具返回结构化 JSON，Harness 将该结果渲染为文本。阅读长文档时，把 `nextOffset` 作为下一次 `wiki_read` 的 `offset`，并保留相同的文档 ID 和章节锚点。`nextOffset` 为 `null` 表示读到末尾。

## 运行时测试

有独立 Harness npm 安装时，将 `DSH_WIKI_DSH_MODULES` 指向其 `node_modules`。测试会用真实 Cordis 与工具执行管线检查注册、检索、引用、取消、数据刷新及卸载。测试使用临时数据，运行时无需模型或 API 密钥。

```sh
DSH_WIKI_DSH_MODULES=/absolute/path/to/node_modules npm run test:dsh
```

也可以直接测试已安装的 CLI。脚本会创建临时 `DSH_HOME`、安装本仓库、调用四个工具，再经标准输入输出完成 JSON-RPC `shutdown` 并验证进程正常退出。

```sh
npm run test:dsh:host

# 若 dsh 没有加入 PATH，可指定 Desktop 自带的命令。
DSH_WIKI_DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  npm run test:dsh:host
```

本机验证使用 DeepSeek Harness `0.2.1-rc.2` 和 Cordis `4.0.5`。`sdk-minimal` 宿主使用目录链接和打包归档安装 bundle，均成功调用四个工具，报告 38 篇官方种子文档，检索到 Cordis Primer 的固定修订地址，并正常关闭。Web profile 的组合与工具执行也通过。当前测试环境的回环端口监听返回 `EPERM`，浏览器端启动未验证。

针对 `0.2.2-rc.2`，核对了官方源码的注册、批量执行及 JSON 结果接口。上面的运行时结果对应本机已安装的版本。

- [Harness 插件安装文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [工具接口与执行管线](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md)
- [核对的工具注册表源码](https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/core/tools/src/index.ts)
