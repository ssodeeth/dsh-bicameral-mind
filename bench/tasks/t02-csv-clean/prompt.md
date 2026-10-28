# 任务：清洗 CSV 并输出 JSON

工作区有 `data.csv`。请生成两个文件：

## `clean.json`

数组，按 `id` 升序，每个元素恰好包含 `id`（数字）、`name`（字符串）、`amount`（数字）、`date`（`YYYY-MM-DD`）。

保留规则（全部满足才保留）：

1. `name` 去掉首尾空格后不能为空；
2. `amount` 必须是大于 0 的数字；
3. `date` 必须是合法的 `YYYY-MM-DD`。

## `summary.json`

对象：`{ "total": 保留条数, "dropped": 丢弃条数, "totalAmount": 保留行 amount 之和 }`。

不要修改 `data.csv`。
