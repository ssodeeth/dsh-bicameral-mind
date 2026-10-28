# 任务：跨文件重命名

把 `src/api.mjs` 导出的 `fetchUser` 重命名为 `getUser`，并同步所有调用方。

要求：

1. `src/` 下不能再出现 `fetchUser` 这个标识符；
2. 行为保持不变，`node --test test.mjs` 必须通过；
3. 不要修改测试文件 `test.mjs`。
