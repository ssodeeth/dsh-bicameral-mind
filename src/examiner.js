/**
 * Bicameral Mind · examiner（右脑 / 独立校正者）
 *
 * 纯函数模块：零 import，不依赖任何包，Node 20+ / ESM。
 *
 * 设计约束：
 * - 所有字符串输入做防御：undefined / null / 非字符串一律按空串处理。
 * - 提示词只写“已提供的字段”，缺失字段整块省略，不编造字段名或内容。
 * - 解析器绝不抛异常：任何输入都返回合法结构。
 * - 所有格式化输出都有硬长度上限（按字符数计）。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const STAGES = ['plan', 'act', 'checkpoint', 'finish'];

const STAGE_LABEL = Object.freeze({
  plan: '计划',
  act: '动作',
  checkpoint: '阶段结论',
  finish: '交付',
});

const VERDICT_LABEL = Object.freeze({
  pass: '通过',
  revise: '需修正',
  block: '阻断',
});

const TEXT = Object.freeze({
  emptyOutput: '右脑输出为空，无法确认',
  noSummary: '右脑未给出结论',
  defaultFix: '请补充具体修正动作',
  defaultProblem: '未描述具体问题',
});

/** 提示词里各字段的截断上限（字符） */
const LIMIT = Object.freeze({
  task: 1500,
  claim: 1200,
  evidence: 3000,
  priorIssues: 800,
  critique: 1200,
  reply: 1200,
  summary: 400,
  question: 300,
});

/** formatToolResult 的总长度上限 */
const TOOL_RESULT_MAX = 1800;
/** formatInterjection 的总长度上限 */
const INTERJECTION_MAX = 700;
/** transcript 单段最多展示的字符数 */
const TRANSCRIPT_SEG_MAX = 700;

/* ------------------------------------------------------------------ */
/* 基础防御工具                                                        */
/* ------------------------------------------------------------------ */

/** 任意值 -> 字符串；对象 / 数组 / undefined / null 一律视为空串。 */
function asString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 截断到 max 个字符（含省略号），保证返回值长度 <= max。 */
function clip(value, max) {
  const s = asString(value);
  const n = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  if (s.length <= n) return s;
  if (n <= 0) return '';
  if (n === 1) return '…';
  return s.slice(0, n - 1).trimEnd() + '…';
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 归一化阶段名；未知阶段退化为 'act'（“审查刚发生的事”最安全）。 */
function normalizeStage(stage) {
  const s = asString(stage).trim().toLowerCase();
  if (STAGES.includes(s)) return s;
  if (s === 'planning' || s === 'planner' || s === 'todo') return 'plan';
  if (s === 'acting' || s === 'action' || s === 'tool' || s === 'step') return 'act';
  if (s === 'check' || s === 'checking' || s === 'review' || s === 'summary') return 'checkpoint';
  if (s === 'done' || s === 'final' || s === 'deliver' || s === 'delivery') return 'finish';
  return 'act';
}

/** 仅接受严格的 pass / revise / block；否则返回 null。 */
function strictVerdict(value) {
  const s = asString(value).trim().toLowerCase();
  if (s === 'pass' || s === 'revise' || s === 'block') return s;
  return null;
}

/** severity 非 must/should 时归一为 should。 */
function normalizeSeverity(value) {
  return asString(value).trim().toLowerCase() === 'must' ? 'must' : 'should';
}

function normalizeMaxIssues(value, fallback = 5) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 10);
}

/**
 * 关键词推断裁决。
 * 规则顺序按约定：pass 关键词优先，其次 block，否则 revise。
 * 例外：显式否定（未通过 / 不通过）不算 pass。
 */
function inferVerdict(text) {
  const t = asString(text).toLowerCase();
  const passText = t.replace(/未通过|不通过|没有通过|没通过|不能通过/g, '');
  if (
    /pass|approve|\baccept\b|通过|无偏差|无明显偏差|没有偏差|未发现偏差|未发现问题|无需修改|无需修正|没有问题|可以继续/.test(
      passText,
    )
  ) {
    return 'pass';
  }
  if (/block|halt|\bstop\b|停止|危险|不可逆|不可继续|禁止|冲突/.test(t)) return 'block';
  return 'revise';
}

