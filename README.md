# 二分心智 · Bicameral Mind

一个 DeepSeek Harness 插件：让 agent 在执行任务时拥有**两个不同模型的声音**，互相纠偏。

> 二分心智（bicameral mind）的原意是：意识尚未统一时，一侧心智发出的指令被另一侧当作「神的声音」听见，从而形成自我校正。这里把它落到工程上——
> **左脑**（执行者）在做事，**右脑**（校正者）由另一个模型独立生成，只看得到左脑公开的主张与证据，因此能指出左脑自我确认时漏掉的东西。

---

## 两个声音

| | 左脑 Actor | 右脑 Examiner |
|---|---|---|
| 是谁 | 会话主模型本身 | 插件另起一次模型调用生成 |
| 模型 | 默认跟随会话路由，可单独钉死 | 默认跟随会话路由，**推荐钉死为另一个（更强的）模型** |
| 看到什么 | 全部上下文 | 只有左脑提供的主张 + 证据 + 未决问题 |
| 职责 | 推进任务、调用工具、下判断 | 找目标偏离、证据不足、未验证断言、不可逆风险、前后矛盾、完成度缺口 |

两个声音**各自独立路由**：`voices.actor` 与 `voices.examiner` 可分别指定 provider/model，右脑还支持候选链与自动降级。右脑的路由顺序是：显式钉死 → 候选链 → 会话路由 → 进程默认模型；**上次实际成功的路由会被记住并在下一次优先尝试**（粘性路由），避免每次都先撞坏路由再降级。

## 右脑的三次发声

1. **工具 `bicameral`（左脑主动求审）**
   左脑在计划成形前（`plan`）、有后果的动作前后（`act`）、阶段性结论前（`checkpoint`）、宣布完成前（`finish`）调用它。
   `depth=quick` 单轮质疑；`depth=full` 走「右脑质疑 → 左脑逐条答辩（可反驳）→ 右脑终裁」，这是真正的双向纠偏，而不是自我批评。

2. **自动插话（右脑主动打断）**
   每次有后果的工具调用（默认 `write` / `edit` / `pwsh` / `bash` / `run_code` / 删除 / 移动）完成后，右脑会独立复核这次动作，若发现偏差，就把一条 `〔右脑·校正〕…` 作为独立 user 消息，在**下一个 step 边界**送进模型。左脑下一步必须回应：认同就按最小修正动作改，不认同就用一句话给出依据（答辩）。
   复审在 `agent/pre-step` 执行，**不在工具提交路径上**：慢复审不会阻塞任何工具结果，用户中途取消也不会把已成功的工具结果变成 aborted。有冷却时间、每轮次数上限、并发保护、硬超时（adapter 不响应取消也不会挂死），以及失败结果开关。

3. **收尾闸门（未决问题必须收敛）**
   右脑提出的问题会按内容合并进「未决问题」集合，**不会**因为一次无关的 pass 被清空；只有刻意的重新审议（显式调用、checkpoint、finish）判 pass 才会收敛。
   如果还有未决问题而左脑准备结束本轮，闸门会再问一次右脑：最终回答是否**实际**解决了这些问题。若没有，它用 `steer` 让本轮继续，把未决问题顶回给左脑。每轮最多触发一次。

## 隐私与数据流

生产使用时必须知道：**右脑是另一次模型调用，它收到的内容会离开当前会话的模型供应商。**

- 自动插话会把「用户任务原文 + 工具名与参数 + 工具结果摘要（默认各截断 800/1200 字符）」发给右脑模型。
- 如果你在设置页把右脑钉死、或添加候选指向另一个 provider，这些内容会发到那个 provider。**随包默认右脑跟随会话路由（同一 provider），不会跨信任边界**；开启自动复审前请确认这一默认是否符合你的要求。
- 想避免跨边界：保持右脑默认（跟随会话），或用 `/bicameral voice examiner reset`，或用 `/bicameral auto off` 关掉自动插话、只保留显式 `bicameral` 调用。
- 诊断路由按 `sessionId` 返回本机活动会话的插件内快照（任务锚点、未决问题、审议记录），要求 `webServer` + `connection` 同时存在并通过 Host 浏览器信任栅栏（跨站 / Origin 不符 / 未认证一律拒绝）。

