# 任务：修复数学工具库

工作区里是一个小型数学工具库，测试已经写好但当前无法全部通过。

要求：

1. 修复 `average`：空数组应返回 `0`，不能返回 `NaN`。
2. 新增并导出 `median`：奇数个元素返回中间值，偶数个返回中间两个的平均值。
3. 不要修改测试文件 `math.test.mjs`。
4. 让 `node --test math.test.mjs` 全部通过。

完成后运行：`node --test math.test.mjs`。