function languageDirective(language) {
  const l = asString(language).trim().toLowerCase();
  if (l === 'en' || l === 'english') {
    return '输出语言：全部使用英文（English），包括 summary、problem、evidence、fix、questions。路径、命令、代码片段保留原文。';
  }
  if (l === 'zh' || l === 'cn' || l === 'chinese') {
    return '输出语言：全部使用中文。路径、命令、代码片段、专有名词保留原文。';
  }
  return '输出语言：使用与任务相同的语言；无法判断时用中文。路径、命令、代码片段、专有名词保留原文。';
}

/** 从任意 issue 类似对象里读出规范化的 issue；无效项返回 null。 */
function readIssue(entry) {
  if (!isPlainObject(entry)) return null;
  let problem = asString(entry.problem ?? entry.issue ?? entry.reason).trim();
  const evidence = asString(entry.evidence ?? entry.evidenceQuote).trim();
  if (!problem) problem = evidence;
  if (!problem) return null;
  const fix = asString(entry.fix ?? entry.suggestedFix).trim();
  return {
    severity: normalizeSeverity(entry.severity),
    problem: clip(problem, LIMIT.summary),
    evidence: clip(evidence, LIMIT.summary),
    fix: clip(fix, LIMIT.summary) || TEXT.defaultFix,
  };
}

/** 从任意值读出问题数组（最多 limit 条）。 */
function readIssues(value, limit = 5) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const issue = readIssue(entry);
    if (issue) out.push(issue);
    if (out.length >= limit) break;
  }
  return out;
}

/** 把 questions 归一为字符串数组。 */
function readQuestions(value, limit = 5) {
  const source = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim() ? [value] : []);
  const out = [];
  for (const entry of source) {
    const q = asString(entry).trim();
    if (!q) continue;
    out.push(clip(q, LIMIT.question));
    if (out.length >= limit) break;
  }
  return out;
}

