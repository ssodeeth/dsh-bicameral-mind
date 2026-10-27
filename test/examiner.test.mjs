import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExaminerSystem,
  buildExaminerUser,
  buildAdvocateSystem,
  buildAdvocateUser,
  buildAdvocateReplyUser,
  buildVerdictUser,
  parseExaminerOutput,
  parseAdvocateReply,
  formatToolResult,
  formatInterjection,
  formatPassNote,
} from '../src/examiner.js';

const VALID_VERDICTS = ['pass', 'revise', 'block'];
const VALID_MODES = ['json', 'fenced-json', 'heuristic'];
const DEFAULT_FIX = '请补充具体修正动作';

/* ------------------------------------------------------------------ */
/* parseExaminerOutput                                                 */
/* ------------------------------------------------------------------ */

test('parseExaminerOutput: 标准 JSON（parseMode=json）', () => {
  const text = JSON.stringify({
    verdict: 'revise',
    summary: '动作跳过了验证',
    issues: [
      { severity: 'must', problem: '没有运行测试就声称通过', evidence: '工具结果只显示文件写入', fix: '先执行测试再汇报' },
      { severity: 'should', problem: '汇报里缺少路径', evidence: 'claim 未提及输出目录', fix: '补充输出路径' },
    ],
    questions: ['是否允许覆盖旧文件？'],
  });

  const r = parseExaminerOutput(text);
  assert.equal(r.parseMode, 'json');
  assert.equal(r.verdict, 'revise');
  assert.equal(r.summary, '动作跳过了验证');
  assert.equal(r.issues.length, 2);
  assert.deepEqual(r.issues[0], {
    severity: 'must',
    problem: '没有运行测试就声称通过',
    evidence: '工具结果只显示文件写入',
    fix: '先执行测试再汇报',
  });
  assert.deepEqual(r.questions, ['是否允许覆盖旧文件？']);
});

test('parseExaminerOutput: ```json 围栏（parseMode=fenced-json）', () => {
  const text = [
    '```json',
    '{"verdict":"pass","summary":"未发现偏差","issues":[],"questions":[]}',
    '```',
  ].join('\n');

  const r = parseExaminerOutput(text);
  assert.equal(r.parseMode, 'fenced-json');
  assert.equal(r.verdict, 'pass');
  assert.equal(r.summary, '未发现偏差');
  assert.deepEqual(r.issues, []);
});

test('parseExaminerOutput: 无语言标记的围栏也能解析', () => {
  const text = '```\n{"verdict":"block","summary":"会删除用户数据","issues":[]}\n```';
  const r = parseExaminerOutput(text);
  assert.equal(r.parseMode, 'fenced-json');
  assert.equal(r.verdict, 'block');
});

test('parseExaminerOutput: 前后有废话的 JSON（切片恢复，parseMode=fenced-json）', () => {
  const text = [
    '好的，我审完了，结论如下：',
    '{"verdict":"revise","summary":"范围膨胀","issues":[{"severity":"must","problem":"多做了一件没要求的事","evidence":"任务只要求改 README","fix":"回退多余改动"}]}',
    '以上就是我的意见，请左脑处理。',
  ].join('\n');

  const r = parseExaminerOutput(text);
  assert.equal(r.parseMode, 'fenced-json');
  assert.equal(r.verdict, 'revise');
  assert.equal(r.summary, '范围膨胀');
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].severity, 'must');
});

test('parseExaminerOutput: 非法 verdict 按关键词推断', () => {
  assert.equal(parseExaminerOutput('{"verdict":"PASS","summary":"ok"}').verdict, 'pass');
  assert.equal(parseExaminerOutput('{"verdict":"approved","summary":"ok"}').verdict, 'pass');
  assert.equal(parseExaminerOutput('{"verdict":"需要修改","summary":"有问题"}').verdict, 'revise');
  assert.equal(parseExaminerOutput('{"verdict":"随便","summary":"建议 revise 后继续"}').verdict, 'revise');
  assert.equal(parseExaminerOutput('{"verdict":"maybe","summary":"继续执行会危险"}').verdict, 'block');
  assert.equal(parseExaminerOutput('{"verdict":"halt","summary":"停止"}').verdict, 'block');
  // 显式否定不算 pass
  assert.equal(parseExaminerOutput('{"verdict":"未通过","summary":"测试未通过"}').verdict, 'revise');
  // verdict 缺失时按 summary 推断
  assert.equal(parseExaminerOutput('{"summary":"无偏差，可以继续"}').verdict, 'pass');
});

