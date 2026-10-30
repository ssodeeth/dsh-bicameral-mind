# Changelog

本项目的所有重要变更都记录在这个文件里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.4] - 2026-10-30

### 修复

- **右脑旧问题滞留**：此前未决问题一旦产生，只有显式 / checkpoint / finish 的 pass 才会清除，自动复审会反复看到第一步的旧问题。
  - 每条未决问题记录提出时的轮次与 step，提示词中显示时效。
  - 裁决 JSON 新增 `resolved`：右脑可以点名已被后续证据证明修复的旧问题，插件只核销这些条目，不误清无关问题。
  - 自动复审明确要求「只审当前动作；旧问题已解决写 resolved，不要重提」；证据从最近 2 个动作扩大到 3 个，并附带当前轮次 / step。

### 验证

- 68 项 `node --test` 通过（新增 `resolved` 解析、旧问题核销、无关 pass 不清空未决问题、时效标注）。

## [1.1.3] - 2026-10-28

### 新增

- **介入程度档位**：设置页与 `/bicameral level` 新增统一的五档预设——`off`（关闭）、`advisory`（提示）、`balanced`（标准，默认）、`strict`（严格）、`paranoid`（偏执）。
  - 每个档位一次性确定自动复审范围、冷却、每轮预算、收尾模式与审议深度；手调任一参数后显示为「自定义」。
  - `strict` 复审所有工具动作（明显只读的 shell 命令除外）、每轮收尾必审；`paranoid` 连只读命令也复审、默认完整辩论、冷却 0。
  - `autoReview.tools` 支持 `*` 通配；新增 `autoReview.finishAlways`（无未决问题也审收尾）。
- **成本护栏**：每轮硬上限，防止严格 / 偏执档在长任务里失控消耗。
  - 三项限制：调用次数（完整辩论记 3 次）、完整辩论次数、token 估算（按每次 maxTokens 保守累加）；到上限后本轮不再自动插话，显式 `bicameral` 调用返回预算提示，下一轮自动重置。
  - 预设：`relaxed`（30 / 8 / 60k）、`standard`（12 / 3 / 24k，默认）、`frugal`（6 / 1 / 12k）；也可自定义三项数字或关闭限制。
  - 设置页新增「介入程度」「成本护栏」卡片；新增 `POST /bicameral-mind/{level,budget}`、`/bicameral level|budget` 命令；`/bicameral status` 与 `/bicameral budget` 显示本轮已用量。
- 设置页「监视工具」提示补充 `*` = 全部工具；英文档位标题/描述改为客户端本地化。

### 修复

- `tool.*`（默认深度 / 完整审议阶段）此前只读取静态 patch、未叠加用户 settings.json。
- 预算拒绝时 `reviewing` 标志未复位，导致后续审议被误判为「已有审议进行中」。

### 验证

- 66 项 `node --test` 通过（档位映射、通配复审、偏执只读复审、严格收尾必审、预算预设/识别、调用上限、完整辩论上限、跨轮重置、路由与命令测试）。
- `npm run check` 通过（12 个源码文件 + 入口 + client）。

## [1.0.0] - 2026-10-27

### 新增

- **双脑架构**：左脑（执行者，会话模型）与右脑（校正者，独立模型调用）。两路模型可分别配置 provider/model，右脑支持候选降级链与「粘性路由」（记住上次成功的路由优先复用）。
- **`bicameral` 工具**：`plan / act / checkpoint / finish` 四个审议时刻；`quick` 单轮质疑；`full` 走「右脑质疑 → 左脑逐条答辩 → 右脑终裁」，答辩走左脑自己的模型路由。
- **自动插话**：有后果的工具调用（write/edit/pwsh/bash/run_code/删除/移动）完成后，右脑在下一个 `agent/pre-step` 边界注入 `〔右脑·校正〕` 用户消息；不在工具提交路径上，取消不会污染工具结果。
- **收尾闸门**：未决问题未收敛时，在 `agent/turn-stopping` 用 `steer` 让本轮继续，要求实际解决而不是口头承认。
- **未决问题合并**：按内容合并，不会被一次无关的 pass 清空；只有刻意的重新审议（显式调用、checkpoint、finish）判 pass 才收敛。
- **只读命令守卫**：`pwsh`/`bash`/`run_code` 中明显只读的命令不再触发复审（避免把 `Get-Content` 误判成写入）。
- **容错**：模型调用「软取消 + 硬截止」双保险；裁决 JSON 截断时按保守处理（绝不产生假通过）；路由候选自动降级。
- **Web UI**：
  - 「对话 / 轨迹」栏新增 **「内心对话」** 视图（`conversation.view`）：左右脑模型 chip、未决问题数、最近审议记录与四段完整对话。
  - **设置页「二分心智」**（`settings.section`）：总开关、左/右脑 provider/model 下拉、候选降级链增删与逐条探测、自动插话参数、完整审议阶段；保存到 `$DSH_HOME/storages/bicameral-mind/settings.json`，与 `/bicameral` 命令共用同一份配置。
- **命令**：`/bicameral status | last | on | off | auto on|off | voice <role> <provider> <model> | voice <role> reset | candidates <role> ... | probe`。
- **诊断路由**：`/bicameral-mind/{state,toggle,config,models,probe}`，全部经过 Host 浏览器信任栅栏（同源/Origin/Host/认证校验），配置写入原子化。
- **测试**：55 项 `node --test`（提示词/解析/格式化、mock ctx 接线、双路由、自动插话、收尾闸门、设置路由、术语一致性扫描）。
