# Changelog

本项目的所有重要变更都记录在这个文件里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