test('parseExaminerOutput: 非法 issues 被清洗', () => {
  const text = JSON.stringify({
    verdict: 'revise',
    summary: '两个问题',
    issues: [
      null,
      '纯字符串不是 issue',
      { fix: '只有 fix 没有 problem' },
      { severity: 'critical', problem: '严重度非法', evidence: '结果里没有这一步', fix: '补一步' },
      { severity: 'MUST', problem: '缺 fix 的项', evidence: '日志为空' },
      { severity: 'should', problem: '缺 evidence 的项' },
    ],
    questions: '要不要现在停下？',
  });

  const r = parseExaminerOutput(text);
  assert.equal(r.issues.length, 3);
  // 非法 severity 归一为 should
  assert.equal(r.issues[0].severity, 'should');
  assert.equal(r.issues[1].severity, 'must');
  // 缺 fix 时使用默认修正动作
  assert.equal(r.issues[1].fix, DEFAULT_FIX);
  assert.equal(r.issues[2].evidence, '');
  assert.equal(r.issues[2].fix, DEFAULT_FIX);
  // 字符串 questions 宽松归一为数组
  assert.deepEqual(r.questions, ['要不要现在停下？']);
  // issues 非数组时清空
  const r2 = parseExaminerOutput('{"verdict":"pass","summary":"ok","issues":"none"}');
  assert.deepEqual(r2.issues, []);
});

test('parseExaminerOutput: summary 缺省回退', () => {
  assert.equal(parseExaminerOutput('{"verdict":"pass"}').summary, '右脑未给出结论');
  const withIssue = parseExaminerOutput(
    '{"verdict":"revise","issues":[{"severity":"must","problem":"没有验证"}]}',
  );
  assert.equal(withIssue.summary, '没有验证');
});

test('parseExaminerOutput: 纯散文走 heuristic', () => {
  const text = [
    '整体看还可以，但有两处需要改。',
    '- 未运行测试就声称已验证',
    '* 没有确认目录存在就删除文件',
    '2. 结论夸大了完成度',
    '5. 第四条应该被截掉',
  ].join('\n');

  const r = parseExaminerOutput(text);
  assert.equal(r.parseMode, 'heuristic');
  assert.equal(r.verdict, 'revise');
  assert.equal(r.summary, '整体看还可以，但有两处需要改。');
  assert.equal(r.issues.length, 3, 'heuristic 最多提取 3 条 issue');
  assert.equal(r.issues[0].severity, 'should');
  assert.equal(r.issues[0].problem, '未运行测试就声称已验证');
  assert.equal(r.issues[0].evidence, '');
  assert.equal(r.issues[0].fix, DEFAULT_FIX);
});

test('parseExaminerOutput: heuristic 关键词推断 pass / block', () => {
  assert.equal(parseExaminerOutput('审查完毕，未发现偏差。').verdict, 'pass');
  assert.equal(parseExaminerOutput('这一步很危险，必须停止。').verdict, 'block');
});

test('parseExaminerOutput: 空输入与非字符串', () => {
  for (const value of ['', '   ', '\n\n', null, undefined, 0, 42, {}, [], true]) {
    const r = parseExaminerOutput(value);
    assert.equal(r.verdict, 'revise');
    assert.equal(r.summary, '右脑输出为空，无法确认');
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.questions, []);
    assert.equal(r.parseMode, 'heuristic');
  }
});

test('parseExaminerOutput: 任意畸形输入都不抛异常且结构合法', () => {
  const inputs = [
    '{}',
    '[]',
    'null',
    '```',
    '```json\n{坏掉的 json}\n```',
    '{bad',
    '{"verdict":123,"issues":[{}]}',
    '{"verdict":"pass","issues":[{"problem":123}]}',
    '{ "verdict" : "pass" } trailing',
    '问题一\n问题二',
  ];
  for (const input of inputs) {
    let r;
    assert.doesNotThrow(() => {
      r = parseExaminerOutput(input);
    });
    assert.ok(VALID_VERDICTS.includes(r.verdict), `verdict 合法: ${input}`);
    assert.ok(VALID_MODES.includes(r.parseMode), `parseMode 合法: ${input}`);
    assert.equal(typeof r.summary, 'string');
    assert.ok(Array.isArray(r.issues));
    assert.ok(Array.isArray(r.questions));
  }
});

/* ------------------------------------------------------------------ */
/* parseAdvocateReply                                                  */
/* ------------------------------------------------------------------ */