/** 读取右脑主动核销的旧问题（problem 原文或其可识别片段）。 */
function readResolved(value, limit = 5) {
  const source = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim() ? [value] : []);
  const out = [];
  for (const entry of source) {
    const text = asString(entry).trim();
    if (!text) continue;
    out.push(clip(text, LIMIT.summary));
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 提示词：右脑系统提示                                                */
/* ------------------------------------------------------------------ */

function stageFocus(stage) {
  switch (stage) {
    case 'plan':
      return [
        '审查「计划」：步骤是否覆盖任务的真实目标、顺序与依赖是否可行、是否缺关键验证步骤、',
        '是否偷偷扩大或缩小范围、有哪些没被声明的假定。',
        '此时通常还没有工具结果——不要因为“证据不足”就编造问题，真正的问题是计划里缺失的验证与风险处理。',
      ].join('');
    case 'checkpoint':
      return [
        '审查「阶段性结论」：结论是否被已给出的工具结果支撑、哪些是未验证的断言、',
        '是否把推测写成了事实、是否漏掉仍然失败的检查、是否夸大进度。',
      ].join('');
    case 'finish':
      return [
        '审查「交付是否真正完成」：任务每一条要求是否确实做到且有证据、是否夸大或用“基本完成 / 应该没问题”含糊收尾、',
        '是否遗漏验证与说明、是否留下未处理的副作用（临时文件、被改的配置、未清理的进程）。',
      ].join('');
    case 'act':
    default:
      return [
        '审查「刚执行完的一次工具动作」：这个动作是否服务于当前目标、参数是否正确（路径 / 命令 / 作用范围）、',
        '是否引入不可逆风险、是否与此前的声明一致、结果是否真的支持左脑的下一步。',
        '只评这一次动作及其直接后果，不要重审整个任务。',
      ].join('');
  }
}

/**
 * 右脑系统提示。
 * @param {{stage?: string, language?: string, maxIssues?: number}} [options]
 * @returns {string}
 */
export function buildExaminerSystem({ stage, language, maxIssues } = {}) {
  const st = normalizeStage(stage);
  const max = normalizeMaxIssues(maxIssues, 5);

  return [
    '你是「右脑」，一个独立校正者（examiner）。你不是执行者，也不与左脑（执行者）共享推理过程。',
    '',
    '## 身份与信息条件',
    '- 你没有行动利益：不需要让任务显得成功，也没有“给出建议就算帮忙”的压力。你只对任务目标是否被正确推进负责。',
    '- 你听不到左脑的内心推理。你能看到的只有：任务原文、左脑公开的主张、工具调用与结果（证据）。这个信息差正是你能独立判断的原因。',
    '- 不要替左脑补全它没写出来的推理。它没写出来、也没有证据支撑的部分，一律视为未验证。',
    '',
    '## 硬性纪律（违反即失去价值）',
    '1. 只报可验证的具体偏差。每条 issue 必须引用证据：任务原文 / 动作参数（命令、路径、范围）/ 工具结果片段。',
    '2. 禁止泛泛而谈。“要注意测试”、“建议再检查一下”、“保持谨慎”、“确保正确”、“可以再优化”这类话不得出现。',
    '3. 禁止为了显得有用而编造问题。没有可指出的偏差时，必须明确给 pass。',
    '4. 不得把左脑的结论当作证据：左脑说“已完成”不是证据，工具结果才是。',
    '5. 不做风格挑刺：除非影响正确性，不评论措辞、命名、格式、代码风格。',
    '',
    '## 审查优先级（从高到低）',
    '① 与用户真实目标是否一致：有无偏题、范围膨胀、偷换目标、只做完子集却宣称完成。',
    '② 证据是否充分：有无未验证就断言、把猜测当事实、把“应该”当“已经”。',
    '③ 不可逆风险：写 / 删 / 覆盖 / 执行命令 / 外发数据 / 改配置，是否确认过目标、是否可回退。',
    '④ 与先前步骤或自身声明是否矛盾。',
    '⑤ 完成度与验证缺口：哪些必需验证没做、哪些边界没覆盖。',
    '',
    '## 本阶段重点',
    stageFocus(st),
    '',
    '## 裁决规则',
    '- pass：无需修改。没有任何可指出的具体偏差时只能给 pass。',
    '- revise：存在必须修正的问题，issues 中至少有 1 条 severity 为 "must"。',
    '- block：方向错误、不可逆风险未经确认、或与用户目标冲突——应立即停下并说明。',
    `- issues 最多 ${max} 条，按 must 优先；不严重的问题用 "should"，不要凑数凑长度。`,
    '- 旧问题可能已经在后续动作中被修复：只有当前证据仍支撑时才继续列进 issues；如果证据表明它已被解决，把它写进 resolved 并从 issues 中移除。不要把已解决的问题重新提出来凑数。',
    '- 每条 problem / evidence / fix 各不超过 80 字；整段 JSON 保持紧凑，**必须完整闭合**（输出有长度上限，宁短勿断）。',
    '',
    '## 输出格式（只输出唯一一个 JSON 对象，不要 Markdown 代码围栏，不要任何额外解释）',
    '{"verdict":"pass|revise|block","summary":"一句话结论","issues":[{"severity":"must|should","problem":"具体偏差","evidence":"引用任务原文/动作参数/结果片段","fix":"最小修正动作"}],"resolved":["此前提出、当前证据已证明解决的问题原文"],"questions":["仅在必须问用户时才填"]}',
    '- summary 一句话说清结论；revise / block 时点出最关键的一条。',
    '- resolved 只在确实能引用当前证据证明旧问题已解决时填写，否则给空数组 []。',
    '- questions 只在真的必须由用户决定时才填，否则给空数组 []；不要把审查意见伪装成问题。',
    '',
    '## 输出语言',
    languageDirective(language),
  ].join('\n');
}

/**
 * 右脑用户提示：按阶段把可获得的字段分区写入，缺失字段整块省略。
 */
export function buildExaminerUser({ stage, task, claim, evidence, priorIssues, rebuttal } = {}) {
  const st = normalizeStage(stage);
  const sections = [`## 当前审查阶段：${STAGE_LABEL[st]}（${st}）`];

  const taskText = clip(task, LIMIT.task);
  if (taskText) sections.push(`## 任务（用户原始意图）\n${taskText}`);

  const claimText = clip(claim, LIMIT.claim);
  if (claimText) sections.push(`## 左脑的主张（它公开说出来的部分）\n${claimText}`);

  const evidenceText = clip(evidence, LIMIT.evidence);
  if (evidenceText) sections.push(`## 证据（工具调用与结果；这是你唯一的独立信息源）\n${evidenceText}`);

  const priorText = clip(priorIssues, LIMIT.priorIssues);
  if (priorText) sections.push(`## 此前未确认的问题（可能已被后续动作修复）\n${priorText}\n\n如果当前证据证明其中某条已经解决，请把它写进 resolved，而不是再次列进 issues。`);

  const rebuttalText = clip(rebuttal, LIMIT.claim);
  if (rebuttalText) sections.push(`## 左脑的答辩\n${rebuttalText}`);

  const bodyCount = sections.length - 1;
  if (bodyCount === 0) {
    sections.push('（没有提供任务、主张或证据。若无法做出有依据的判断，请给 revise 并说明需要哪些信息。）');
  }

  sections.push(
    [
      '## 请你现在做',
      `针对上面的「${STAGE_LABEL[st]}」做一次独立校正，按系统提示中的纪律与优先级审查。`,
      '只输出那一个 JSON 对象：不要代码围栏，不要前后解释，不要复述本提示。',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* 提示词：左脑（执行者）                                              */
/* ------------------------------------------------------------------ */

/** 左脑系统提示。 */
export function buildAdvocateSystem({ language } = {}) {
  return [
    '你是「左脑」，任务的执行者（advocate）。你不是旁观者：你要为当前主张给出最强、最具体的版本，让下一步行动可以直接执行。',
    '',
    '## 要求',
    '1. 说清三件事：目标是什么、下一步具体做什么、当前依据是什么（哪些有证据、哪些还没有）。',
    '2. 只能使用提供的任务与证据。不得编造未提供的证据、数字、文件内容、工具结果，也不得声称“已经测试”而实际没有。',
    '3. 证据不足必须明说，并降低确定性（例如“这是推断，尚未验证”）。把猜测说成事实是最严重的错误。',
    '4. “强”= 具体、可执行、可检验，不是夸大。禁止空话：“应该没问题”、“继续推进”、“已完成”（除非有证据）。',
    '5. 输出散文，不超过 120 词；不要 JSON、不要标题、不要列表、不要代码围栏。',
    '',
    '## 输出语言',
    languageDirective(language),
  ].join('\n');
}

/** 左脑用户提示：把当前主张说强（目标 / 下一步 / 依据）。 */
export function buildAdvocateUser({ task, claim, evidence } = {}) {
  const sections = [];
  const taskText = clip(task, LIMIT.task);
  if (taskText) sections.push(`## 任务\n${taskText}`);
  const claimText = clip(claim, LIMIT.claim);
  if (claimText) sections.push(`## 你目前的主张草稿（可能有缺漏，需要说强）\n${claimText}`);
  const evidenceText = clip(evidence, LIMIT.evidence);
  if (evidenceText) sections.push(`## 可用证据（工具调用与结果）\n${evidenceText}`);
  if (sections.length === 0) {
    sections.push('（没有提供任务、主张或证据。请直说信息不足，并说明你需要什么才能给出主张。）');
  }

  sections.push(
    [
      '## 你要做什么',
      '用不超过 120 词的散文，把主张说到最强最具体：目标、下一步动作、当前依据。',
      '只能使用上面给出的信息；证据不足处明确说明并降低确定性；不得编造；不要 JSON / 标题 / 列表 / 代码围栏。',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

/** 左脑用户提示：针对右脑的质疑逐条答辩。 */
export function buildAdvocateReplyUser({ task, claim, evidence, critique } = {}) {
  const sections = [];
  const taskText = clip(task, LIMIT.task);
  if (taskText) sections.push(`## 任务\n${taskText}`);
  const claimText = clip(claim, LIMIT.claim);
  if (claimText) sections.push(`## 你的主张\n${claimText}`);
  const evidenceText = clip(evidence, LIMIT.evidence);
  if (evidenceText) sections.push(`## 可用证据（工具调用与结果）\n${evidenceText}`);
  const critiqueText = clip(critique, LIMIT.critique);
  if (critiqueText) sections.push(`## 右脑的质疑（逐条答辩）\n${critiqueText}`);
  if (sections.length === 0) {
    sections.push('（没有提供任务、主张、证据或质疑。请直说信息不足。）');
  }

  sections.push(
    [
      '## 你要做什么',
      '逐条回应右脑的质疑：每条明确给出「接受」或「反驳」。',
      '反驳必须指出具体依据（任务原文 / 证据片段 / 动作参数）；没有依据就接受，或承认不确定。不得编造。',
      '用不超过 150 词的散文回答，不要 JSON / 标题 / 列表。',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* 提示词：右脑终裁                                                    */
/* ------------------------------------------------------------------ */

/** 右脑看完左脑答辩后的终裁提示。 */
export function buildVerdictUser({ task, claim, evidence, critique, reply } = {}) {
  const sections = [];
  const taskText = clip(task, LIMIT.task);
  if (taskText) sections.push(`## 任务\n${taskText}`);
  const claimText = clip(claim, LIMIT.claim);
  if (claimText) sections.push(`## 左脑的主张\n${claimText}`);
  const evidenceText = clip(evidence, LIMIT.evidence);
  if (evidenceText) sections.push(`## 证据（工具调用与结果）\n${evidenceText}`);
  const critiqueText = clip(critique, LIMIT.critique);
  if (critiqueText) sections.push(`## 你（右脑）上一轮的质疑\n${critiqueText}`);
  const replyText = clip(reply, LIMIT.reply);
  if (replyText) sections.push(`## 左脑的答辩\n${replyText}`);
  if (sections.length === 0) {
    sections.push('（没有提供任务、主张、证据、质疑或答辩。请给 revise 并说明需要哪些信息。）');
  }

  sections.push(
    [
      '## 终裁要求',
      '1. 对左脑的每一条反驳逐条判定「成立」或「不成立」，并给出一句理由。',
      '2. 判定为「成立」的反驳，其对应问题要从 issues 中移除或降级；判定为「不成立」的，保留该问题，并在 evidence 中引用左脑错误的地方。',
      '3. 结合全部信息给最终裁决（pass / revise / block）。不得因为左脑态度好、篇幅长或反复保证就放宽标准。',
      '4. 仍然只输出系统提示中规定的那一个 JSON 对象，字段不变；可在 summary 中用一句话概括对反驳的判定结果。',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

function stripFences(text) {
  const t = asString(text).trim();
  if (!t.includes('```')) return null;
  const full = t.match(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/);
  if (full) return full[1].trim();
  return t
    .replace(/```[a-zA-Z0-9_-]*/g, '')
    .replace(/```/g, '')
    .trim();
}

function tryParseObject(text) {
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function braceSlice(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function emptyResult() {
  return {
    verdict: 'revise',
    summary: TEXT.emptyOutput,
    issues: [],
    questions: [],
    resolved: [],
    parseMode: 'heuristic',
  };
}

function heuristicParse(text) {
  // 被截断的 JSON 仍然保留着 `"verdict":"revise"` 这样的片段：先直接读它，
  // 避免把「误判为通过」这类描述性文字当成真正的 pass。
  const verdictMatch = /"verdict"\s*:\s*"(pass|revise|block)"/i.exec(text);
  const issues = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*•]|\d{1,2}[.)、])\s+(.+)$/);
    if (!match) continue;
    const problem = asString(match[1]).trim();
    if (!problem) continue;
    issues.push({
      severity: 'should',
      problem: clip(problem, LIMIT.question),
      evidence: '',
      fix: TEXT.defaultFix,
    });
    if (issues.length >= 3) break;
  }

  let summary = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:[-*•]|\d{1,2}[.)、])\s+/.test(trimmed)) continue;
    summary = clip(trimmed, 200);
    break;
  }
  if (!summary) summary = issues.length > 0 ? issues[0].problem : TEXT.noSummary;

  return {
    verdict: verdictMatch ? verdictMatch[1].toLowerCase() : inferVerdict(text),
    summary,
    issues,
    questions: [],
    resolved: [],
    parseMode: 'heuristic',
  };
}

function finalizeParsed(obj, rawText) {
  const rawSummary = clip(asString(obj.summary).trim(), LIMIT.summary);
  const issues = readIssues(obj.issues, 10);

  const verdict =
    strictVerdict(obj.verdict) ||
    inferVerdict(`${asString(obj.verdict)} ${rawSummary}`) ||
    'revise';

  const summary = rawSummary || (issues.length > 0 ? issues[0].problem : TEXT.noSummary);

  return {
    verdict,
    summary,
    issues,
    questions: readQuestions(obj.questions, 5),
    resolved: readResolved(obj.resolved, 5),
    parseMode: 'json',
  };
}

/**
 * 健壮解析右脑输出。绝不抛异常。
 *
 * 解析顺序：
 * 1. 整体 JSON.parse                       -> parseMode 'json'
 * 2. 剥掉 ```json 围栏后再解析             -> parseMode 'fenced-json'
 * 3. 取第一个 { 到最后一个 } 的子串再解析    -> parseMode 'fenced-json'
 * 4. 纯散文启发式                          -> parseMode 'heuristic'
 *
 * @param {string} text
 * @returns {{verdict: 'pass'|'revise'|'block', summary: string, issues: Array<{severity: 'must'|'should', problem: string, evidence: string, fix: string}>, questions: string[], parseMode: 'json'|'fenced-json'|'heuristic'}}
 */
export function parseExaminerOutput(text) {
  if (typeof text !== 'string' || text.trim() === '') return emptyResult();

  const clean = text.replace(/^\uFEFF/, '').trim();

  // 1) 整体 JSON
  const direct = tryParseObject(clean);
  if (direct) return finalizeParsed(direct, clean);

  // 2) 代码围栏
  const unfenced = stripFences(clean);
  if (unfenced) {
    const fenced = tryParseObject(unfenced);
    if (fenced) return { ...finalizeParsed(fenced, unfenced), parseMode: 'fenced-json' };
  }

  // 3) 前后有废话：切出第一个 { 到最后一个 }
  const slicedText = braceSlice(unfenced || clean);
  if (slicedText) {
    const sliced = tryParseObject(slicedText);
    if (sliced) return { ...finalizeParsed(sliced, slicedText), parseMode: 'fenced-json' };
  }

  // 4) 启发式
  return heuristicParse(clean);
}

/**
 * 解析左脑的答辩文本：去掉首尾空白与代码围栏，返回散文，最多 1200 字符。
 * @param {string} text
 * @returns {string}
 */
export function parseAdvocateReply(text) {
  if (typeof text !== 'string') return '';
  let s = text.replace(/^\uFEFF/, '').trim();
  if (!s) return '';

  const unfenced = stripFences(s);
  if (unfenced) s = unfenced.trim();

  // 去掉可能残留的整行围栏标记
  s = s
    .split(/\r?\n/)
    .filter((line) => !/^\s*```[a-zA-Z0-9_-]*\s*$/.test(line))
    .join('\n')
    .trim();

  return clip(s, 1200);
}

/* ------------------------------------------------------------------ */
/* 格式化：给模型的工具结果                                            */
/* ------------------------------------------------------------------ */

function orderedIssues(issues) {
  if (!Array.isArray(issues)) return [];
  const seen = [];
  for (const entry of issues) {
    const issue = readIssue(entry);
    if (!issue) continue;
    seen.push(issue);
  }
  seen.sort((a, b) => (a.severity === 'must' ? 0 : 1) - (b.severity === 'must' ? 0 : 1));
  return seen;
}

/**
 * 把右脑审查结果格式化成模型可读的简洁 Markdown。
 * 总长 <= 1800 字符；issues 最多展示 3 条。
 */
export function formatToolResult({
  stage,
  verdict,
  summary,
  issues,
  questions,
  transcript,
  degraded,
  degradedReason,
} = {}) {
  const st = normalizeStage(stage);
  const v = strictVerdict(verdict) || 'revise';
  const lines = [`**〔右脑·${STAGE_LABEL[st]}〕${VERDICT_LABEL[v]}**`];

  const summaryText = clip(asString(summary).trim(), 220);
  if (summaryText) lines.push(summaryText);

  const shown = orderedIssues(issues).slice(0, 3);
  for (const issue of shown) {
    lines.push(`- [${issue.severity}] ${clip(issue.problem, 150)}`);
    const ev = clip(issue.evidence, 110);
    if (ev) lines.push(`  证据：${ev}`);
    const fix = clip(issue.fix, 90);
    if (fix && fix !== TEXT.defaultFix) lines.push(`  修正：${fix}`);
  }

  const questionList = Array.isArray(questions) ? questions : [];
  const questionTexts = [];
  for (const q of questionList) {
    const text = clip(asString(q).trim(), 140);
    if (text) questionTexts.push(text);
    if (questionTexts.length >= 2) break;
  }
  if (questionTexts.length > 0) lines.push(`需确认：${questionTexts.join('；')}`);

  if (degraded) {
    const reason = clip(asString(degradedReason).trim(), 160);
    lines.push(reason ? `（右脑不可用，已跳过独立校正：${reason}）` : '（右脑不可用，已跳过独立校正。）');
  }

  // 主体部分先收在 1250 以内，给 transcript 留预算。
  let head = clip(lines.join('\n'), 1250);

  const segments = [];
  if (isPlainObject(transcript)) {
    const defs = [
      ['advocate', '左脑主张'],
      ['critique', '右脑质疑'],
      ['reply', '左脑答辩'],
      ['final', '终裁'],
    ];
    for (const [key, label] of defs) {
      const value = clip(transcript[key], TRANSCRIPT_SEG_MAX);
      if (value) segments.push({ label, value });
    }
  }

  if (segments.length > 0) {
    const title = '〔右脑记录〕';
    const remaining = TOOL_RESULT_MAX - head.length - title.length - 2;
    if (remaining >= 160) {
      const perSegment = Math.max(120, Math.floor(remaining / segments.length) - 8);
      const segLines = segments.map(
        (seg) => `${seg.label}：${clip(seg.value, Math.min(TRANSCRIPT_SEG_MAX, perSegment))}`,
      );
      head = `${head}\n${title}\n${segLines.join('\n')}`;
    }
  }

  return head.length <= TOOL_RESULT_MAX ? head : clip(head, TOOL_RESULT_MAX);
}

/**
 * 右脑主动插话：要注入成一条 user 消息的文本。
 * 开头固定为「〔右脑·校正〕」，总长 <= 700 字符，末尾必带“不必盲从”的提醒。
 */
export function formatInterjection({ stage, toolName, verdict, summary, issues } = {}) {
  const reminder = '如认为右脑判断有误，可用一句话说明依据后继续，不必盲从。';
  const st = normalizeStage(stage);
  const v = strictVerdict(verdict) || 'revise';

  const head = [`〔右脑·校正〕${STAGE_LABEL[st]}｜${VERDICT_LABEL[v]}`];

  const tool = clip(asString(toolName).trim(), 60);
  if (tool) head[0] += `｜${tool}`;

  const summaryText = clip(asString(summary).trim(), 240);
  if (summaryText) head.push(summaryText);

  const shown = orderedIssues(issues).slice(0, 2);
  for (const issue of shown) {
    head.push(`- [${issue.severity}] ${clip(issue.problem, 150)}`);
  }

  const budget = INTERJECTION_MAX - reminder.length - 1;
  const headText = clip(head.join('\n'), budget);
  return `${headText}\n${reminder}`;
}

/**
 * 复核通过时的一句话注记。
 * @param {{stage?: string}} [options]
 * @returns {string}
 */
export function formatPassNote({ stage } = {}) {
  // stage 仅用于保持与其它格式化函数一致的签名；通过注记本身是固定文本。
  void normalizeStage(stage);
  return '〔右脑〕复核通过：未发现需要修正的偏差。';
}