## 安装

本插件无构建步骤、无运行时依赖，安装后即可用。**推荐从 git 仓库克隆后按包目录安装**（Harness/插件管理器当前没有内置的「从 GitHub 安装」按钮）：

```text
git clone https://github.com/ssodeeth/dsh-bicameral-mind.git
plugin_manager action=install_bundle target="<克隆目录的绝对路径>"
```

> 也可以直接用本地开发目录安装：
>
> ```text
> plugin_manager action=install_bundle target="<本插件目录的绝对路径>"
> ```

安装后：profile 的 `dsh.profile.bundles` 会加入本包，包内 `cordis.patch.yml` 提供一行 `bicameral-mind`。**不要手改 profile 的 `cordis.patch.yml`**——安装器会处理；要改配置请用设置页或 `/bicameral` 命令（写入插件自己的 `settings.json`）。

## 配置

组合行配置（`cordis.patch.yml` 中该行的 `config`）负责部署默认值。**以下就是随包默认值**：

```yaml
- id: bicameral-mind
  name: 'dsh-bicameral-mind'
  config:
    enabled: true
    language: auto            # zh | en | auto（声音输出语言）
    maxIssues: 3
    voices:
      actor:
        fallbackToAgentRoute: true
      examiner:
        # 默认跟随会话路由：右脑与左脑同一 provider，不跨信任边界。
        # 想用另一个模型做右脑：在设置页选择，或 /bicameral voice examiner <provider> <model>
        fallbackToAgentRoute: true
        maxTokensQuick: 1600
        maxTokensFull: 2200
    autoReview:
      enabled: true
      tools: [write, edit, pwsh, bash, run_code, delete_file, move_file]
      cooldownMs: 15000
      maxPerTurn: 6
      timeoutMs: 20000
      maxTokens: 700
      includeErrors: true
      finishGate: true
      subagents: false          # 默认不审子智能体的工具调用
      logPasses: false
      shellReadGuard: true      # 只读 shell 命令不复审
    tool:
      defaultDepth: quick       # quick | full
      fullStages: [plan, finish]
      timeoutMs: 30000
```

用户运行期改动（`/bicameral` 命令）写入插件自己的设置文件，不改 profile patch：

```text
$DSH_HOME/storages/bicameral-mind/settings.json
```

## 命令

```text
/bicameral status                              查看状态、两个模型路由、未决问题
/bicameral last                                查看最近一次双声审议记录
/bicameral level [off|advisory|balanced|strict|paranoid]  查看或切换介入程度
/bicameral budget [relaxed|standard|frugal]    查看或切换成本护栏
/bicameral on | off                            启用/停用二分心智
/bicameral auto on | off                       启用/停用自动插话
/bicameral voice actor <provider> <model>      为左脑钉死模型（默认跟随会话）
/bicameral voice examiner <provider> <model>   为右脑钉死模型（推荐与左脑不同）
/bicameral voice <actor|examiner> reset        取消钉死
/bicameral candidates <actor|examiner> <provider>/<model> [...]
/bicameral probe                               探测两个声音每条路由的连通性
```

## 介入程度

设置页顶部和 `/bicameral level` 共用一个档位选择；切换档位会一次性写入对应参数（自动插话范围、冷却、每轮预算、收尾模式、审议深度），之后手调任一参数会显示为「自定义」。

| 档位 | 行为 |
|---|---|
| 关闭 `off` | 完全停用：协议与工具均不可用、不自动复审 |
| 提示 `advisory` | 只在左脑显式调用 `bicameral` 时介入 |
| 标准 `balanced` | 有后果的写入 / 执行后主动复核；收尾闸门只在有未决问题时介入（默认） |
| 严格 `strict` | 所有工具动作都复核（明显只读的 shell 命令除外）；每轮收尾必审；计划 / 阶段 / 收尾用完整辩论 |
| 偏执 `paranoid` | 连只读命令也复核；每次审议默认完整辩论；冷却 0、预算最高，成本与延迟最高 |

```text
/bicameral level                 查看当前档位与全部可选值
/bicameral level strict          切换到「严格」
```

> 严格 / 偏执会显著增加模型调用次数与等待时间；建议先用「标准」，需要更强约束时再逐级提高。

