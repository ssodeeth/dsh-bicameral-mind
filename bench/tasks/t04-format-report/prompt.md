# 任务：按严格格式生成状态报告

工作区有 `notes.md`（原始要点）。请生成 `report.md`，格式必须完全符合：

1. 第一行标题：`# Status Report`
2. 依次包含三个二级标题：`## Summary`、`## Findings`、`## Next steps`，不要多也不要少；
3. `## Summary` 下写 1–2 句话，必须提到 `latency`；
4. `## Findings` 下至少 3 个 `- ` 开头的要点，必须提到 `retry` 和 `alert`；
5. `## Next steps` 下至少 2 个 `- ` 开头的要点，必须提到 `p99` 和 `runbook`；
6. 全文（含标题）总词数在 120–220 之间；
7. 不要输出其他一级标题。

完成后运行 `node verify.mjs .` 自检（如果工作区里有这个脚本）。