test('parseAdvocateReply: 去围栏与首尾空白', () => {
  const text = '\n```markdown\n我认为应先补测试，再改实现。\n```\n';
  assert.equal(parseAdvocateReply(text), '我认为应先补测试，再改实现。');

  assert.equal(parseAdvocateReply('```\n先做 A。\n```'), '先做 A。');
  assert.equal(parseAdvocateReply('  纯散文，没有围栏。  '), '纯散文，没有围栏。');
});

test('parseAdvocateReply: 空值与非字符串', () => {
  assert.equal(parseAdvocateReply(''), '');
  assert.equal(parseAdvocateReply('   \n  '), '');
  assert.equal(parseAdvocateReply(undefined), '');
  assert.equal(parseAdvocateReply(null), '');
  assert.equal(parseAdvocateReply(123), '');
});

test('parseAdvocateReply: 最多 1200 字符', () => {
  const long = '甲'.repeat(5000);
  const out = parseAdvocateReply(long);
  assert.equal(out.length, 1200);
});

/* ------------------------------------------------------------------ */
/* formatToolResult                                                    */
/* ------------------------------------------------------------------ */

test('formatToolResult: 基本格式与 1800 字符上限', () => {
  const out = formatToolResult({
    stage: 'act',
    verdict: 'revise',
    summary: '写入了错误目录',
    issues: Array.from({ length: 5 }, (_, i) => ({
      severity: i === 4 ? 'must' : 'should',
      problem: `问题${i}：目标路径未确认`,
      evidence: '参数里的路径与任务要求不一致',
      fix: '改用任务指定路径',
    })),
    questions: ['是否覆盖已有文件？'],
  });

  assert.ok(out.length <= 1800, `长度 ${out.length} <= 1800`);
  assert.match(out, /右脑·动作/);
  assert.match(out, /需修正/);
  assert.match(out, /写入了错误目录/);
  // issues 最多展示 3 条
  const issueLines = out.split('\n').filter((line) => line.startsWith('- ['));
  assert.equal(issueLines.length, 3);
  // must 优先展示
  assert.match(issueLines[0], /\[must\]/);
});

test('formatToolResult: 含 full transcript 时仍不超过 1800 字符', () => {
  const out = formatToolResult({
    stage: 'finish',
    verdict: 'block',
    summary: '声称完成但没有任何验证证据',
    issues: [
      { severity: 'must', problem: '声称测试通过但无测试记录', evidence: '工具结果为空', fix: '重新执行测试' },
    ],
    transcript: {
      advocate: '甲'.repeat(700),
      critique: '乙'.repeat(700),
      reply: '答'.repeat(700),
      final: '终'.repeat(700),
    },
  });

  assert.ok(out.length <= 1800, `长度 ${out.length} <= 1800`);
  assert.match(out, /〔右脑记录〕/);
  assert.match(out, /左脑主张/);
  assert.match(out, /右脑质疑/);
  assert.match(out, /左脑答辩/);
  assert.match(out, /终裁/);
  assert.match(out, /block|阻断/);
});

test('formatToolResult: 降级提示与缺省字段', () => {
  const out = formatToolResult({ stage: 'checkpoint', verdict: 'revise', degraded: true, degradedReason: '超时' });
  assert.match(out, /右脑不可用/);
  assert.match(out, /超时/);
  // 无 summary / issues 时不抛异常
  assert.ok(formatToolResult({}).length > 0);
  assert.ok(formatToolResult().length > 0);
  // 超长 summary 会被截断并保持总长
  const huge = formatToolResult({
    verdict: 'revise',
    summary: 'x'.repeat(10000),
    issues: [{ severity: 'must', problem: 'p'.repeat(10000) }],
  });
  assert.ok(huge.length <= 1800);
});

/* ------------------------------------------------------------------ */
/* formatInterjection                                                  */
/* ------------------------------------------------------------------ */

test('formatInterjection: 前缀 / 长度 / 末尾提醒', () => {
  const reminderFrag = '不必盲从';
  const out = formatInterjection({
    stage: 'act',
    toolName: 'write_file',
    verdict: 'block',
    summary: '覆盖了用户未授权删除的文件',
    issues: [
      { severity: 'should', problem: '次要问题不应排第一' },
      { severity: 'must', problem: '目标路径是用户存档目录' },
      { severity: 'should', problem: '第三条不展示' },
    ],
  });

  assert.ok(out.startsWith('〔右脑·校正〕'), '必须固定前缀');
  assert.ok(out.length <= 700, `长度 ${out.length} <= 700`);
  assert.match(out, /write_file/);
  assert.match(out, /阻断/);
  assert.ok(out.trimEnd().endsWith('不必盲从。'), '末尾必须是提醒句');
  assert.ok(out.includes(reminderFrag));
  // must 优先，且最多两条 issue
  const issueLines = out.split('\n').filter((line) => line.startsWith('- ['));
  assert.equal(issueLines.length, 2);
  assert.match(issueLines[0], /\[must\]/);
  assert.ok(!out.includes('第三条不展示'));
});