## 成本护栏

设置页的「成本护栏」卡片和 `/bicameral budget` 控制**每轮**最多花多少：调用次数（一次完整辩论记 3 次）、完整辩论次数、token 估算（按每次 `maxTokens` 保守累加）。到上限后，本轮不再自动插话，显式 `bicameral` 调用会返回预算提示；下一轮自动重置。

| 预设 | 每轮调用 | 完整辩论 | token 估算 |
|---|---|---|---|
| 宽松 `relaxed` | 30 | 8 | 60k |
| 标准 `standard`（默认） | 12 | 3 | 24k |
| 节约 `frugal` | 6 | 1 | 12k |

也可以关闭护栏（不限制），或直接改三个数字，此时显示为「自定义」。

```text
/bicameral budget                查看护栏、本轮已用量与全部预设
/bicameral budget frugal         切换到「节约」
```

## 设置页（推荐方式）

Web UI → 设置 → 「二分心智」，可以图形化配置：

- 总开关；**介入程度档位**（关闭 / 提示 / 标准 / 严格 / 偏执）；左脑 / 右脑的 provider + model 下拉（模型目录来自 `ctx.llm.listProviders/listModels`，失败时可手填）
- **成本护栏**：宽松 / 标准 / 节约预设 + 自定义每轮调用、完整辩论、token 估算上限，可单独关闭
- 右脑候选降级链的增删：每行同样是 **provider / model 下拉**（与主选择器同一个模型目录）；换 provider 自动带出该 provider 的第一个 model；目录里没有的旧值会显示为「当前值（不在目录）」并原样保留；模型目录不可用时回退为手填
- 「探测此路由」按钮（直接显示 `✔ 1.2s` / `✘ 错误`）
- 自动插话的开关、监视工具、冷却、每轮上限、超时、maxTokens、收尾闸门等
- 完整审议阶段（fullStages）与默认深度
- 保存后立即生效，写入 `$DSH_HOME/storages/bicameral-mind/settings.json`，与 `/bicameral` 命令是同一份配置

## 如何确认「真的是两个模型」

```text
/bicameral status     # 左脑、右脑两行显示不同路由
```

也可以在设置页的「实际生效路由」一行直接看到。会话顶部「对话 / 轨迹」视图栏新增了 **「内心对话」** 页：显示左脑/右脑模型 chip、未决问题数与最近审议记录（含「左脑主张 / 右脑质疑 / 左脑答辩 / 终裁」四段完整对话），并可一键开关。

## 文件结构

```text
index.js           插件入口：注册工具、协议段落、事件监听、命令与 Web 路由
src/runtime.js     双声运行时：审议编排、自动插话、收尾闸门、会话状态
src/examiner.js    右脑/左脑的提示词、裁决 JSON 解析、模型侧格式化
src/voice.js       两个声音的模型调用：路由解析、候选链降级、超时/取消
src/state.js       每会话有界状态：任务锚点、最近动作、未决问题、审议记录
src/config.js      配置归并与插件自有 settings.json
src/levels.js      介入程度档位：预设参数、当前档位识别
src/budget.js      成本护栏：预设、当前档位识别
src/prompt.js      双声协议（system prompt section）
src/tool.js        bicameral 工具定义（schema/输出/渲染）
src/command.js     /bicameral 命令面
src/webui.js       Web 路由：状态/开关/配置读写/模型目录/单路由探测
client.js          Web UI：「内心对话」视图（对话/轨迹栏）+ 设置页「二分心智」
test/              66 项单测（提示词/解析/格式化 + mock ctx 接线 + 设置路由 + 档位 + 成本护栏 + 术语一致性）
```

## 设计约束（为什么这样写）

- **不写私有 session 事件**：模型可见的一切要么是工具结果，要么是带身份的 user 消息（`additionalContexts` / `steer`），回放、fork、resume 都一致。
- **两个声音 = 两次独立模型调用**：右脑不共享左脑的推理上下文，这是它能纠偏的前提；`full` 深度里左脑答辩走左脑自己的路由。
- **有界**：所有证据、转录、提示词都截断；自动插话有冷却、次数上限、并发保护；状态按会话 LRU 有界；每次模型调用都有「软取消 + 硬截止」双保险。
- **任务锚点是稳定的**：会话第一条人类消息固定为锚点，后续用户消息作为「最新消息」附在锚点后一起给右脑，避免一句「继续」把原始目标覆盖掉。
- **可关闭、可观察**：`enabled` / `autoReview.enabled` 都可运行期切换；`/bicameral last` 与 Web 的「内心对话」视图给出完整对话。