test('formatInterjection: 超长输入仍守住 700 字符并保留提醒', () => {
  const out = formatInterjection({
    stage: 'finish',
    toolName: 'b'.repeat(500),
    verdict: 'revise',
    summary: 's'.repeat(5000),
    issues: Array.from({ length: 10 }, () => ({ severity: 'must', problem: 'p'.repeat(1000) })),
  });

  assert.ok(out.startsWith('〔右脑·校正〕'));
  assert.ok(out.length <= 700, `长度 ${out.length} <= 700`);
  assert.ok(out.trimEnd().endsWith('不必盲从。'));
});

/* ------------------------------------------------------------------ */
/* formatPassNote                                                      */
/* ------------------------------------------------------------------ */

test('formatPassNote: 固定注记', () => {
  assert.equal(formatPassNote({ stage: 'act' }), '〔右脑〕复核通过：未发现需要修正的偏差。');
  assert.equal(formatPassNote(), '〔右脑〕复核通过：未发现需要修正的偏差。');
  assert.match(formatPassNote({ stage: 'finish' }), /复核通过/);
});

/* ------------------------------------------------------------------ */
/* 提示词构造                                                          */
/* ------------------------------------------------------------------ */

test('buildExaminerSystem: 包含独立校正者人格与 JSON 契约', () => {
  const sys = buildExaminerSystem({ stage: 'act', language: 'zh', maxIssues: 5 });
  assert.match(sys, /右脑/);
  assert.match(sys, /独立校正者/);
  assert.match(sys, /听不到左脑的内心推理/);
  assert.match(sys, /只对任务目标/);
  assert.match(sys, /"verdict":"pass\|revise\|block"/);
  assert.match(sys, /revise：存在必须修正的问题/);
  assert.match(sys, /最多 5 条/);
  assert.match(sys, /全部使用中文/);
});

test('buildExaminerSystem: stage 差异', () => {
  const plan = buildExaminerSystem({ stage: 'plan' });
  const act = buildExaminerSystem({ stage: 'act' });
  const checkpoint = buildExaminerSystem({ stage: 'checkpoint' });
  const finish = buildExaminerSystem({ stage: 'finish' });

  assert.match(plan, /审查「计划」/);
  assert.match(plan, /没被声明的假定/);
  assert.match(act, /审查「刚执行完的一次工具动作」/);
  assert.match(checkpoint, /审查「阶段性结论」/);
  assert.match(finish, /审查「交付是否真正完成」/);
  assert.match(finish, /基本完成/);

  const bodies = new Set([plan, act, checkpoint, finish]);
  assert.equal(bodies.size, 4, '四个阶段的系统提示必须互不相同');
  // 未知 stage 不应抛异常
  assert.ok(buildExaminerSystem({ stage: 'unknown-stage' }).length > 0);
});

test('buildExaminerSystem: language 差异与 maxIssues', () => {
  const zh = buildExaminerSystem({ stage: 'act', language: 'zh' });
  const en = buildExaminerSystem({ stage: 'act', language: 'en' });
  const auto = buildExaminerSystem({ stage: 'act', language: 'auto' });

  assert.match(zh, /全部使用中文/);
  assert.match(en, /English/);
  assert.match(auto, /与任务相同的语言/);
  assert.notEqual(zh, en);
  assert.notEqual(zh, auto);

  assert.match(buildExaminerSystem({ maxIssues: 2 }), /最多 2 条/);
  assert.match(buildExaminerSystem({ maxIssues: 99 }), /最多 10 条/);
});

test('buildExaminerUser: 分区写入，缺失字段整块省略', () => {
  const onlyTask = buildExaminerUser({ stage: 'plan', task: '修复登录 bug' });
  assert.match(onlyTask, /## 任务/);
  assert.match(onlyTask, /修复登录 bug/);
  assert.ok(!onlyTask.includes('## 证据'));
  assert.ok(!onlyTask.includes('## 左脑的主张'));
  assert.ok(!onlyTask.includes('## 上一轮右脑尚未解决的问题'));
  assert.ok(!onlyTask.includes('## 左脑的答辩'));
  assert.match(onlyTask, /计划/);

  const all = buildExaminerUser({
    stage: 'checkpoint',
    task: '修复登录 bug',
    claim: '已修复',
    evidence: '测试输出 3 passed',
    priorIssues: '未验证边界条件',
    rebuttal: '边界条件在上一轮已覆盖',
  });
  const order = [
    '## 任务',
    '## 左脑的主张',
    '## 证据',
    '## 上一轮右脑尚未解决的问题',
    '## 左脑的答辩',
  ].map((h) => all.indexOf(h));
  for (const idx of order) assert.ok(idx >= 0, '分区标题必须存在');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '分区顺序应稳定');
  assert.match(all, /阶段结论/);

  // 完全没有输入也不崩
  assert.ok(buildExaminerUser({}).length > 0);
  assert.ok(buildExaminerUser().length > 0);
});

test('buildExaminerUser: 超长字段截断', () => {
  const prompt = buildExaminerUser({
    stage: 'act',
    task: 'T'.repeat(4000),
    evidence: 'E'.repeat(9000),
    priorIssues: 'P'.repeat(2000),
  });

  assert.equal(/T{1501}/.test(prompt), false, '任务应截断到 1500 字符');
  assert.equal(/T{1490}/.test(prompt), true);
  assert.equal(/E{3001}/.test(prompt), false, '证据应截断到 3000 字符');
  assert.equal(/E{2990}/.test(prompt), true);
  assert.equal(/P{801}/.test(prompt), false, 'priorIssues 应截断到 800 字符');
  assert.equal(/P{790}/.test(prompt), true);
  // 截断后的整体长度应远小于原始输入
  assert.ok(prompt.length < 1500 + 3000 + 800 + 2000);
});

test('buildAdvocateSystem: 左脑人格、语言、无编造', () => {
  const zh = buildAdvocateSystem({ language: 'zh' });
  assert.match(zh, /左脑/);
  assert.match(zh, /执行者/);
  assert.match(zh, /不得编造/);
  assert.match(zh, /120 词/);
  assert.match(zh, /全部使用中文/);

  const en = buildAdvocateSystem({ language: 'en' });
  assert.match(en, /English/);
  assert.notEqual(zh, en);
  assert.ok(buildAdvocateSystem().length > 0);
});

test('buildAdvocateUser: 说强主张，缺失证据不出现空块', () => {
  const user = buildAdvocateUser({ task: '给 CLI 加 --json 参数', claim: '我正在实现' });
  assert.match(user, /## 任务/);
  assert.match(user, /## 你目前的主张草稿/);
  assert.ok(!user.includes('## 可用证据'));
  assert.match(user, /120 词/);
  assert.match(user, /不得编造/);

  const withEvidence = buildAdvocateUser({
    task: 'T',
    evidence: '工具结果：package.json 已读取',
  });
  assert.match(withEvidence, /## 可用证据/);
  assert.ok(buildAdvocateUser().length > 0);
});

test('buildAdvocateReplyUser: 逐条答辩要求 + 截断', () => {
  const user = buildAdvocateReplyUser({
    task: '改配置',
    claim: '已完成',
    evidence: 'diff 显示改了一行',
    critique: '你没有确认目标文件就是用户说的那个',
  });

  assert.match(user, /右脑的质疑/);
  assert.match(user, /你没有确认目标文件/);
  assert.match(user, /接受/);
  assert.match(user, /反驳/);
  assert.match(user, /150 词/);
  assert.doesNotThrow(() => buildAdvocateReplyUser({}));
  assert.ok(buildAdvocateReplyUser({}).length > 0);

  const long = buildAdvocateReplyUser({ critique: 'C'.repeat(5000) });
  assert.equal(/C{1201}/.test(long), false);
});

test('buildVerdictUser: 逐条判定成立/不成立并要求同一 JSON', () => {
  const user = buildVerdictUser({
    task: '写单元测试',
    claim: '测试已全部通过',
    evidence: 'node --test 输出 12 passed',
    critique: '你没有展示失败用例的处理',
    reply: '失败用例在上一轮已覆盖',
  });

  assert.match(user, /上一轮的质疑/);
  assert.match(user, /左脑的答辩/);
  assert.match(user, /成立/);
  assert.match(user, /不成立/);
  assert.match(user, /JSON/);
  assert.match(user, /失败用例在上一轮已覆盖/);
  assert.doesNotThrow(() => buildVerdictUser({}));
  assert.ok(buildVerdictUser().length > 0);

  const long = buildVerdictUser({ task: 'T'.repeat(5000), reply: 'R'.repeat(5000) });
  assert.equal(/T{1501}/.test(long), false);
  assert.equal(/R{1201}/.test(long), false);
});