## 已知限制

- 右脑的质量取决于证据：`claim`/`evidence` 写得越空，纠偏越弱（插件会在提示词里要求左脑如实提供）。
- 自动插话会增加模型调用成本与每步延迟（仅在触发复审的 step 上，正常约 2–10 秒；候选路由不可用时会先降级，最坏接近 `autoReview.timeoutMs`）；可以用 `autoReview.cooldownMs`、`maxPerTurn`、`maxTokens` 或 `/bicameral auto off` 控制。
- 收尾闸门每轮最多触发一次；如果右脑持续认为未完成，会把问题顶回给左脑而不是无限循环。
- PTC 模式（`run_code` 程序内部）的子调用目前不进入自动复审（`exec.parent !== undefined` 被跳过），只覆盖顶层工具调用。
- 会话级状态（未决问题、每轮计数、任务锚点）在内存中，进程重启/会话 resume 后不保留；`/bicameral status` 与「内心对话」视图只反映当前进程内观察到的内容。
- 协议段与 `bicameral` 工具对子智能体也可见；`autoReview.subagents: false` 只关闭子智能体的自动复审与收尾闸门，子智能体仍可主动调用工具（会消耗 token）。
- 「内心对话」视图的数据来自 Host 内存快照，最多保留最近 30 个会话、每会话 12 条记录。

## 验证

```powershell
cd <本插件目录>
node --test test/examiner.test.mjs test/plugin.mock.test.mjs
```

覆盖（66 项）：提示词分区与语言/stage 差异、裁决 JSON 的健壮解析（围栏/废话/散文/非法字段/截断）、长度上限、fail-safe（截断的 pass 不被信任）、工具注册、双路由（左/右脑不同模型、右脑失败降级与粘性路由、候选链）、自动插话在 step 边界注入与 pass 静默、每轮预算、收尾闸门只触发一次、未决问题合并语义、任务锚点不被后续消息覆盖、adapter 忽略取消时的硬截止、诊断路由与设置路由的鉴权/400/403、命令面与设置持久化、**介入程度五档位的参数映射与识别、通配工具复审、偏执档连只读命令也复审、严格档每轮收尾必审、成本护栏预设与自定义、调用/完整辩论/token 三重拦截与跨轮重置**、**术语一致性（左脑/右脑，旧称已清除）**。

仓库 push 后，CI（GitHub Actions）会在 Node 20/22 上跑同样的语法检查与测试。

## 兼容性

| DSH | 状态 |
|---|---|
| 0.2.1-rc.2（桌面版当前） | 已实测 |
| 0.2.0-rc.2 | 未实测（扩展点同族，理论兼容） |

依赖的正式扩展点：`tools`（注册工具）、`systemPrompt.section`（协议段）、`llm.stream`（两路模型调用）、`agent/pre-step`（任务捕获与自动插话）、`agent/turn-stopping`（收尾闸门）、`agent.steer`、`tools/result`、`agent/disposed`、`webServer` + `connection`（诊断/设置路由）、`commands`（`/bicameral`），以及 Client 的 `slots` API。无构建步骤、无运行时 npm 依赖。

## 许可证

[MIT](LICENSE) © 2026 ssodeeth

## 仓库与维护

> 仓库需要先创建并 push；在此之前下面的链接会 404。

- 仓库：<https://github.com/ssodeeth/dsh-bicameral-mind>
- 问题反馈：<https://github.com/ssodeeth/dsh-bicameral-mind/issues>
- 变更记录：[CHANGELOG.md](CHANGELOG.md)

发布前检查（维护者）：

```powershell
npm run verify          # 语法检查 + 66 项单测
npm pack --dry-run      # 核对打包内容
```

版本号遵循语义化版本；每次发布更新 `CHANGELOG.md` 并打 tag。
