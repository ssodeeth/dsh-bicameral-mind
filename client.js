/**
 * Bicameral Mind — Web UI (Client half).
 *
 * Registers two surfaces:
 *
 *  1. the inner-dialogue view (`conversation.view`, a session-scope list slot
 *     beside Conversation and Trajectory) showing the left/right-brain review
 *     ledger of the active session;
 *  2. a settings page (`settings.section`, a root-scope list slot) that edits
 *     the plugin's user-owned configuration.
 *
 * The view is a thin client over the plugin's own same-origin routes:
 *
 *   - `GET /bicameral-mind/state?sessionId=<id>` returns the live snapshot
 *     (master switch, both voice routes, and the bounded per-session
 *     transcripts);
 *   - `POST /bicameral-mind/toggle` flips the master switch.
 *
 * The settings page reads and writes the same Host runtime settings:
 *
 *   - `GET /bicameral-mind/config` → editable settings, effective routes and
 *     the settings-file path;
 *   - `POST /bicameral-mind/config` with a partial `{ patch }` subtree;
 *   - `GET /bicameral-mind/models` → provider/model catalog for the pickers;
 *   - `POST /bicameral-mind/probe` with one explicit route.
 *
 * Everything visible comes from `--dsw-alias-*` theme tokens, so both surfaces
 * follow light/dark schemes without literal colors. Teardown is per-surface: the
 * view clears its poll timer and aborts its in-flight snapshot request, and the
 * settings page aborts its two load requests; every component also removes its
 * own `<style>` element through React unmounting.
 *
 * Hand-written ModuleLoader bundle: no build step, no JSX, and no dependency
 * beyond the `react` the shell already provides.
 */
window.__ModuleLoader__.load({
	id: "dsh-bicameral-mind",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		/** Locale namespace carried by the slot registration. */
		const NS = "bicameralMind";

		/** Snapshot polling interval. */
		const POLL_MS = 2500;

		/** Consecutive failed polls after which the route is declared unavailable. */
		const FAILURE_LIMIT = 2;

		/** How many recent reviews the inner-dialogue page lists. */
		const ENTRY_LIMIT = 12;

		/**
		 * Built-in copy. Registering these through the locale service keeps the
		 * text localizable while the fallback map keeps the UI readable when
		 * the host has no dictionary for this namespace at all: `t(key)` returns
		 * the key itself there, and the components supply the built-in copy.
		 */
		const DICT = {
			zh: {
				title: "内心对话",
				description: "左脑＝执行者（会话模型）；右脑＝校正者（独立模型），右脑可以是另一个模型。",
				"voice.actor": "左脑",
				"voice.examiner": "右脑",
				"role.actor": "左",
				"role.examiner": "右",
				none: "未配置",
				pinned: "已钉死",
				pendingBadge: "{count} 条未决问题",
				switchAria: "二分心智总开关，当前{state}",
				on: "开",
				off: "关",
				empty: "暂无审议记录——当 agent 调用 bicameral，或在有后果的动作后，左右脑的对话会出现在这里。",
				routeUnavailable: "Host 路由不可用",
				toggleFailed: "开关切换失败",
				showTranscript: "展开对话",
				hideTranscript: "收起对话",
				transcriptLabel: "内心对话",
				"transcript.advocate": "左脑主张",
				"transcript.critique": "右脑质疑",
				"transcript.reply": "左脑答辩",
				"transcript.final": "终裁",
				"stage.plan": "\u8ba1\u5212",
				"stage.act": "\u52a8\u4f5c",
				"stage.checkpoint": "\u9636\u6bb5\u68c0\u67e5",
				"stage.finish": "\u6536\u5c3e",
				"verdict.pass": "\u901a\u8fc7",
				"verdict.revise": "\u9700\u4fee\u6539",
				"verdict.block": "\u963b\u65ad",
				"verdict.unavailable": "\u4e0d\u53ef\u7528",
				noSummary: "\uff08\u65e0\u6458\u8981\uff09",
				loading: "正在读取内心对话…",
				refresh: "刷新",
				"issue.fix": "修正：",
				"issues.title": "尚未解决问题",
				"issues.empty": "当前没有未决问题。",
				"issues.clear": "全部清空",
				"issues.confirmClear": "确认清空",
				"issues.resolve": "核销",
				"issues.resolved": "已核销 {count} 条",
				"issues.failed": "核销失败，请重试",
				"issues.age": "第 {turn} 轮 step {step}",
				"issues.ageTurn": "第 {turn} 轮",
				// Composer toolbar right-brain model picker.
				"pick.trigger": "选择右脑模型",
				"pick.follow": "跟随",
				"pick.followDefault": "跟随设置默认",
				"pick.default": "默认",
				"pick.manual": "手动填写",
				"pick.manualHint": "模型目录不可用时可直接填 provider / model",
				"pick.manualProvider": "provider",
				"pick.manualModel": "model",
				"pick.apply": "应用",
				"pick.retry": "重试",
				"pick.more": "更多设置：设置 → 二分心智",
				"pick.loading": "正在读取模型清单…",
				"pick.failed": "模型清单不可用",
				"pick.saving": "正在保存…",
				// Settings page ("settings.section").
				nav: "二分心智",
				"set.heading": "二分心智 · 双声",
				"set.levelTitle": "介入程度",
				"set.levelHint": "一次选择一组参数；手动改下面的参数会变成『自定义』。",
				"set.levelCustom": "当前参数为自定义，不符合任何预设。",
				"set.levelApplying": "正在应用…",
				"set.levelSwitched": "已切换到「{title}」",
				"set.budgetTitle": "成本护栏",
				"set.budgetHint": "限制每轮模型调用、完整辩论与 token 估算；达到上限后本轮不再自动审议，显式 bicameral 调用会返回预算提示。",
				"set.budgetEnabled": "启用成本护栏",
				"set.budgetEnabledHint": "关闭后不做任何成本限制。",
				"set.budgetCalls": "每轮调用上限",
				"set.budgetCallsHint": "完整辩论记 3 次调用",
				"set.budgetFull": "完整辩论上限",
				"set.budgetTokens": "token 估算上限",
				"set.budgetCallsUnit": "次",
				"set.budgetFullUnit": "次",
				"set.budgetTokensUnit": "tokens",
				"set.budgetCustom": "当前为自定义数值",
				"set.budgetOff": "成本护栏已关闭（不限制）",
				"set.budgetApplying": "正在应用…",
				"set.budgetSwitched": "已切换到「{title}」",
				"set.budgetTierRelaxed": "宽松",
				"set.budgetTierStandard": "标准",
				"set.budgetTierFrugal": "节约",
				"set.budget.relaxed.title": "宽松",
				"set.budget.relaxed.desc": "每轮最多 30 次调用、8 次完整辩论、约 60k tokens；适合长任务。",
				"set.budget.standard.title": "标准",
				"set.budget.standard.desc": "每轮最多 12 次调用、3 次完整辩论、约 24k tokens（默认）。",
				"set.budget.frugal.title": "节约",
				"set.budget.frugal.desc": "每轮最多 6 次调用、1 次完整辩论、约 12k tokens；成本优先。",
				"set.level.off.title": "关闭",
				"set.level.off.desc": "完全不介入：协议与工具均不可用，不做任何自动复审。",
				"set.level.advisory.title": "提示",
				"set.level.advisory.desc": "只在左脑显式调用 bicameral 时介入；不主动插话、不做收尾检查。",
				"set.level.balanced.title": "标准",
				"set.level.balanced.desc": "有后果的写入 / 执行后主动复核；未决问题未收敛时收尾闸门介入。",
				"set.level.strict.title": "严格",
				"set.level.strict.desc": "所有工具动作都复核（明显只读的 shell 命令除外）；每轮收尾都会再审一次；计划 / 阶段 / 收尾用完整审议。",
				"set.level.paranoid.title": "偏执",
				"set.level.paranoid.desc": "连只读命令也复核；每次审议默认完整对话；冷却为 0、每轮预算最高，成本与延迟最高。",
				"set.intro": "左脑＝执行者（会话模型）；右脑＝校正者（独立模型），可配成另一个模型。",
				"set.enabled": "启用二分心智",
				"set.enabledHint": "总开关。关闭后右脑不再自动插话，审议工具仍可手动调用。",
				"set.examiner": "右脑（校正者）",
				"set.examinerHint": "独立于会话模型的校正者。留空表示跟随会话路由。",
				"set.actor": "左脑（执行者）",
				"set.actorHint": "执行任务的会话模型。留空表示跟随当前会话。",
				"set.provider": "供应商",
				"set.model": "模型",
				"set.follow": "（不指定，跟随会话）",
				"set.unset": "（未设置）",
				"set.manual": "手填",
				"set.pick": "从清单选择",
				"set.modelsLoading": "正在读取模型清单…",
				"set.modelsFailed": "模型清单不可用，已切换为手填",
				"set.currentOption": "（当前：{value}）",
				"set.currentNotInCatalog": "（当前值，不在目录：{value}）",
				"set.candidates": "候选降级链",
				"set.candidatesHint": "主路由不可用时按顺序尝试。",
				"set.addCandidate": "添加候选",
				"set.removeCandidate": "删除此候选",
				"set.probe": "探测此路由",
				"set.probing": "探测中…",
				"set.probeMissing": "先填写 provider 与 model",
				"set.resetExaminer": "恢复跟随会话",
				"set.resetActor": "恢复默认",
				"set.auto": "自动插话",
				"set.autoHint": "右脑在有后果的动作后主动校正。",
				"set.autoEnabled": "启用自动插话",
				"set.tools": "监视工具（逗号分隔）",
				"set.toolsHint": "只有这些工具的结果会触发自动审议；* 表示全部工具。",
				"set.cooldown": "冷却（毫秒）",
				"set.maxPerTurn": "每轮上限",
				"set.timeout": "单次超时（毫秒）",
				"set.maxTokens": "最大输出 Token",
				"set.finishGate": "收尾闸门",
				"set.finishGateHint": "存在未决问题时阻止草率收尾。",
				"set.finishAlways": "每轮收尾必审",
				"set.finishAlwaysHint": "没有未决问题时也审一次最终回答（严格 / 偏执档默认开启）。",
				"set.includeErrors": "包含失败的工具结果",
				"set.includeErrorsHint": "默认忽略失败调用。",
				"set.subagents": "子智能体也审议",
				"set.subagentsHint": "默认只审议顶层会话。",
				"set.review": "完整审议",
				"set.reviewHint": "完整审议会追加左脑答辩与右脑终裁，成本更高。",
				"set.depth": "默认审议深度",
				"set.depthQuick": "quick（单轮质疑）",
				"set.depthFull": "full（答辩 + 终裁）",
				"set.stages": "完整审议阶段",
				"set.save": "保存",
				"set.saving": "保存中…",
				"set.saved": "已保存",
				"set.reload": "重新读取",
				"set.loading": "正在读取配置…",
				"set.routeUnavailable": "Host 路由不可用",
				"set.noChanges": "没有需要保存的改动",
				"set.routes": "实际生效路由：",
				"set.path": "配置文件路径",
				"set.pairError": "{role}的 provider 与 model 必须同时填写或同时留空",
				"set.candidatePairError": "候选降级链第 {index} 行的 provider 与 model 必须同时填写",
				"set.rangeError": "{field}必须在 {min}..{max} 之间",
				"set.numberError": "{field}必须是数字",
			},
			en: {
				title: "Inner Dialogue",
				description: "Left brain = the executor (session model); Right brain = the corrector (an independent model, possibly a different one).",
				"voice.actor": "Left brain",
				"voice.examiner": "Right brain",
				"role.actor": "L",
				"role.examiner": "R",
				none: "unconfigured",
				pinned: "pinned",
				pendingBadge: "{count} open issue(s)",
				switchAria: "Bicameral Mind master switch, currently {state}",
				on: "on",
				off: "off",
				empty: "No reviews yet — when the agent calls bicameral, or after a consequential action, the left/right brain dialogue appears here.",
				routeUnavailable: "Host route unavailable",
				toggleFailed: "Could not flip the switch",
				showTranscript: "Show dialogue",
				hideTranscript: "Hide dialogue",
				transcriptLabel: "Inner dialogue",
				"transcript.advocate": "Left brain claim",
				"transcript.critique": "Right brain critique",
				"transcript.reply": "Left brain rebuttal",
				"transcript.final": "Final verdict",
				"stage.plan": "Plan",
				"stage.act": "Action",
				"stage.checkpoint": "Checkpoint",
				"stage.finish": "Finish",
				"verdict.pass": "Pass",
				"verdict.revise": "Revise",
				"verdict.block": "Block",
				"verdict.unavailable": "Unavailable",
				noSummary: "(no summary)",
				loading: "Loading the inner dialogue…",
				refresh: "Refresh",
				"issue.fix": "Fix: ",
				"issues.title": "Unresolved issues",
				"issues.empty": "No unresolved issues.",
				"issues.clear": "Clear all",
				"issues.confirmClear": "Confirm clear",
				"issues.resolve": "Resolve",
				"issues.resolved": "Resolved {count}",
				"issues.failed": "Resolve failed, please retry",
				"issues.age": "turn {turn}, step {step}",
				"issues.ageTurn": "turn {turn}",
				// Composer toolbar right-brain model picker.
				"pick.trigger": "Choose the right-brain model",
				"pick.follow": "follow session",
				"pick.followDefault": "Follow settings default",
				"pick.default": "Default",
				"pick.manual": "Enter manually",
				"pick.manualHint": "Use provider / model directly when the catalog is unavailable",
				"pick.manualProvider": "provider",
				"pick.manualModel": "model",
				"pick.apply": "Apply",
				"pick.retry": "Retry",
				"pick.more": "More settings: Settings → Bicameral Mind",
				"pick.loading": "Loading model catalog…",
				"pick.failed": "Model catalog unavailable",
				"pick.saving": "Saving…",
				// Settings page ("settings.section").
				nav: "Bicameral Mind",
				"set.heading": "Bicameral Mind · Two Voices",
				"set.levelTitle": "Intervention level",
				"set.levelHint": "One choice applies a whole parameter set; editing the values below turns it into “custom”.",
				"set.levelCustom": "The current parameters are custom and match no preset.",
				"set.levelApplying": "Applying…",
				"set.levelSwitched": "Switched to “{title}”",
				"set.budgetTitle": "Cost guard",
				"set.budgetHint": "Caps per-turn model calls, full debates and token estimates; once a cap is hit the rest of the turn skips automatic review, and an explicit bicameral call returns a budget notice.",
				"set.budgetEnabled": "Enable cost guard",
				"set.budgetEnabledHint": "When off, no cost limits are applied.",
				"set.budgetCalls": "Calls per turn",
				"set.budgetCallsHint": "A full debate counts as 3 calls",
				"set.budgetFull": "Full debates per turn",
				"set.budgetTokens": "Token estimate limit",
				"set.budgetCallsUnit": "calls",
				"set.budgetFullUnit": "debates",
				"set.budgetTokensUnit": "tokens",
				"set.budgetCustom": "Custom values are active",
				"set.budgetOff": "Cost guard is off (no limits)",
				"set.budgetApplying": "Applying…",
				"set.budgetSwitched": "Switched to “{title}”",
				"set.budgetTierRelaxed": "Relaxed",
				"set.budgetTierStandard": "Standard",
				"set.budgetTierFrugal": "Frugal",
				"set.budget.relaxed.title": "Relaxed",
				"set.budget.relaxed.desc": "Up to 30 calls, 8 full debates and about 60k tokens per turn; for long tasks.",
				"set.budget.standard.title": "Standard",
				"set.budget.standard.desc": "Up to 12 calls, 3 full debates and about 24k tokens per turn (default).",
				"set.budget.frugal.title": "Frugal",
				"set.budget.frugal.desc": "Up to 6 calls, 1 full debate and about 12k tokens per turn; cost first.",
				"set.level.off.title": "Off",
				"set.level.off.desc": "No protocol, no usable tool, no automatic review.",
				"set.level.advisory.title": "Advisory",
				"set.level.advisory.desc": "Only when the actor explicitly calls bicameral; no unprompted interjections or finish checks.",
				"set.level.balanced.title": "Balanced",
				"set.level.balanced.desc": "Reviews write/execute actions; the finish gate runs only while issues are pending.",
				"set.level.strict.title": "Strict",
				"set.level.strict.desc": "Reviews every tool action (except clearly read-only shell commands); every turn ending is reviewed; plan/checkpoint/finish use full debate.",
				"set.level.paranoid.title": "Paranoid",
				"set.level.paranoid.desc": "Even read-only commands are reviewed; every debate is full by default; zero cooldown and the highest budget — highest cost and latency.",
				"set.intro": "Left brain = the executor (session model); Right brain = the corrector (an independent model, possibly a different one).",
				"set.enabled": "Enable Bicameral Mind",
				"set.enabledHint": "Master switch. When off, the right brain stops interjecting; the review tool still works on demand.",
				"set.examiner": "Right brain (corrector)",
				"set.examinerHint": "An independent corrector. Leave empty to follow the session route.",
				"set.actor": "Left brain (executor)",
				"set.actorHint": "The session model that does the work. Leave empty to follow the current session.",
				"set.provider": "Provider",
				"set.model": "Model",
				"set.follow": "(not set — follow the session)",
				"set.unset": "(not set)",
				"set.manual": "Type manually",
				"set.pick": "Pick from list",
				"set.modelsLoading": "Loading model catalog…",
				"set.modelsFailed": "Model catalog unavailable; switched to manual input",
				"set.currentOption": "(current: {value})",
				"set.currentNotInCatalog": "(current value, not in catalog: {value})",
				"set.candidates": "Fallback chain",
				"set.candidatesHint": "Tried in order when the primary route is unavailable.",
				"set.addCandidate": "Add candidate",
				"set.removeCandidate": "Remove this candidate",
				"set.probe": "Probe this route",
				"set.probing": "Probing…",
				"set.probeMissing": "Fill in provider and model first",
				"set.resetExaminer": "Follow the session",
				"set.resetActor": "Reset to default",
				"set.auto": "Automatic interjection",
				"set.autoHint": "The right brain corrects after consequential actions.",
				"set.autoEnabled": "Enable automatic interjection",
				"set.tools": "Watched tools (comma separated)",
				"set.toolsHint": "Only these tools' results trigger an automatic review; * means all tools.",
				"set.cooldown": "Cooldown (ms)",
				"set.maxPerTurn": "Per-turn limit",
				"set.timeout": "Per review timeout (ms)",
				"set.maxTokens": "Max output tokens",
				"set.finishGate": "End-of-turn gate",
				"set.finishGateHint": "Keep the turn open while issues are unresolved.",
				"set.finishAlways": "Review every turn ending",
				"set.finishAlwaysHint": "Review the final answer even when no issues are pending (on in strict / paranoid).",
				"set.includeErrors": "Include failed tool results",
				"set.includeErrorsHint": "Failed calls are ignored by default.",
				"set.subagents": "Review subagents too",
				"set.subagentsHint": "Only the top-level session is reviewed by default.",
				"set.review": "Full review",
				"set.reviewHint": "Adds the left brain's rebuttal and the right brain's final verdict; costs more.",
				"set.depth": "Default review depth",
				"set.depthQuick": "quick (one critique round)",
				"set.depthFull": "full (rebuttal + final verdict)",
				"set.stages": "Full-review stages",
				"set.save": "Save",
				"set.saving": "Saving…",
				"set.saved": "Saved",
				"set.reload": "Reload",
				"set.loading": "Loading settings…",
				"set.routeUnavailable": "Host route unavailable",
				"set.noChanges": "Nothing to save",
				"set.routes": "Effective routes:",
				"set.path": "Settings file",
				"set.pairError": "{role}: provider and model must both be filled or both be empty",
				"set.candidatePairError": "Fallback chain row {index}: provider and model are both required",
				"set.rangeError": "{field} must be between {min} and {max}",
				"set.numberError": "{field} must be a number",
			},
		};

		/** Built-in copy used when the locale service holds no entry for a key. */
		const FALLBACK = DICT.zh;

		/** Review stage → locale key. */
		const STAGE_KEYS = {
			plan: "stage.plan",
			act: "stage.act",
			checkpoint: "stage.checkpoint",
			finish: "stage.finish",
		};

		/** Verdicts the dot color language distinguishes. */
		const VERDICTS = new Set(["pass", "revise", "block", "unavailable"]);

		/** Review stages in canonical order, also the settings-page checkbox order. */
		const STAGE_ORDER = ["plan", "act", "checkpoint", "finish"];

		/** Tools watched by the automatic examiner out of the box. */
		const DEFAULT_TOOLS = ["write", "edit", "pwsh", "bash", "run_code", "delete_file", "move_file"];

		/** Numeric settings bounds, mirroring the Host's patch validation. */
		const NUMBER_FIELDS = [
			{ key: "cooldownMs", labelKey: "set.cooldown", min: 0, max: 600000, unit: "ms" },
			{ key: "maxPerTurn", labelKey: "set.maxPerTurn", min: 1, max: 50, unit: "×" },
			{ key: "timeoutMs", labelKey: "set.timeout", min: 2000, max: 120000, unit: "ms" },
			{ key: "maxTokens", labelKey: "set.maxTokens", min: 200, max: 4000, unit: "tok" },
		];

		/** Cost-guard numeric bounds, mirroring the Host's budget validation. */
		const BUDGET_FIELDS = [
			{ key: "maxCallsPerTurn", labelKey: "set.budgetCalls", unitKey: "set.budgetCallsUnit", min: 1, max: 1000 },
			{ key: "maxFullDebatesPerTurn", labelKey: "set.budgetFull", unitKey: "set.budgetFullUnit", min: 0, max: 200 },
			{ key: "maxTokensPerTurn", labelKey: "set.budgetTokens", unitKey: "set.budgetTokensUnit", min: 1000, max: 2000000 },
		];

		/**
		 * Form seed used when `GET /config` is unreachable: the same defaults the
		 * Host normalizes to, so the fields stay editable and savable.
		 */
		function emptySettings() {
			return {
				enabled: true,
				language: "auto",
				voices: {
					actor: { provider: "", model: "", reasoningEffort: "", candidates: [] },
					examiner: { provider: "", model: "", reasoningEffort: "", candidates: [] },
				},
				autoReview: {
					enabled: true,
					tools: [...DEFAULT_TOOLS],
					cooldownMs: 15000,
					maxPerTurn: 6,
					timeoutMs: 20000,
					maxTokens: 700,
					includeErrors: true,
					subagents: false,
					logPasses: false,
					finishGate: true,
					finishAlways: false,
					shellReadGuard: true,
				},
				tool: { defaultDepth: "quick", fullStages: ["plan", "finish"] },
				budget: { enabled: true, maxCallsPerTurn: 12, maxFullDebatesPerTurn: 3, maxTokensPerTurn: 24000 },
			};
		}

		/** Inner-dialogue view styles. Tokens only, `bcm-view-` prefixed. */
		const VIEW_CSS = `
.bcm-view-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  overflow-y: auto;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit);
  font-size: 14px;
  line-height: 22px;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.bcm-view-inner {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 960px;
  margin: 0 auto;
  padding: 20px 24px 48px;
}
.bcm-view-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.bcm-view-heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.bcm-view-title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 20px;
  font-weight: 600;
  line-height: 28px;
}
.bcm-view-desc {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
.bcm-view-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bcm-view-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  min-width: 0;
  max-width: 240px;
  height: 24px;
  padding: 0 8px;
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 4px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bcm-view-chipRole {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.bcm-view-chipAccent {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-interactive-bg-hover-accent, var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base)));
  color: var(--dsw-alias-label-primary);
}
.bcm-view-chipAccent .bcm-view-chipRole {
  color: var(--dsw-alias-brand-primary);
}
.bcm-view-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border: .5px solid var(--dsw-alias-state-warn-primary);
  border-radius: 999px;
  color: var(--dsw-alias-state-warn-primary);
  font-size: 12px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}
.bcm-view-button {
  box-sizing: border-box;
  height: 30px;
  padding: 0 12px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md, 6px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.bcm-view-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.bcm-view-button:disabled {
  opacity: .4;
  cursor: default;
}
.bcm-view-button:focus-visible,
.bcm-view-more:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.bcm-view-switch {
  position: relative;
  flex: none;
  width: 32px;
  height: 18px;
  padding: 0;
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-border-l1));
  cursor: pointer;
}
.bcm-view-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-base));
  transition: transform .14s ease;
}
.bcm-view-switch[aria-checked="true"] {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary);
}
.bcm-view-switch[aria-checked="true"]::after {
  transform: translateX(14px);
}
.bcm-view-switch:hover:not(:disabled) {
  border-color: var(--dsw-alias-brand-primary);
}
.bcm-view-switch:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.bcm-view-switch:disabled {
  opacity: .5;
  cursor: default;
}
.bcm-view-banner {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: .5px solid var(--dsw-alias-state-error-primary);
  border-radius: var(--dsw-radius-md, 6px);
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
.bcm-view-loading {
  padding: 12px 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
.bcm-view-empty {
  padding: 16px 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
.bcm-view-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.bcm-view-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg, 8px);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
}
.bcm-view-cardHead {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}
.bcm-view-time {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}
.bcm-view-stage {
  flex: none;
  padding: 0 6px;
  border-radius: var(--dsw-radius-sm, 4px);
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.bcm-view-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--dsw-alias-label-tertiary);
}
.bcm-view-dot[data-verdict="pass"] { background: var(--dsw-alias-state-success-primary); }
.bcm-view-dot[data-verdict="revise"] { background: var(--dsw-alias-state-warn-primary); }
.bcm-view-dot[data-verdict="block"] { background: var(--dsw-alias-state-error-primary); }
.bcm-view-dot[data-verdict="unavailable"] { background: var(--dsw-alias-label-tertiary); }
.bcm-view-summary {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
}
.bcm-view-more {
  flex: none;
  padding: 2px 6px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.bcm-view-more:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.bcm-view-issues {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.bcm-view-issue {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 4px);
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.bcm-view-issue[data-severity="must"] {
  border-left: 2px solid var(--dsw-alias-state-error-primary);
}
.bcm-view-issue[data-severity="should"] {
  border-left: 2px solid var(--dsw-alias-state-warn-primary);
}
.bcm-view-severity {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
}
.bcm-view-issue[data-severity="must"] .bcm-view-severity {
  color: var(--dsw-alias-state-error-primary);
}
.bcm-view-issue[data-severity="should"] .bcm-view-severity {
  color: var(--dsw-alias-state-warn-primary);
}
.bcm-view-issueBody {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  gap: 2px;
  min-width: 0;
}
.bcm-view-problem {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
  word-break: break-word;
}
.bcm-view-fix {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-word;
}
.bcm-view-pending {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-secondary, var(--dsw-alias-border-base));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.bcm-view-pendingHead {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bcm-view-pendingTitle {
  flex: 1 1 auto;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
}
.bcm-view-pendingClear {
  flex: none;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-secondary, var(--dsw-alias-border-base));
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.bcm-view-pendingClear:hover:not(:disabled) {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}
.bcm-view-pendingClear:disabled {
  cursor: default;
  opacity: 0.6;
}
.bcm-view-pendingIssue {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.bcm-view-pendingIssue[data-severity="must"] {
  border-left: 2px solid var(--dsw-alias-state-error-primary);
}
.bcm-view-pendingIssue[data-severity="should"] {
  border-left: 2px solid var(--dsw-alias-state-warn-primary);
}
.bcm-view-meta {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.bcm-view-resolve {
  flex: none;
  align-self: center;
  padding: 3px 10px;
  border: 1px solid var(--dsw-alias-border-secondary, var(--dsw-alias-border-base));
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.bcm-view-resolve:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.bcm-view-resolve:disabled {
  cursor: default;
  opacity: 0.6;
}
.bcm-view-pendingEmpty {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.bcm-view-pendingError {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
.bcm-view-transcript {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  margin-top: 2px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  overflow-y: auto;
  overscroll-behavior: contain;
}
.bcm-view-line {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bcm-view-lineLabel {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.bcm-view-lineText {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
  word-break: break-word;
}
`;

		/** Settings-page styles. Tokens only, `bcm-set-` prefixed. */
		const SETTINGS_CSS = `
.bcm-set-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit);
  font-size: 14px;
  line-height: 22px;
}
.bcm-set-headerRow {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px 20px;
  flex-wrap: wrap;
}
.bcm-set-headingBlock {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.bcm-set-enable {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding-top: 2px;
}
.bcm-set-enableText {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.bcm-set-heading {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 18px;
  font-weight: 600;
  line-height: 26px;
}
.bcm-set-intro {
  margin: 0;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bcm-set-banner {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: .5px solid var(--dsw-alias-state-error-primary);
  border-radius: var(--dsw-radius-md, 6px);
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
.bcm-set-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: .5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1));
  border-radius: var(--dsw-radius-xl, 12px);
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2));
}
.bcm-set-cardTitle {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
}
.bcm-set-cardDesc {
  margin: -2px 0 0;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bcm-set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
  padding: 3px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l2);
}
.bcm-set-row:last-child {
  padding-bottom: 0;
  border-bottom: none;
}
.bcm-set-rowText {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
}
.bcm-set-rowTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 18px;
}
.bcm-set-rowDesc {
  min-width: 0;
  max-width: 100%;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bcm-set-picker {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: end;
  gap: 6px 8px;
}
.bcm-set-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.bcm-set-label {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
}
.bcm-set-inputWrap {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
}
.bcm-set-unit {
  position: absolute;
  right: 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  pointer-events: none;
}
.bcm-set-inputWrap .bcm-set-input {
  padding-right: 34px;
}
.bcm-set-input {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l1));
  border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}
.bcm-set-select {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l1));
  border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.bcm-set-input:focus-visible,
.bcm-set-select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.bcm-set-input:disabled,
.bcm-set-select:disabled {
  opacity: .5;
  cursor: default;
}
.bcm-set-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.bcm-set-check input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}
.bcm-set-checks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 18px;
}
.bcm-set-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.bcm-set-primary {
  box-sizing: border-box;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.bcm-set-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}
.bcm-set-secondary {
  box-sizing: border-box;
  height: 36px;
  padding: 0 14px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md, 6px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
.bcm-set-secondary:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.bcm-set-small {
  box-sizing: border-box;
  height: 28px;
  padding: 0 10px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.bcm-set-small:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.bcm-set-danger {
  color: var(--dsw-alias-state-error-primary);
}
.bcm-set-danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}
.bcm-set-primary:disabled,
.bcm-set-secondary:disabled,
.bcm-set-small:disabled {
  opacity: .4;
  cursor: default;
}
.bcm-set-primary:focus-visible,
.bcm-set-secondary:focus-visible,
.bcm-set-small:focus-visible,
.bcm-set-link:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.bcm-set-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.bcm-set-link:hover {
  color: var(--dsw-alias-label-primary);
}
.bcm-set-link[aria-pressed="true"] {
  color: var(--dsw-alias-brand-primary);
}
.bcm-set-hint,
.bcm-set-loading {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.bcm-set-note {
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
  font-size: 12px;
  line-height: 18px;
}
.bcm-set-candidates {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bcm-set-candidate {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 6px;
}
.bcm-set-candidate .bcm-set-input,
.bcm-set-candidate .bcm-set-select {
  flex: none;
  width: auto;
  min-width: 0;
}
.bcm-set-candidateActions {
  display: flex;
  align-items: center;
  justify-self: end;
  min-width: 0;
  gap: 4px;
}
.bcm-set-candidate .bcm-set-probe {
  max-width: 160px;
}
@media (max-width: 560px) {
  .bcm-set-candidate {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .bcm-set-candidateActions {
    grid-column: 1 / -1;
    justify-self: start;
  }
}
.bcm-set-probe {
  display: inline-flex;
  align-items: center;
  flex: none;
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
}
.bcm-set-probeOk {
  color: var(--dsw-alias-state-success-primary);
}
.bcm-set-probeFail {
  max-width: 260px;
  color: var(--dsw-alias-state-error-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bcm-set-subTitle {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}
.bcm-set-subgrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 8px;
}
.bcm-set-inlineRow {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  margin: 0;
  gap: 6px;
}
.bcm-set-inlineRow .bcm-set-depthField {
  flex: 0 0 180px;
}
.bcm-set-inlineRow .bcm-set-checks {
  flex: 1 1 auto;
  align-self: center;
  margin: 0;
}
.bcm-set-check {
  min-height: 30px;
}
.bcm-set-picker > .bcm-set-link,
.bcm-set-picker > .bcm-set-secondary {
  justify-self: start;
  align-self: center;
}
.bcm-set-hint,
.bcm-set-note,
.bcm-set-loading {
  margin: 0;
  font-size: 11px;
  line-height: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bcm-set-checks {
  gap: 2px 10px;
}
.bcm-set-actions {
  gap: 6px;
}
.bcm-set-footerCard {
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  min-width: 0;
  gap: 8px 14px;
  padding: 10px 14px;
  border: .5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1));
  border-radius: var(--dsw-radius-xl, 12px);
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2));
}
.bcm-set-status {
  flex: 1 1 120px;
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
}
.bcm-set-statusSaved {
  color: var(--dsw-alias-state-success-primary);
}
.bcm-set-statusError {
  color: var(--dsw-alias-state-error-primary);
}
.bcm-set-statusInfo {
  color: var(--dsw-alias-label-tertiary);
}
.bcm-set-meta {
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 2px 10px;
  min-width: 0;
  max-width: 100%;
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  text-align: right;
  overflow-wrap: anywhere;
}
.bcm-set-meta > span {
  min-width: 0;
  max-width: 100%;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.bcm-set-meta > .bcm-set-path {
  flex: 1 1 100%;
  text-align: left;
}
@media (max-width: 560px) {
  .bcm-set-subgrid {
    grid-template-columns: minmax(0, 1fr);
  }
  .bcm-set-meta {
    justify-content: flex-start;
    margin-left: 0;
    text-align: left;
  }
}
.bcm-set-path {
  box-sizing: border-box;
  max-width: 100%;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 16px;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.bcm-set-switch {
  position: relative;
  flex: none;
  width: 32px;
  height: 18px;
  padding: 0;
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-border-l1));
  cursor: pointer;
}
.bcm-set-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-base));
  transition: transform .14s ease;
}
.bcm-set-switch[aria-checked="true"] {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary);
}
.bcm-set-switch[aria-checked="true"]::after {
  transform: translateX(14px);
}
.bcm-set-switch:hover:not(:disabled) {
  border-color: var(--dsw-alias-brand-primary);
}
.bcm-set-switch:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.bcm-set-switch:disabled {
  opacity: .5;
  cursor: default;
}
.bcm-set-levels {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bcm-set-level {
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 6px 10px;
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md, 6px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.bcm-set-level:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.bcm-set-level:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.bcm-set-level[aria-checked="true"] {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-interactive-bg-hover-accent, var(--dsw-alias-bg-layer-2));
}
.bcm-set-level:disabled {
  opacity: .5;
  cursor: default;
}
.bcm-set-levelText {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.bcm-set-levelTitle {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}
.bcm-set-levelDesc {
  display: -webkit-box;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 15px;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.bcm-set-levelMark {
  flex: none;
  color: var(--dsw-alias-brand-primary);
  font-size: 12px;
  line-height: 18px;
}
.bcm-set-levelCustom {
  margin: 0;
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
  font-size: 11px;
  line-height: 15px;
}
.bcm-set-levelError {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 15px;
  overflow-wrap: anywhere;
}
.bcm-set-levelBusy {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 15px;
}
.bcm-set-budgetOff {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 15px;
}
.bcm-set-budgetGrid .bcm-set-inputWrap .bcm-set-input {
  padding-right: 56px;
}
`;

		/** `HH:MM` in the viewer's local zone, tolerant of missing/forged data. */
		function formatTime(at) {
			if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return "--:--";
			const date = new Date(at);
			if (Number.isNaN(date.getTime())) return "--:--";
			const pad = (value) => (value < 10 ? "0" + value : String(value));
			return pad(date.getHours()) + ":" + pad(date.getMinutes());
		}

		/** Route strings of one voice entry, filtered to usable values. */
		function routesOf(voice) {
			if (voice === null || typeof voice !== "object" || !Array.isArray(voice.routes)) return [];
			return voice.routes.filter((route) => typeof route === "string" && route.length > 0);
		}

		/** Model part of a `provider/model` route, for a compact chip. */
		function shortRoute(route) {
			const text = typeof route === "string" ? route : "";
			const cut = text.lastIndexOf("/");
			const short = cut === -1 ? text : text.slice(cut + 1);
			return short.length === 0 ? text : short;
		}

		/** Four transcript sections of one entry, in dialogue order. */
		function transcriptSections(entry, tx) {
			const transcript = entry.transcript;
			if (transcript === null || typeof transcript !== "object") return [];
			const order = [
				["advocate", "transcript.advocate"],
				["critique", "transcript.critique"],
				["reply", "transcript.reply"],
				["final", "transcript.final"],
			];
			const sections = [];
			for (const [field, key] of order) {
				const value = transcript[field];
				if (typeof value === "string" && value.trim().length > 0) {
					sections.push([tx(key), value.trim()]);
				}
			}
			return sections;
		}

		/** Bounded string read, tolerant of missing settings fields. */
		function asText(value) {
			return typeof value === "string" ? value : "";
		}

		/** Parse one JSON response body; a non-JSON body reads as `null`. */
		async function readJsonResponse(response) {
			try {
				return await response.json();
			} catch {
				return null;
			}
		}

		/** Split the comma-separated tools field into a de-duplicated name list. */
		function parseTools(value) {
			const out = [];
			for (const part of String(value ?? "").split(/[,，\n]/)) {
				const name = part.trim();
				if (name.length === 0 || out.includes(name)) continue;
				out.push(name);
			}
			return out;
		}

		/** Order-insensitive comparison of two string arrays. */
		function sameList(left, right) {
			const first = Array.isArray(left) ? left : [];
			const second = Array.isArray(right) ? right : [];
			if (first.length !== second.length) return false;
			for (let index = 0; index < first.length; index += 1) {
				if (first[index] !== second[index]) return false;
			}
			return true;
		}

		/** Compare two `{ provider, model }` route lists. */
		function sameRoutes(left, right) {
			const first = Array.isArray(left) ? left : [];
			const second = Array.isArray(right) ? right : [];
			if (first.length !== second.length) return false;
			for (let index = 0; index < first.length; index += 1) {
				const a = first[index];
				const b = second[index];
				if (asText(a?.provider) !== asText(b?.provider)) return false;
				if (asText(a?.model) !== asText(b?.model)) return false;
			}
			return true;
		}

		/**
		 * Copy the editable form state out of one `/config` settings object.
		 *
		 * A missing or malformed payload falls back to the Host defaults, so the
		 * form stays editable even when the settings route is unreachable.
		 */
		function draftFromSettings(settings) {
			const fallback = emptySettings();
			const source = settings !== null && typeof settings === "object" ? settings : fallback;
			const voices = source.voices !== null && typeof source.voices === "object" ? source.voices : fallback.voices;
			const auto = source.autoReview !== null && typeof source.autoReview === "object" ? source.autoReview : fallback.autoReview;
			const tool = source.tool !== null && typeof source.tool === "object" ? source.tool : fallback.tool;
			const budget = source.budget !== null && typeof source.budget === "object" ? source.budget : fallback.budget;
			const role = (name) => {
				const voice = voices[name] !== null && typeof voices[name] === "object" ? voices[name] : {};
				const candidates = Array.isArray(voice.candidates)
					? voice.candidates
						.filter((candidate) => candidate !== null && typeof candidate === "object")
						.map((candidate) => ({ provider: asText(candidate.provider), model: asText(candidate.model) }))
					: [];
				return { provider: asText(voice.provider), model: asText(voice.model), candidates };
			};
			const fullStages = Array.isArray(tool.fullStages)
				? tool.fullStages.filter((stage) => STAGE_ORDER.includes(stage))
				: [...fallback.tool.fullStages];
			return {
				enabled: source.enabled === true,
				examiner: role("examiner"),
				actor: role("actor"),
				autoReview: {
					enabled: auto.enabled !== false,
					toolsText: Array.isArray(auto.tools) ? auto.tools.map((name) => String(name)).join(", ") : DEFAULT_TOOLS.join(", "),
					cooldownMs: String(Number.isSafeInteger(auto.cooldownMs) ? auto.cooldownMs : fallback.autoReview.cooldownMs),
					maxPerTurn: String(Number.isSafeInteger(auto.maxPerTurn) ? auto.maxPerTurn : fallback.autoReview.maxPerTurn),
					timeoutMs: String(Number.isSafeInteger(auto.timeoutMs) ? auto.timeoutMs : fallback.autoReview.timeoutMs),
					maxTokens: String(Number.isSafeInteger(auto.maxTokens) ? auto.maxTokens : fallback.autoReview.maxTokens),
					finishGate: auto.finishGate !== false,
					finishAlways: auto.finishAlways === true,
					includeErrors: auto.includeErrors !== false,
					subagents: auto.subagents === true,
				},
				tool: {
					defaultDepth: tool.defaultDepth === "full" ? "full" : "quick",
					fullStages,
				},
				budget: {
					enabled: budget.enabled !== false,
					maxCallsPerTurn: String(Number.isSafeInteger(budget.maxCallsPerTurn) ? budget.maxCallsPerTurn : fallback.budget.maxCallsPerTurn),
					maxFullDebatesPerTurn: String(Number.isSafeInteger(budget.maxFullDebatesPerTurn) ? budget.maxFullDebatesPerTurn : fallback.budget.maxFullDebatesPerTurn),
					maxTokensPerTurn: String(Number.isSafeInteger(budget.maxTokensPerTurn) ? budget.maxTokensPerTurn : fallback.budget.maxTokensPerTurn),
				},
			};
		}

		/** Stable identity of one review entry across polls (new entries prepend). */
		function entryKey(entry) {
			const at = typeof entry.at === "number" ? entry.at : 0;
			return `${at}:${asText(entry.stage)}:${asText(entry.verdict)}:${asText(entry.toolName)}:${asText(entry.summary).slice(0, 32)}`;
		}

		/** Localized fallback title for a cost-guard preset without Host copy. */
		function fallbackBudgetTierTitle(tier, tx) {
			const keys = {
				relaxed: "set.budgetTierRelaxed",
				standard: "set.budgetTierStandard",
				frugal: "set.budgetTierFrugal",
			};
			const key = keys[tier];
			return key === undefined ? tier : tx(key);
		}

		/**
		 * The inner-dialogue view (`conversation.view`, session scope).
		 *
		 * Renders the bounded left/right-brain review ledger of the active
		 * session: header controls, recent entries with severity-tagged issues,
		 * and each entry's four-part transcript. Polls
		 * `GET /bicameral-mind/state` every 2500 ms; the cleanup owns both the
		 * timer and the in-flight request. Without a session id nothing renders.
		 */
		function BicameralView({ sessionId, t }) {
			const [snapshot, setSnapshot] = React.useState(null);
			const [openKey, setOpenKey] = React.useState(null);
			const [failures, setFailures] = React.useState(0);
			const [toggling, setToggling] = React.useState(false);
			const [toggleError, setToggleError] = React.useState(false);
			const [issueBusy, setIssueBusy] = React.useState("");
			const [issueError, setIssueError] = React.useState("");
			const [clearArmed, setClearArmed] = React.useState(false);
			const loadRef = React.useRef(null);
			const openedOnce = React.useRef(false);

			const hasSession = typeof sessionId === "string" && sessionId.length > 0;

			/** Translate through the locale service, falling back to built-in copy. */
			const tx = React.useCallback((key, params) => {
				const builtin = Object.prototype.hasOwnProperty.call(FALLBACK, key) ? FALLBACK[key] : key;
				let template = builtin;
				if (typeof t === "function") {
					let value;
					try {
						value = t(key);
					} catch {
						value = undefined;
					}
					if (typeof value === "string" && value.length > 0 && value !== key) template = value;
				}
				if (params === undefined || params === null) return template;
				return template.replace(/\{(\w+)\}/g, (match, name) =>
					Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
				);
			}, [t]);

			// Poll the Host snapshot: once immediately, then at a fixed cadence.
			// The cleanup clears the timer and aborts the in-flight request.
			React.useEffect(() => {
				if (!hasSession) return undefined;
				let disposed = false;
				let timer = null;
				let active = null;
				const load = async () => {
					if (active !== null) active.abort();
					const controller = new AbortController();
					active = controller;
					try {
						const response = await fetch(
							`/bicameral-mind/state?sessionId=${encodeURIComponent(sessionId)}`,
							{
								method: "GET",
								cache: "no-store",
								headers: { accept: "application/json" },
								signal: controller.signal,
							},
						);
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const payload = await response.json();
						if (payload === null || typeof payload !== "object" || payload.ok !== true) {
							throw new Error("unexpected payload");
						}
						if (disposed) return;
						setSnapshot(payload);
						setFailures(0);
						if (!openedOnce.current) {
							const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
							const row = sessions.find(
								(candidate) => candidate !== null && typeof candidate === "object" && candidate.sessionId === sessionId,
							);
							const newest = row !== undefined && row !== null && Array.isArray(row.entries) ? row.entries[0] : undefined;
							if (newest !== undefined && newest !== null && typeof newest === "object") {
								openedOnce.current = true;
								setOpenKey(entryKey(newest));
							}
						}
					} catch {
						if (disposed || controller.signal.aborted) return;
						setFailures((count) => count + 1);
					} finally {
						if (active === controller) active = null;
					}
				};
				loadRef.current = load;
				load();
				timer = setInterval(load, POLL_MS);
				return () => {
					disposed = true;
					if (timer !== null) clearInterval(timer);
					if (active !== null) active.abort();
					active = null;
					loadRef.current = null;
				};
			}, [hasSession, sessionId]);

			/** Flip the master switch and adopt the Host's answer. */
			const onToggleEnabled = async () => {
				if (toggling || snapshot === null) return;
				const desired = snapshot.enabled !== true;
				setToggling(true);
				setToggleError(false);
				try {
					const response = await fetch("/bicameral-mind/toggle", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ enabled: desired }),
					});
					const payload = await readJsonResponse(response);
					if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) {
						throw new Error("toggle rejected");
					}
					const nextEnabled = payload.enabled === true;
					setSnapshot((previous) => (previous === null ? previous : { ...previous, enabled: nextEnabled }));
					setFailures(0);
				} catch {
					setToggleError(true);
				} finally {
					setToggling(false);
				}
			};

			/** Resolve one outstanding issue after the user confirms it by hand. */
			const resolveIssue = async (problem) => {
				if (!hasSession || issueBusy.length > 0) return;
				setIssueBusy(problem);
				setIssueError("");
				try {
					const response = await fetch("/bicameral-mind/issues", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, problems: [problem] }),
					});
					const payload = await readJsonResponse(response);
					if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) {
						throw new Error("resolve rejected");
					}
					if (typeof loadRef.current === "function") await loadRef.current();
				} catch {
					setIssueError(tx("issues.failed"));
				} finally {
					setIssueBusy("");
				}
			};

			/** Clear every outstanding issue; the first click only arms the button. */
			const clearIssues = async () => {
				if (!hasSession || issueBusy.length > 0) return;
				if (!clearArmed) {
					setClearArmed(true);
					return;
				}
				setIssueBusy("__all__");
				setIssueError("");
				try {
					const response = await fetch("/bicameral-mind/issues", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId, all: true }),
					});
					const payload = await readJsonResponse(response);
					if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) {
						throw new Error("clear rejected");
					}
					if (typeof loadRef.current === "function") await loadRef.current();
				} catch {
					setIssueError(tx("issues.failed"));
				} finally {
					setIssueBusy("");
					setClearArmed(false);
				}
			};

			if (!hasSession) return null;

			const data = snapshot !== null && typeof snapshot === "object" ? snapshot : null;
			const sessions = data !== null && Array.isArray(data.sessions) ? data.sessions : [];
			const row = sessions.find(
				(candidate) => candidate !== null && typeof candidate === "object" && candidate.sessionId === sessionId,
			) ?? null;
			const entries = row !== null && Array.isArray(row.entries) ? row.entries.slice(0, ENTRY_LIMIT) : [];
			const enabled = data !== null && data.enabled === true;
			const voices = data !== null && data.voices !== null && typeof data.voices === "object" ? data.voices : {};
			const actorRoutes = routesOf(voices.actor);
			const examinerRoutes = routesOf(voices.examiner);
			const actorLabel = actorRoutes.length === 0 ? tx("none") : shortRoute(actorRoutes[0]);
			const examinerLabel = examinerRoutes.length === 0 ? tx("none") : shortRoute(examinerRoutes[0]);
			const examinerDistinct = examinerRoutes.length > 0 && examinerRoutes[0] !== actorRoutes[0];
			const pinned = voices.examiner !== null && typeof voices.examiner === "object" && voices.examiner.pinned === true;
			const pending = row !== null && Number.isSafeInteger(row.pendingIssues) ? row.pendingIssues : 0;
			const pendingDetails = row !== null && Array.isArray(row.issues)
				? row.issues.filter((issue) => issue !== null && typeof issue === "object" && typeof issue.problem === "string" && issue.problem.length > 0).slice(0, 6)
				: [];
			const hasPendingDetails = row !== null && Array.isArray(row.issues);
			const pendingBlock = !hasPendingDetails
				? null
				: h(
						"section",
						{ className: "bcm-view-pending", "aria-label": tx("issues.title") },
						h(
							"div",
							{ className: "bcm-view-pendingHead" },
							h("span", { className: "bcm-view-pendingTitle" }, tx("issues.title")),
							pendingDetails.length > 0 ? h("span", { className: "bcm-view-badge" }, String(pendingDetails.length)) : null,
							pendingDetails.length > 0
								? h(
										"button",
										{
											type: "button",
											className: "bcm-view-pendingClear",
											disabled: issueBusy.length > 0,
											onClick: clearIssues,
										},
										clearArmed ? tx("issues.confirmClear") : tx("issues.clear"),
									)
								: null,
						),
						pendingDetails.length === 0
							? h("p", { className: "bcm-view-pendingEmpty" }, tx("issues.empty"))
							: h(
									"div",
									{ className: "bcm-view-issues" },
									pendingDetails.map((issue, index) => {
										const severity = issue.severity === "must" ? "must" : "should";
										const problem = issue.problem;
										const fix = typeof issue.fix === "string" ? issue.fix : "";
										const turn = Number.isSafeInteger(issue.raisedTurn) ? issue.raisedTurn : -1;
										const step = Number.isSafeInteger(issue.raisedStep) ? issue.raisedStep : -1;
										const age = turn < 0
											? ""
											: (step >= 0 ? tx("issues.age", { turn, step }) : tx("issues.ageTurn", { turn }));
										return h(
											"div",
											{
												className: "bcm-view-pendingIssue",
												"data-severity": severity,
												key: `${index}:${problem.slice(0, 48)}`,
											},
											h("span", { className: "bcm-view-severity" }, `[${severity}]`),
											h(
												"div",
												{ className: "bcm-view-issueBody" },
												h("span", { className: "bcm-view-problem" }, problem),
												fix.length > 0 ? h("span", { className: "bcm-view-fix" }, `${tx("issue.fix")}${fix}`) : null,
												age.length > 0 ? h("span", { className: "bcm-view-meta" }, age) : null,
											),
											h(
												"button",
												{
													type: "button",
													className: "bcm-view-resolve",
													disabled: issueBusy.length > 0,
													onClick: () => resolveIssue(problem),
												},
												issueBusy === problem ? "…" : tx("issues.resolve"),
											),
										);
									}),
								),
						issueError.length > 0 ? h("p", { className: "bcm-view-pendingError", role: "status" }, issueError) : null,
					);
			const routeUnavailable = failures > FAILURE_LIMIT;
			const loading = data === null && !routeUnavailable;

			const actorTitle = `${tx("voice.actor")} · ${actorRoutes.length === 0 ? tx("none") : actorRoutes.join("  →  ")}`;
			const examinerTitle = `${tx("voice.examiner")} · ${examinerRoutes.length === 0 ? tx("none") : examinerRoutes.join("  →  ")}${pinned ? ` · ${tx("pinned")}` : ""}`;
			const switchTitle = toggleError
				? tx("toggleFailed")
				: tx("switchAria", { state: enabled ? tx("on") : tx("off") });

			const actorChip = h(
				"span",
				{ className: "bcm-view-chip", title: actorTitle },
				h("span", { className: "bcm-view-chipRole", "aria-hidden": true }, tx("role.actor")),
				actorLabel,
			);
			const examinerChip = h(
				"span",
				{
					className: "bcm-view-chip" + (examinerDistinct ? " bcm-view-chipAccent" : ""),
					title: examinerTitle,
				},
				h("span", { className: "bcm-view-chipRole", "aria-hidden": true }, tx("role.examiner")),
				examinerLabel,
			);
			const pendingBadge = pending > 0
				? h(
					"span",
					{
						className: "bcm-view-badge",
						"aria-label": tx("pendingBadge", { count: pending }),
						title: tx("pendingBadge", { count: pending }),
					},
					h("span", { "aria-hidden": true }, String(pending)),
				)
				: null;

			const header = h(
				"header",
				{ className: "bcm-view-header" },
				h(
					"div",
					{ className: "bcm-view-heading" },
					h("h1", { className: "bcm-view-title" }, tx("title")),
					h("p", { className: "bcm-view-desc" }, tx("description")),
				),
				h(
					"div",
					{ className: "bcm-view-controls" },
					actorChip,
					examinerChip,
					pendingBadge,
					h(
						"button",
						{
							type: "button",
							className: "bcm-view-button",
							"aria-label": tx("refresh"),
							title: tx("refresh"),
							onClick: () => {
								if (loadRef.current !== null) loadRef.current();
							},
						},
						tx("refresh"),
					),
					h("button", {
						type: "button",
						className: "bcm-view-switch",
						role: "switch",
						"aria-checked": enabled ? "true" : "false",
						"aria-label": switchTitle,
						title: switchTitle,
						disabled: toggling || data === null,
						onClick: onToggleEnabled,
					}),
				),
			);

			/** One review card: verdict line, issues, and the collapsible dialogue. */
			const renderEntry = (entry) => {
				if (entry === null || typeof entry !== "object") return null;
				const key = entryKey(entry);
				const stageKey = STAGE_KEYS[entry.stage] ?? "stage.act";
				const verdict = typeof entry.verdict === "string" && VERDICTS.has(entry.verdict) ? entry.verdict : "unavailable";
				const rawSummary = typeof entry.summary === "string" ? entry.summary.trim() : "";
				const summary = rawSummary.length > 0 ? rawSummary : tx("noSummary");
				const issues = Array.isArray(entry.issues)
					? entry.issues.filter((issue) => issue !== null && typeof issue === "object")
					: [];
				const sections = transcriptSections(entry, tx);
				const isOpen = openKey === key;
				return h(
					"article",
					{ className: "bcm-view-card", key, "data-verdict": verdict },
					h(
						"header",
						{ className: "bcm-view-cardHead" },
						h("span", { className: "bcm-view-time" }, formatTime(entry.at)),
						h("span", { className: "bcm-view-stage" }, tx(stageKey)),
						h("span", {
							className: "bcm-view-dot",
							"data-verdict": verdict,
							role: "img",
							"aria-label": tx(`verdict.${verdict}`),
							title: tx(`verdict.${verdict}`),
						}),
						h("span", { className: "bcm-view-summary", title: summary }, summary),
						sections.length === 0
							? null
							: h(
								"button",
								{
									type: "button",
									className: "bcm-view-more",
									"aria-expanded": isOpen ? "true" : "false",
									"aria-label": tx(isOpen ? "hideTranscript" : "showTranscript"),
									onClick: () => setOpenKey(isOpen ? null : key),
								},
								tx(isOpen ? "hideTranscript" : "showTranscript"),
							),
					),
					issues.length === 0
						? null
						: h(
							"ul",
							{ className: "bcm-view-issues" },
							issues.map((issue, index) => {
								const severity = issue.severity === "must" ? "must" : "should";
								const problem = typeof issue.problem === "string" ? issue.problem.trim() : "";
								const fix = typeof issue.fix === "string" ? issue.fix.trim() : "";
								return h(
									"li",
									{ className: "bcm-view-issue", "data-severity": severity, key: `${key}:issue:${index}` },
									h("span", { className: "bcm-view-severity" }, `[${severity}]`),
									h(
										"span",
										{ className: "bcm-view-issueBody" },
										problem.length === 0 ? null : h("span", { className: "bcm-view-problem" }, problem),
										fix.length === 0 ? null : h("span", { className: "bcm-view-fix" }, `${tx("issue.fix")}${fix}`),
									),
								);
							}),
						),
					sections.length > 0 && isOpen
						? h(
							"div",
							{ className: "bcm-view-transcript", tabIndex: 0, role: "group", "aria-label": tx("transcriptLabel") },
							sections.map(([label, value]) =>
								h(
									"div",
									{ className: "bcm-view-line", key: label },
									h("span", { className: "bcm-view-lineLabel" }, label),
									h("span", { className: "bcm-view-lineText" }, value),
								),
							),
						)
						: null,
				);
			};

			const banner = routeUnavailable
				? h("div", { className: "bcm-view-banner", role: "status" }, tx("routeUnavailable"))
				: null;
			const toggleAlert = toggleError
				? h("div", { className: "bcm-view-banner", role: "status" }, tx("toggleFailed"))
				: null;
			const body = routeUnavailable && data === null
				? null
				: loading
					? h("p", { className: "bcm-view-loading", role: "status" }, tx("loading"))
					: entries.length === 0
						? h("p", { className: "bcm-view-empty" }, tx("empty"))
						: h("div", { className: "bcm-view-list" }, entries.map((entry) => renderEntry(entry)));

			return h(
				React.Fragment,
				null,
				h("style", { key: "bicameral-mind-view-styles" }, VIEW_CSS),
				h(
					"div",
					{ className: "bcm-view-root", "data-bicameral-mind-view": true },
					h("div", { className: "bcm-view-inner" }, header, banner, toggleAlert, pendingBlock, body),
				),
			);
		}

		/** Composer toolbar picker styles. Tokens only, `bcm-pick-` prefixed. */
		const PICKER_CSS = `
.bcm-pick-root {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-width: 0;
}
.bcm-pick-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 190px;
  height: 28px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.bcm-pick-trigger:hover,
.bcm-pick-trigger[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.bcm-pick-trigger:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.bcm-pick-trigger:disabled {
  opacity: .5;
  cursor: default;
}
.bcm-pick-triggerLabel {
  min-width: 0;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bcm-pick-chevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 9px;
  line-height: 12px;
  transition: transform .12s ease;
}
.bcm-pick-trigger[aria-expanded="true"] .bcm-pick-chevron {
  transform: rotate(180deg);
}
.bcm-pick-pop {
  box-sizing: border-box;
  position: absolute;
  z-index: 80;
  right: 0;
  bottom: calc(100% + 6px);
  display: flex;
  flex-direction: column;
  width: 280px;
  max-height: 320px;
  padding: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg, 8px);
  background: var(--dsw-alias-bg-overlay);
  box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, .18));
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.bcm-pick-option {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.bcm-pick-option:hover,
.bcm-pick-option:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
  outline: none;
}
.bcm-pick-option[aria-selected="true"] {
  color: var(--dsw-alias-brand-primary);
}
.bcm-pick-option:disabled {
  opacity: .5;
  cursor: default;
}
.bcm-pick-check {
  flex: none;
  width: 12px;
  color: var(--dsw-alias-brand-primary);
  font-size: 11px;
  line-height: 16px;
}
.bcm-pick-optionLabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bcm-pick-sep {
  flex: none;
  height: 1px;
  margin: 4px 2px;
  background: var(--dsw-alias-border-l1);
}
.bcm-pick-group {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.bcm-pick-groupTitle {
  padding: 4px 8px 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bcm-pick-hint {
  padding: 4px 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 15px;
}
.bcm-pick-error {
  padding: 4px 8px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 15px;
  overflow-wrap: anywhere;
}
.bcm-pick-manual {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
}
.bcm-pick-manualRow {
  display: flex;
  gap: 4px;
}
.bcm-pick-input {
  flex: 1 1 0;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--dsw-alias-border-secondary, var(--dsw-alias-border-base));
  border-radius: var(--dsw-radius-sm, 4px);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
}
.bcm-pick-apply,
.bcm-pick-manualToggle,
.bcm-pick-retry {
  flex: none;
  padding: 3px 8px;
  border: 1px solid var(--dsw-alias-border-secondary, var(--dsw-alias-border-base));
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.bcm-pick-apply:hover:not(:disabled),
.bcm-pick-manualToggle:hover:not(:disabled),
.bcm-pick-retry:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.bcm-pick-manualToggle,
.bcm-pick-retry {
  align-self: flex-start;
  margin: 0 8px;
}
.bcm-pick-apply:disabled {
  cursor: default;
  opacity: 0.6;
}
.bcm-pick-footer {
  flex: none;
  margin-top: 2px;
  padding: 6px 8px 4px;
  border-top: .5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 15px;
}
`;

		/**
		 * Composer toolbar control (`conversation.input.right`): pick the
		 * right-brain model inline.
		 *
		 * The trigger label is seeded from `GET /config` and refreshed each time
		 * the popup opens; the provider/model catalog loads lazily on first open.
		 * Choosing a row PATCHes `/config` and switches the examiner voice, while
		 * "follow" clears the pin. Escape, an outside press, or the trigger closes
		 * the popup; without a session id nothing renders.
		 */
		function BicameralModelPicker({ sessionId, t, remote }) {
			const [examiner, setExaminer] = React.useState({ override: null, routes: [] });
			const [open, setOpen] = React.useState(false);
			const [catalog, setCatalog] = React.useState(null);
			const [catalogState, setCatalogState] = React.useState("idle");
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
			const [manualOpen, setManualOpen] = React.useState(false);
			const [manualProvider, setManualProvider] = React.useState("");
			const [manualModel, setManualModel] = React.useState("");
			const rootRef = React.useRef(null);
			const aliveRef = React.useRef(true);

			const hasSession = typeof sessionId === "string" && sessionId.length > 0;

			/** Translate through the locale service, falling back to built-in copy. */
			const tx = React.useCallback((key, params) => {
				const builtin = Object.prototype.hasOwnProperty.call(FALLBACK, key) ? FALLBACK[key] : key;
				let template = builtin;
				if (typeof t === "function") {
					let value;
					try {
						value = t(key);
					} catch {
						value = undefined;
					}
					if (typeof value === "string" && value.length > 0 && value !== key) template = value;
				}
				if (params === undefined || params === null) return template;
				return template.replace(/\{(\w+)\}/g, (match, name) =>
					Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
				);
			}, [t]);

			/** Read the current session's examiner override and effective route. */
			const syncExaminer = React.useCallback(async () => {
				if (!hasSession) return;
				try {
					const response = await fetch(`/bicameral-mind/state?sessionId=${encodeURIComponent(sessionId)}`, {
						method: "GET",
						cache: "no-store",
						headers: { accept: "application/json" },
					});
					const payload = await readJsonResponse(response);
					if (!aliveRef.current) return;
					if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) return;
					const voice = payload.voices !== null && typeof payload.voices === "object"
						? payload.voices.examiner
						: undefined;
					const override = voice !== null && typeof voice === "object" && voice.override !== null && typeof voice.override === "object"
						? { provider: asText(voice.override.provider), model: asText(voice.override.model) }
						: null;
					const routes = voice !== null && typeof voice === "object" && Array.isArray(voice.routes)
						? voice.routes.filter((route) => typeof route === "string" && route.length > 0)
						: [];
					setExaminer({ override, routes });
				} catch {
					/* the label simply stays at its last value */
				}
			}, [hasSession, sessionId]);

			// Seed the trigger label on mount and stop late writes on unmount.
			React.useEffect(() => {
				aliveRef.current = true;
				syncExaminer();
				return () => {
					aliveRef.current = false;
				};
			}, [syncExaminer]);

			// Load the catalog through the same Host RPC the built-in model
			// selector uses, so the picker sees exactly the same provider/model set.
			React.useEffect(() => {
				if (!open || catalogState !== "idle") return undefined;
				let disposed = false;
				setCatalogState("loading");
				(async () => {
					try {
						const sessionApi = remote !== null && typeof remote === "object" ? remote.session : undefined;
						if (sessionApi === null || typeof sessionApi !== "object" || typeof sessionApi.modelCatalog !== "function") {
							setCatalogState("failed");
							return;
						}
						const result = await sessionApi.modelCatalog();
						if (disposed) return;
						if (result === null || typeof result !== "object" || result.ok !== true) {
							setCatalogState("failed");
							return;
						}
						const groups = result.value !== null && typeof result.value === "object" && Array.isArray(result.value.groups)
							? result.value.groups
							: [];
						const providers = groups
							.filter((group) => group !== null && typeof group === "object" && typeof group.id === "string" && group.id.length > 0)
							.map((group) => ({
								provider: group.id,
								name: typeof group.name === "string" ? group.name : group.id,
								models: Array.isArray(group.models)
									? group.models.filter((model) => model !== null && typeof model === "object" && typeof model.id === "string" && model.id.length > 0)
									: [],
							}));
						setCatalog({ providers });
						setCatalogState("ready");
					} catch {
						if (disposed) return;
						setCatalogState("failed");
					}
				})();
				return () => {
					disposed = true;
				};
			}, [open, catalogState]);

			// Escape, or a press outside the anchor, dismisses the popup.
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointer = (event) => {
					if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
				};
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					if (typeof event.stopPropagation === "function") event.stopPropagation();
					setOpen(false);
				};
				document.addEventListener("pointerdown", onPointer, true);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("pointerdown", onPointer, true);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);

			if (!hasSession) return null;

			const provider = asText(examiner.override?.provider);
			const model = asText(examiner.override?.model);
			const hasOverride = provider.length > 0 && model.length > 0;
			const routes = Array.isArray(examiner.routes) ? examiner.routes : [];
			const effectiveRoute = routes.length > 0 ? routes[0] : "";
			const defaultRoute = hasOverride ? (routes[1] ?? "") : effectiveRoute;
			const shortModel = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
			const shortDefault = defaultRoute.includes("/") ? defaultRoute.slice(defaultRoute.lastIndexOf("/") + 1) : defaultRoute;
			const triggerLabel = `${tx("voice.examiner")} · ${hasOverride && shortModel.length > 0 ? shortModel : (shortDefault.length > 0 ? `${tx("pick.default")} ${shortDefault}` : tx("pick.follow"))}`;
			const providers = catalog !== null && Array.isArray(catalog.providers) ? catalog.providers : [];

			/** PATCH the session's examiner route, then adopt the Host's answer. */
			const choose = async (nextProvider, nextModel) => {
				if (busy) return;
				const follow = nextProvider.length === 0;
				const body = follow
					? { sessionId, provider: "", model: "" }
					: { sessionId, provider: nextProvider, model: nextModel };
				setBusy(true);
				setError("");
				try {
					const response = await fetch("/bicameral-mind/session-voice", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					});
					const payload = await readJsonResponse(response);
					if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) {
						const message = payload !== null && typeof payload === "object" && typeof payload.message === "string" && payload.message.length > 0
							? payload.message
							: `HTTP ${response.status}`;
						throw new Error(message);
					}
					const nextOverride = payload.override !== null && typeof payload.override === "object"
						? { provider: asText(payload.override.provider), model: asText(payload.override.model) }
						: null;
					setExaminer({
						override: nextOverride,
						routes: Array.isArray(payload.routes) ? payload.routes.filter((route) => typeof route === "string") : [],
					});
					setManualOpen(false);
					setOpen(false);
				} catch (reason) {
					const message = reason instanceof Error && reason.message.length > 0 ? reason.message : String(reason);
					setError(message);
				} finally {
					setBusy(false);
				}
			};

			const applyManual = () => {
				const nextProvider = asText(manualProvider).trim();
				const nextModel = asText(manualModel).trim();
				if (nextProvider.length === 0 || nextModel.length === 0) {
					setError(tx("pick.manualHint"));
					return;
				}
				choose(nextProvider, nextModel);
			};

			const followOption = h(
				"button",
				{
					type: "button",
					className: "bcm-pick-option",
					role: "option",
					"aria-selected": hasOverride ? "false" : "true",
					disabled: busy,
					onClick: () => choose("", ""),
				},
				h("span", { className: "bcm-pick-check", "aria-hidden": true }, hasOverride ? "" : "\u2713"),
				h("span", { className: "bcm-pick-optionLabel" }, tx("pick.followDefault")),
			);

			const groups = providers.map((entry) => {
				if (entry === null || typeof entry !== "object") return null;
				const groupProvider = asText(entry.provider);
				if (groupProvider.length === 0) return null;
				const models = Array.isArray(entry.models)
					? entry.models.filter((candidate) => candidate !== null && typeof candidate === "object" && asText(candidate.id).length > 0)
					: [];
				if (models.length === 0) return null;
				return h(
					"div",
					{ className: "bcm-pick-group", key: `p:${groupProvider}` },
					h("div", { className: "bcm-pick-groupTitle", title: groupProvider }, asText(entry.name) || groupProvider),
					models.map((candidate) => {
						const id = asText(candidate.id);
						const selected = provider === groupProvider && model === id;
						return h(
							"button",
							{
								type: "button",
								className: "bcm-pick-option",
								role: "option",
								"aria-selected": selected ? "true" : "false",
								key: `m:${groupProvider}:${id}`,
								title: `${groupProvider}/${id}`,
								disabled: busy,
								onClick: () => choose(groupProvider, id),
							},
							h("span", { className: "bcm-pick-check", "aria-hidden": true }, selected ? "\u2713" : ""),
							h("span", { className: "bcm-pick-optionLabel" }, asText(candidate.name) || id),
						);
					}),
				);
			});

			const hasCatalogGroups = groups.some((group) => group !== null);
			const showManual = manualOpen || catalogState === "failed" || (catalogState === "ready" && !hasCatalogGroups);
			const popup = open
				? h(
					"div",
					{ className: "bcm-pick-pop", role: "listbox", "aria-label": tx("pick.trigger") },
					followOption,
					h("div", { className: "bcm-pick-sep", "aria-hidden": true }),
					catalogState === "loading" ? h("div", { className: "bcm-pick-hint", role: "status" }, tx("pick.loading")) : null,
					catalogState === "failed" ? h("div", { className: "bcm-pick-error", role: "status" }, tx("pick.failed")) : null,
					catalogState === "ready" && !hasCatalogGroups ? h("div", { className: "bcm-pick-error", role: "status" }, tx("pick.failed")) : null,
					catalogState === "ready" ? groups : null,
					catalogState === "failed"
						? h(
								"button",
								{
									type: "button",
									className: "bcm-pick-retry",
									onClick: () => {
										setCatalog(null);
										setCatalogState("idle");
									},
								},
								tx("pick.retry"),
							)
						: null,
					showManual
						? h(
								"div",
								{ className: "bcm-pick-manual" },
								h("div", { className: "bcm-pick-hint" }, tx("pick.manualHint")),
								h(
									"div",
									{ className: "bcm-pick-manualRow" },
									h("input", {
										className: "bcm-pick-input",
										placeholder: tx("pick.manualProvider"),
										value: manualProvider,
										onChange: (event) => setManualProvider(event.target.value),
									}),
									h("input", {
										className: "bcm-pick-input",
										placeholder: tx("pick.manualModel"),
										value: manualModel,
										onChange: (event) => setManualModel(event.target.value),
									}),
									h(
										"button",
										{ type: "button", className: "bcm-pick-apply", disabled: busy, onClick: applyManual },
										tx("pick.apply"),
									),
								),
							)
						: h(
								"button",
								{ type: "button", className: "bcm-pick-manualToggle", onClick: () => setManualOpen(true) },
								tx("pick.manual"),
							),
					error.length > 0 ? h("div", { className: "bcm-pick-error", role: "status" }, error) : null,
					busy ? h("div", { className: "bcm-pick-hint", role: "status" }, tx("pick.saving")) : null,
					h("div", { className: "bcm-pick-footer" }, tx("pick.more")),
				)
				: null;

			return h(
				React.Fragment,
				null,
				h("style", { key: "bicameral-mind-picker-styles" }, PICKER_CSS),
				h(
					"span",
					{ className: "bcm-pick-root", ref: rootRef },
					h(
						"button",
						{
							type: "button",
							className: "bcm-pick-trigger",
							"aria-haspopup": "listbox",
							"aria-expanded": open ? "true" : "false",
							"aria-label": triggerLabel,
							title: `${tx("pick.trigger")} · ${triggerLabel}`,
							onClick: () => {
								if (open) {
									setOpen(false);
									return;
								}
								if (catalogState === "failed") setCatalogState("idle");
								syncExaminer();
								setOpen(true);
							},
						},
						h("span", { className: "bcm-pick-triggerLabel" }, triggerLabel),
						h("span", { className: "bcm-pick-chevron", "aria-hidden": true }, "\u25be"),
					),
					popup,
				),
			);
		}

		/**
		 * The settings page (`settings.section`, root scope).
		 *
		 * Loads the editable configuration and the provider/model catalog in
		 * parallel. Saves only the fields this page exposes and that differ from
		 * the last loaded values, so Host-only settings (language, reasoning
		 * effort, logPasses, shellReadGuard, …) stay untouched. Both load requests
		 * are aborted on unmount or reload.
		 */
		function BicameralSettings({ t }) {
			const [view, setView] = React.useState(null);
			const [draft, setDraft] = React.useState(null);
			const [configState, setConfigState] = React.useState("loading");
			const [catalog, setCatalog] = React.useState(null);
			const [catalogState, setCatalogState] = React.useState("loading");
			const [manual, setManual] = React.useState({ actor: false, examiner: false });
			const [status, setStatus] = React.useState({ kind: "idle", message: "" });
			const [probeResults, setProbeResults] = React.useState({});
			const [showPath, setShowPath] = React.useState(false);
			const [reloadToken, setReloadToken] = React.useState(0);
			const [saving, setSaving] = React.useState(false);
			/** Candidate row whose provider input should receive focus after render. */
			const [focusCandidate, setFocusCandidate] = React.useState(null);
			const candidateRefs = React.useRef([]);
			const [levelBusy, setLevelBusy] = React.useState(false);
			const [levelError, setLevelError] = React.useState("");
			const [budgetBusy, setBudgetBusy] = React.useState(false);
			const [budgetError, setBudgetError] = React.useState("");

			/** Translate through the locale service, falling back to built-in copy. */
			const tx = React.useCallback((key, params) => {
				const builtin = Object.prototype.hasOwnProperty.call(FALLBACK, key) ? FALLBACK[key] : key;
				let template = builtin;
				if (typeof t === "function") {
					let value;
					try {
						value = t(key);
					} catch {
						value = undefined;
					}
					if (typeof value === "string" && value.length > 0 && value !== key) template = value;
				}
				if (params === undefined || params === null) return template;
				return template.replace(/\{(\w+)\}/g, (match, name) =>
					Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
				);
			}, [t]);

			// Load both routes in parallel; both requests abort on unmount/reload.
			React.useEffect(() => {
				let disposed = false;
				const controllers = [];
				const request = (url, options) => {
					const controller = new AbortController();
					controllers.push(controller);
					return fetch(url, { ...options, signal: controller.signal });
				};
				const loadConfig = async () => {
					setConfigState("loading");
					setStatus({ kind: "idle", message: "" });
					try {
						const response = await request("/bicameral-mind/config", {
							method: "GET",
							cache: "no-store",
							headers: { accept: "application/json" },
						});
						const payload = await readJsonResponse(response);
						if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) {
							throw new Error("config unavailable");
						}
						if (disposed) return;
						setView(payload);
						setDraft(draftFromSettings(payload.settings));
						setConfigState("ready");
						setLevelError("");
						setBudgetError("");
					} catch {
						if (disposed) return;
						setConfigState("failed");
						// Keep in-progress edits; otherwise seed the form with the
						// Host defaults so it remains editable and savable.
						setDraft((previous) => (previous === null ? draftFromSettings(emptySettings()) : previous));
					}
				};
				const loadModels = async () => {
					setCatalogState("loading");
					try {
						const response = await request("/bicameral-mind/models", {
							method: "GET",
							cache: "no-store",
							headers: { accept: "application/json" },
						});
						const payload = await readJsonResponse(response);
						if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true || !Array.isArray(payload.providers)) {
							throw new Error("catalog unavailable");
						}
						if (disposed) return;
						setCatalog({ providers: payload.providers });
						setCatalogState("ready");
					} catch {
						if (disposed) return;
						setCatalogState("failed");
						// Without a catalog, the pickers have nothing to show: fall
						// back to typing provider/model by hand.
						setManual({ actor: true, examiner: true });
					}
				};
				loadConfig();
				loadModels();
				return () => {
					disposed = true;
					for (const controller of controllers) {
						try {
							controller.abort();
						} catch {
							/* already settled */
						}
					}
				};
			}, [reloadToken]);

			// Focus a freshly added candidate row that has no default value, so the
			// fallback to hand-typing still lands the caret in the right control.
			React.useEffect(() => {
				if (focusCandidate === null) return;
				const element = candidateRefs.current[focusCandidate];
				if (element !== null && element !== undefined && typeof element.focus === "function") element.focus();
				setFocusCandidate(null);
			}, [focusCandidate]);

			if (draft === null) {
				return h(
					React.Fragment,
					null,
					h("style", { key: "bicameral-mind-settings-styles" }, SETTINGS_CSS),
					h(
						"div",
						{ className: "bcm-set-root", "data-bicameral-mind-settings": true },
						h("h2", { className: "bcm-set-heading" }, tx("set.heading")),
						h("p", { className: "bcm-set-intro" }, tx("set.intro")),
						h("p", { className: "bcm-set-loading", role: "status" }, tx("set.loading")),
					),
				);
			}

			const providers = catalog !== null && Array.isArray(catalog.providers) ? catalog.providers : [];
			const settings = view !== null && view.settings !== null && typeof view.settings === "object" ? view.settings : emptySettings();
			const routes = view !== null && view.routes !== null && typeof view.routes === "object" ? view.routes : {};
			const routeList = (value) => (Array.isArray(value) ? value.filter((route) => typeof route === "string" && route.length > 0) : []);
			const actorRoutes = routeList(routes.actor);
			const examinerRoutes = routeList(routes.examiner);
			const settingsPath = view !== null && typeof view.settingsPath === "string" ? view.settingsPath : "";
			/** Intervention-level presets served by the Host, and the active one. */
			const levels = view !== null && Array.isArray(view.levels)
				? view.levels.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.id === "string" && entry.id.length > 0)
				: [];
			const currentLevel = view !== null && typeof view.level === "string" ? view.level : "custom";
			const levelCustom = !levels.some((entry) => entry.id === currentLevel);
			/** Cost-guard presets served by the Host, and the active tier. */
			const budgetPresets = view !== null && Array.isArray(view.budgetPresets)
				? view.budgetPresets.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.id === "string" && entry.id.length > 0)
				: [];
			const budgetTier = view !== null && typeof view.budgetTier === "string" ? view.budgetTier : "custom";
			const budgetKnown = budgetPresets.some((entry) => entry.id === budgetTier);
			const budgetOff = budgetTier === "off";
			const budgetCustom = budgetTier === "custom" || (!budgetKnown && !budgetOff);
			/** Whether the catalog can offer at least one complete route. */
			const hasCatalogRoute = providers.some((entry) => entry !== null && typeof entry === "object"
				&& Array.isArray(entry.models)
				&& entry.models.some((model) => model !== null && typeof model === "object" && asText(model.id).length > 0));
			/** Candidate rows follow the main picker's hand-fill fallback when no catalog route exists. */
			const candidateManual = catalogState !== "ready" || manual.examiner === true || !hasCatalogRoute;

			/** Immutable draft update. */
			const patchDraft = (mutate) => setDraft((previous) => (previous === null ? previous : mutate(previous)));

			const setEnabled = (value) => patchDraft((previous) => ({ ...previous, enabled: value }));

			const setVoice = (role, field, value) => patchDraft((previous) => {
				const voice = previous[role];
				const next = { ...voice, [field]: value };
				if (field === "provider" && value.trim().length === 0) next.model = "";
				return { ...previous, [role]: next };
			});

			/** Keep provider/model a valid pair when the provider list changes. */
			const selectProvider = (role, providerId) => patchDraft((previous) => {
				const entry = providers.find(
					(candidate) => candidate !== null && typeof candidate === "object" && asText(candidate.provider) === providerId,
				) ?? null;
				const models = entry !== null && Array.isArray(entry.models)
					? entry.models.filter((model) => model !== null && typeof model === "object" && asText(model.id).length > 0)
					: [];
				const previousModel = asText(previous[role].model);
				let model = "";
				if (providerId.length > 0) {
					if (models.some((candidate) => asText(candidate.id) === previousModel)) model = previousModel;
					else if (models.length > 0) model = asText(models[0].id);
				}
				return { ...previous, [role]: { ...previous[role], provider: providerId, model } };
			});

			/** The pair is all-or-none: clearing the model also clears the provider. */
			const selectModel = (role, modelId) => patchDraft((previous) => ({
				...previous,
				[role]: modelId.length === 0
					? { ...previous[role], provider: "", model: "" }
					: { ...previous[role], model: modelId },
			}));

			/** Clear one voice back to "follow the session". */
			const resetVoice = (role) => patchDraft((previous) => ({
				...previous,
				[role]: role === "examiner"
					? { provider: "", model: "", candidates: [] }
					: { ...previous[role], provider: "", model: "" },
			}));

			/** Text-field edit of one candidate row (no-catalog fallback). */
			const setCandidate = (index, field, value) => patchDraft((previous) => ({
				...previous,
				examiner: {
					...previous.examiner,
					candidates: previous.examiner.candidates.map((candidate, position) => (
						position === index ? { ...candidate, [field]: value } : candidate
					)),
				},
			}));

			/** Candidate provider change: select that provider's first listed model. */
			const selectCandidateProvider = (index, providerId) => patchDraft((previous) => {
				const entry = providers.find(
					(candidate) => candidate !== null && typeof candidate === "object" && asText(candidate.provider) === providerId,
				) ?? null;
				const models = entry !== null && Array.isArray(entry.models)
					? entry.models.filter((model) => model !== null && typeof model === "object" && asText(model.id).length > 0)
					: [];
				const model = providerId.length === 0 || models.length === 0 ? "" : asText(models[0].id);
				return {
					...previous,
					examiner: {
						...previous.examiner,
						candidates: previous.examiner.candidates.map((candidate, position) => (
							position === index ? { provider: providerId, model } : candidate
						)),
					},
				};
			});

			/** Clearing a candidate model clears its provider too (the pair is all-or-none). */
			const selectCandidateModel = (index, modelId) => patchDraft((previous) => ({
				...previous,
				examiner: {
					...previous.examiner,
					candidates: previous.examiner.candidates.map((candidate, position) => {
						if (position !== index) return candidate;
						return modelId.length === 0
							? { provider: "", model: "" }
							: { ...candidate, model: modelId };
					}),
				},
			}));

			/** Add a fallback row defaulting to the first catalog route nobody uses. */
			const addCandidate = () => {
				const used = new Set();
				const mainProvider = asText(draft.examiner.provider).trim();
				const mainModel = asText(draft.examiner.model).trim();
				if (mainProvider.length > 0 && mainModel.length > 0) used.add(`${mainProvider}\u0000${mainModel}`);
				for (const candidate of draft.examiner.candidates) {
					const provider = asText(candidate.provider).trim();
					const model = asText(candidate.model).trim();
					if (provider.length > 0 && model.length > 0) used.add(`${provider}\u0000${model}`);
				}
				const combos = [];
				if (catalogState === "ready") {
					for (const entry of providers) {
						if (entry === null || typeof entry !== "object") continue;
						const provider = asText(entry.provider);
						if (provider.length === 0) continue;
						const models = Array.isArray(entry.models) ? entry.models : [];
						for (const model of models) {
							const modelId = asText(model?.id);
							if (modelId.length > 0) combos.push({ provider, model: modelId });
						}
					}
				}
				const free = combos.find((combo) => !used.has(`${combo.provider}\u0000${combo.model}`));
				const choice = free ?? combos[0] ?? { provider: "", model: "" };
				const index = draft.examiner.candidates.length;
				patchDraft((previous) => ({
					...previous,
					examiner: {
						...previous.examiner,
						candidates: [...previous.examiner.candidates, { provider: choice.provider, model: choice.model }],
					},
				}));
				// No catalog route can seed the row: it starts empty, in the hand-fill
				// fallback, and the provider input takes focus.
				if (choice.provider.length === 0) setFocusCandidate(index);
			};

			const removeCandidate = (index) => {
				patchDraft((previous) => ({
					...previous,
					examiner: {
						...previous.examiner,
						candidates: previous.examiner.candidates.filter((candidate, position) => position !== index),
					},
				}));
				// Probe results are keyed by row index; drop the stale ones.
				setProbeResults((previous) => {
					const next = {};
					for (const [key, value] of Object.entries(previous)) {
						if (!key.startsWith("candidate-")) next[key] = value;
					}
					return next;
				});
			};

			const setAuto = (key, value) => patchDraft((previous) => ({
				...previous,
				autoReview: { ...previous.autoReview, [key]: value },
			}));

			const setDepth = (value) => patchDraft((previous) => ({
				...previous,
				tool: { ...previous.tool, defaultDepth: value },
			}));

			const toggleStage = (stage) => patchDraft((previous) => ({
				...previous,
				tool: {
					...previous.tool,
					fullStages: previous.tool.fullStages.includes(stage)
						? previous.tool.fullStages.filter((value) => value !== stage)
						: [...previous.tool.fullStages, stage],
				},
			}));

			const setManualMode = (role, value) => setManual((previous) => ({ ...previous, [role]: value }));

			const probeBusy = (key) => {
				const result = probeResults[key];
				return result !== undefined && result.busy === true;
			};

			/** Probe one explicit route; both success and failure stay HTTP 200. */
			const probeRoute = async (key, provider, model) => {
				const providerText = asText(provider).trim();
				const modelText = asText(model).trim();
				if (providerText.length === 0 || modelText.length === 0) {
					setProbeResults((previous) => ({
						...previous,
						[key]: { busy: false, ok: false, elapsedMs: 0, error: tx("set.probeMissing") },
					}));
					return;
				}
				setProbeResults((previous) => ({
					...previous,
					[key]: { busy: true, ok: false, elapsedMs: 0, error: "" },
				}));
				try {
					const response = await fetch("/bicameral-mind/probe", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ provider: providerText, model: modelText }),
					});
					const payload = await readJsonResponse(response);
					const ok = response.ok && payload !== null && typeof payload === "object" && payload.ok === true;
					const elapsedMs = payload !== null && typeof payload === "object" && typeof payload.elapsedMs === "number"
						? Math.max(0, payload.elapsedMs)
						: 0;
					const hostError = payload !== null && typeof payload === "object" && typeof payload.error === "string" && payload.error.length > 0
						? payload.error
						: "";
					setProbeResults((previous) => ({
						...previous,
						[key]: { busy: false, ok, elapsedMs, error: ok ? "" : hostError },
					}));
				} catch (reason) {
					const message = reason instanceof Error && reason.message.length > 0 ? reason.message : String(reason);
					setProbeResults((previous) => ({
						...previous,
						[key]: { busy: false, ok: false, elapsedMs: 0, error: message },
					}));
				}
			};

			/** Diff the draft against the loaded settings; return a partial patch. */
			const buildPatch = () => {
				const baseline = settings;
				const patch = {};
				const errors = [];
				if (draft.enabled !== (baseline.enabled === true)) patch.enabled = draft.enabled;

				const buildVoice = (role, withCandidates) => {
					const before = baseline.voices !== null && typeof baseline.voices === "object"
						&& baseline.voices[role] !== null && typeof baseline.voices[role] === "object"
						? baseline.voices[role]
						: {};
					const after = draft[role];
					const provider = asText(after.provider).trim();
					const model = asText(after.model).trim();
					const beforeCandidates = Array.isArray(before.candidates) ? before.candidates : [];
					const candidatesChanged = withCandidates && !sameRoutes(after.candidates, beforeCandidates);
					const changed = provider !== asText(before.provider) || model !== asText(before.model) || candidatesChanged;
					if (!changed) return undefined;
					if ((provider.length === 0) !== (model.length === 0)) {
						errors.push(tx("set.pairError", { role: tx(role === "examiner" ? "voice.examiner" : "voice.actor") }));
						return undefined;
					}
					const value = { provider, model };
					if (withCandidates && candidatesChanged) {
						const rows = [];
						after.candidates.forEach((candidate, index) => {
							const rowProvider = asText(candidate.provider).trim();
							const rowModel = asText(candidate.model).trim();
							// A candidate must be a complete route: an empty or half-filled
							// row blocks the save instead of being dropped silently.
							if (rowProvider.length === 0 || rowModel.length === 0) {
								errors.push(tx("set.candidatePairError", { index: index + 1 }));
								return;
							}
							rows.push({ provider: rowProvider, model: rowModel });
						});
						value.candidates = rows;
					}
					return value;
				};

				const examiner = buildVoice("examiner", true);
				const actor = buildVoice("actor", false);
				if (examiner !== undefined || actor !== undefined) {
					patch.voices = {};
					if (examiner !== undefined) patch.voices.examiner = examiner;
					if (actor !== undefined) patch.voices.actor = actor;
				}

				const fallback = emptySettings();
				const beforeAuto = baseline.autoReview !== null && typeof baseline.autoReview === "object" ? baseline.autoReview : fallback.autoReview;
				const auto = draft.autoReview;
				const autoPatch = {};
				if (auto.enabled !== (beforeAuto.enabled !== false)) autoPatch.enabled = auto.enabled;
				if (auto.finishGate !== (beforeAuto.finishGate !== false)) autoPatch.finishGate = auto.finishGate;
				if (auto.finishAlways !== (beforeAuto.finishAlways === true)) autoPatch.finishAlways = auto.finishAlways;
				if (auto.includeErrors !== (beforeAuto.includeErrors !== false)) autoPatch.includeErrors = auto.includeErrors;
				if (auto.subagents !== (beforeAuto.subagents === true)) autoPatch.subagents = auto.subagents;
				const tools = parseTools(auto.toolsText);
				const beforeTools = Array.isArray(beforeAuto.tools) ? beforeAuto.tools.map((name) => String(name)) : fallback.autoReview.tools;
				if (!sameList(tools, beforeTools)) autoPatch.tools = tools;
				for (const spec of NUMBER_FIELDS) {
					const raw = String(auto[spec.key] ?? "").trim();
					const number = Number(raw);
					if (raw.length === 0 || !Number.isFinite(number)) {
						errors.push(tx("set.numberError", { field: tx(spec.labelKey) }));
						continue;
					}
					if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
						errors.push(tx("set.rangeError", { field: tx(spec.labelKey), min: spec.min, max: spec.max }));
						continue;
					}
					if (number !== beforeAuto[spec.key]) autoPatch[spec.key] = number;
				}
				if (Object.keys(autoPatch).length > 0) patch.autoReview = autoPatch;

				const fallbackBudget = fallback.budget;
				const beforeBudget = baseline.budget !== null && typeof baseline.budget === "object" ? baseline.budget : fallbackBudget;
				const budgetDraft = draft.budget !== null && typeof draft.budget === "object" ? draft.budget : null;
				if (budgetDraft !== null) {
					const budgetPatch = {};
					if (budgetDraft.enabled !== (beforeBudget.enabled !== false)) budgetPatch.enabled = budgetDraft.enabled;
					for (const spec of BUDGET_FIELDS) {
						const raw = String(budgetDraft[spec.key] ?? "").trim();
						const number = Number(raw);
						if (raw.length === 0 || !Number.isFinite(number)) {
							errors.push(tx("set.numberError", { field: tx(spec.labelKey) }));
							continue;
						}
						if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
							errors.push(tx("set.rangeError", { field: tx(spec.labelKey), min: spec.min, max: spec.max }));
							continue;
						}
						if (number !== beforeBudget[spec.key]) budgetPatch[spec.key] = number;
					}
					if (Object.keys(budgetPatch).length > 0) patch.budget = budgetPatch;
				}

				const beforeTool = baseline.tool !== null && typeof baseline.tool === "object" ? baseline.tool : fallback.tool;
				const toolPatch = {};
				const awaitedDepth = beforeTool.defaultDepth === "full" ? "full" : "quick";
				if (draft.tool.defaultDepth !== awaitedDepth) toolPatch.defaultDepth = draft.tool.defaultDepth;
				const stages = STAGE_ORDER.filter((stage) => draft.tool.fullStages.includes(stage));
				const beforeStages = Array.isArray(beforeTool.fullStages) ? beforeTool.fullStages.filter((stage) => STAGE_ORDER.includes(stage)) : [];
				if (!sameList(stages, beforeStages)) toolPatch.fullStages = stages;
				if (Object.keys(toolPatch).length > 0) patch.tool = toolPatch;

				if (errors.length > 0) return { ok: false, message: errors.join("；") };
				return { ok: true, patch };
			};

			/** POST the diff; the Host validates and answers with the new view. */
			const onSave = async () => {
				if (saving || draft === null) return;
				const outcome = buildPatch();
				if (!outcome.ok) {
					setStatus({ kind: "error", message: outcome.message });
					return;
				}
				if (Object.keys(outcome.patch).length === 0) {
					setStatus({ kind: "info", message: tx("set.noChanges") });
					return;
				}
				setSaving(true);
				setStatus({ kind: "saving", message: "" });
				try {
					const response = await fetch("/bicameral-mind/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ patch: outcome.patch }),
					});
					const payload = await readJsonResponse(response);
					if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) {
						const message = payload !== null && typeof payload === "object" && typeof payload.message === "string" && payload.message.length > 0
							? payload.message
							: `HTTP ${response.status}`;
						throw new Error(message);
					}
					setView(payload);
					setDraft(draftFromSettings(payload.settings));
					setConfigState("ready");
					setStatus({ kind: "saved", message: tx("set.saved") });
				} catch (reason) {
					const message = reason instanceof Error && reason.message.length > 0 ? reason.message : String(reason);
					setStatus({ kind: "error", message });
				} finally {
					setSaving(false);
				}
			};

			/**
			 * Apply one intervention-level preset. The Host replaces the whole
			 * parameter set, so the response becomes the new config AND the
			 * unsaved local draft is discarded.
			 */
			const applyLevel = async (levelId) => {
				if (levelBusy || saving || draft === null) return;
				setLevelBusy(true);
				setLevelError("");
				try {
					const response = await fetch("/bicameral-mind/level", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ level: levelId }),
					});
					const payload = await readJsonResponse(response);
					if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) {
						const message = payload !== null && typeof payload === "object" && typeof payload.message === "string" && payload.message.length > 0
							? payload.message
							: `HTTP ${response.status}`;
						throw new Error(message);
					}
					const applied = typeof payload.level === "string" ? payload.level : levelId;
					const preset = Array.isArray(payload.levels)
						? payload.levels.find((entry) => entry !== null && typeof entry === "object" && entry.id === applied)
						: undefined;
					const title = preset !== undefined && typeof preset.title === "string" && preset.title.length > 0 ? preset.title : applied;
					setView(payload);
					setDraft(draftFromSettings(payload.settings));
					setConfigState("ready");
					setBudgetError("");
					setStatus({ kind: "saved", message: tx("set.levelSwitched", { title }) });
				} catch (reason) {
					const message = reason instanceof Error && reason.message.length > 0 ? reason.message : String(reason);
					setLevelError(message);
				} finally {
					setLevelBusy(false);
				}
			};

			/**
			 * Apply one cost-guard preset. Like the intervention level, the Host
			 * answers with the whole config view and any unsaved draft is dropped.
			 */
			const applyBudget = async (tier) => {
				if (budgetBusy || saving || draft === null) return;
				setBudgetBusy(true);
				setBudgetError("");
				try {
					const response = await fetch("/bicameral-mind/budget", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ tier }),
					});
					const payload = await readJsonResponse(response);
					if (!response.ok || payload === null || typeof payload !== "object" || payload.ok !== true) {
						const message = payload !== null && typeof payload === "object" && typeof payload.message === "string" && payload.message.length > 0
							? payload.message
							: `HTTP ${response.status}`;
						throw new Error(message);
					}
					const applied = typeof payload.budgetTier === "string" ? payload.budgetTier : tier;
					const preset = Array.isArray(payload.budgetPresets)
						? payload.budgetPresets.find((entry) => entry !== null && typeof entry === "object" && entry.id === applied)
						: undefined;
					const title = preset !== undefined && typeof preset.title === "string" && preset.title.length > 0
						? preset.title
						: fallbackBudgetTierTitle(applied, tx);
					setView(payload);
					setDraft(draftFromSettings(payload.settings));
					setConfigState("ready");
					setLevelError("");
					setStatus({ kind: "saved", message: tx("set.budgetSwitched", { title }) });
				} catch (reason) {
					const message = reason instanceof Error && reason.message.length > 0 ? reason.message : String(reason);
					setBudgetError(message);
				} finally {
					setBudgetBusy(false);
				}
			};

			const setBudget = (key, value) => patchDraft((previous) => ({
				...previous,
				budget: { ...previous.budget, [key]: value },
			}));

			const renderSwitch = (checked, onChange, labelText, disabled) => h("button", {
				type: "button",
				className: "bcm-set-switch",
				role: "switch",
				"aria-checked": checked ? "true" : "false",
				"aria-label": labelText,
				title: labelText,
				disabled: disabled === true,
				onClick: () => onChange(!checked),
			});

			const renderSwitchRow = (title, description, checked, onChange) => h(
				"div",
				{ className: "bcm-set-row", title: description === null ? undefined : description },
				h(
					"div",
					{ className: "bcm-set-rowText" },
					h("span", { className: "bcm-set-rowTitle" }, title),
					description === null ? null : h("span", { className: "bcm-set-rowDesc" }, description),
				),
				renderSwitch(checked, onChange, title, saving),
			);

			/** Provider choices; a value outside the catalog stays selectable. */
			const providerOptions = (current, currentLabelKey = "set.currentOption") => {
				const options = providers
					.filter((entry) => entry !== null && typeof entry === "object" && asText(entry.provider).length > 0)
					.map((entry) => ({ value: asText(entry.provider), label: asText(entry.name) || asText(entry.provider) }));
				if (current.length > 0 && !options.some((option) => option.value === current)) {
					options.unshift({ value: current, label: tx(currentLabelKey, { value: current }) });
				}
				return options;
			};

			/** Model choices for one provider; a value outside the catalog stays selectable. */
			const modelOptions = (providerId, current, currentLabelKey = "set.currentOption") => {
				const entry = providers.find(
					(candidate) => candidate !== null && typeof candidate === "object" && asText(candidate.provider) === providerId,
				) ?? null;
				const models = entry !== null && Array.isArray(entry.models) ? entry.models : [];
				const options = models
					.filter((model) => model !== null && typeof model === "object" && asText(model.id).length > 0)
					.map((model) => ({ value: asText(model.id), label: asText(model.name) || asText(model.id) }));
				if (current.length > 0 && !options.some((option) => option.value === current)) {
					options.unshift({ value: current, label: tx(currentLabelKey, { value: current }) });
				}
				return options;
			};

			const roleName = (role) => tx(role === "examiner" ? "voice.examiner" : "voice.actor");

			/** Provider + model pair; selects from the catalog or two text inputs. */
			const renderPicker = (role) => {
				const voice = draft[role];
				const isManual = manual[role] === true;
				const provider = asText(voice.provider);
				const model = asText(voice.model);
				const providerLabel = `${tx("set.provider")} · ${roleName(role)}`;
				const modelLabel = `${tx("set.model")} · ${roleName(role)}`;
				const providerControl = isManual
					? h("input", {
						type: "text",
						className: "bcm-set-input",
						value: provider,
						placeholder: "provider",
						"aria-label": providerLabel,
						spellCheck: false,
						autoComplete: "off",
						onChange: (event) => setVoice(role, "provider", event.target.value),
					})
					: h(
						"select",
						{
							className: "bcm-set-select",
							value: provider,
							"aria-label": providerLabel,
							disabled: catalogState !== "ready" || saving,
							onChange: (event) => {
								const providerId = event.target.value;
								const entry = providers.find(
									(candidate) => candidate !== null && typeof candidate === "object" && asText(candidate.provider) === providerId,
								) ?? null;
								const modelCount = entry !== null && Array.isArray(entry.models) ? entry.models.length : 0;
								selectProvider(role, providerId);
								// A provider without a listed model cannot produce a valid
								// pair from the pickers: let the user type the model.
								if (providerId.length > 0 && modelCount === 0) setManualMode(role, true);
							},
						},
						h("option", { value: "" }, tx("set.follow")),
						providerOptions(provider).map((option) => h("option", { key: option.value, value: option.value }, option.label)),
					);
				const modelControl = isManual
					? h("input", {
						type: "text",
						className: "bcm-set-input",
						value: model,
						placeholder: "model",
						"aria-label": modelLabel,
						spellCheck: false,
						autoComplete: "off",
						onChange: (event) => setVoice(role, "model", event.target.value),
					})
					: h(
						"select",
						{
							className: "bcm-set-select",
							value: model,
							"aria-label": modelLabel,
							disabled: catalogState !== "ready" || saving || provider.length === 0,
							onChange: (event) => selectModel(role, event.target.value),
						},
						h("option", { value: "" }, tx("set.unset")),
						modelOptions(provider, model).map((option) => h("option", { key: option.value, value: option.value }, option.label)),
					);
				return [
					h(
						"label",
						{ className: "bcm-set-field", key: "provider" },
						h("span", { className: "bcm-set-label" }, tx("set.provider")),
						providerControl,
					),
					h(
						"label",
						{ className: "bcm-set-field", key: "model" },
						h("span", { className: "bcm-set-label" }, tx("set.model")),
						modelControl,
					),
					h(
						"button",
						{
							type: "button",
							className: "bcm-set-link",
							key: "manual",
							"aria-pressed": isManual ? "true" : "false",
							disabled: saving,
							onClick: () => setManualMode(role, !isManual),
						},
						isManual ? tx("set.pick") : tx("set.manual"),
					),
				];
			};

			/**
			 * One fallback-chain row: catalog selects (same data source as the main
			 * picker) or two text inputs when no catalog route is available.
			 */
			const renderCandidateRow = (candidate, index) => {
				const probeKey = `candidate-${index}`;
				const provider = asText(candidate.provider);
				const model = asText(candidate.model);
				const providerLabel = `${tx("set.provider")} · ${tx("set.candidates")} ${index + 1}`;
				const modelLabel = `${tx("set.model")} · ${tx("set.candidates")} ${index + 1}`;
				const providerControl = candidateManual
					? h("input", {
						type: "text",
						className: "bcm-set-input",
						value: provider,
						placeholder: "provider",
						"aria-label": providerLabel,
						spellCheck: false,
						autoComplete: "off",
						ref: (element) => {
							candidateRefs.current[index] = element;
						},
						onChange: (event) => setCandidate(index, "provider", event.target.value),
					})
					: h(
						"select",
						{
							className: "bcm-set-select",
							value: provider,
							"aria-label": providerLabel,
							disabled: saving,
							onChange: (event) => {
								const providerId = event.target.value;
								selectCandidateProvider(index, providerId);
								if (providerId.length > 0) {
									const entry = providers.find(
										(candidateEntry) => candidateEntry !== null && typeof candidateEntry === "object" && asText(candidateEntry.provider) === providerId,
									) ?? null;
									const modelCount = entry !== null && Array.isArray(entry.models) ? entry.models.length : 0;
									// A provider without a listed model cannot complete the pair
									// from the pickers; hand-fill covers the whole examiner block.
									if (modelCount === 0) setManualMode("examiner", true);
								}
							},
						},
						h("option", { value: "" }, tx("set.unset")),
						providerOptions(provider, "set.currentNotInCatalog").map((option) => h("option", { key: option.value, value: option.value }, option.label)),
					);
				const modelControl = candidateManual
					? h("input", {
						type: "text",
						className: "bcm-set-input",
						value: model,
						placeholder: "model",
						"aria-label": modelLabel,
						spellCheck: false,
						autoComplete: "off",
						onChange: (event) => setCandidate(index, "model", event.target.value),
					})
					: h(
						"select",
						{
							className: "bcm-set-select",
							value: model,
							"aria-label": modelLabel,
							disabled: saving || provider.length === 0,
							onChange: (event) => selectCandidateModel(index, event.target.value),
						},
						h("option", { value: "" }, tx("set.unset")),
						modelOptions(provider, model, "set.currentNotInCatalog").map((option) => h("option", { key: option.value, value: option.value }, option.label)),
					);
				return h(
					"div",
					{ className: "bcm-set-candidate", key: probeKey },
					providerControl,
					modelControl,
					h(
						"div",
						{ className: "bcm-set-candidateActions" },
						h(
							"button",
							{
								type: "button",
								className: "bcm-set-small",
								disabled: saving || probeBusy(probeKey),
								onClick: () => probeRoute(probeKey, candidate.provider, candidate.model),
							},
							tx("set.probe"),
						),
						h(
							"button",
							{
								type: "button",
								className: "bcm-set-small bcm-set-danger",
								"aria-label": tx("set.removeCandidate"),
								title: tx("set.removeCandidate"),
								disabled: saving,
								onClick: () => removeCandidate(index),
							},
							"\u00d7",
						),
						renderProbeResult(probeKey),
					),
				);
			};

			const renderProbeResult = (key) => {
				const result = probeResults[key];
				if (result === undefined) return null;
				if (result.busy === true) {
					return h("span", { className: "bcm-set-probe bcm-set-hint", role: "status" }, tx("set.probing"));
				}
				if (result.ok === true) {
					return h("span", { className: "bcm-set-probe bcm-set-probeOk", role: "status" }, `\u2714 ${(result.elapsedMs / 1000).toFixed(1)}s`);
				}
				return h(
					"span",
					{ className: "bcm-set-probe bcm-set-probeFail", role: "status", title: result.error },
					`\u2718 ${result.error}`,
				);
			};

			const banner = configState === "failed"
				? h("div", { className: "bcm-set-banner", role: "alert" }, tx("set.routeUnavailable"))
				: null;

			const headerRow = h(
				"div",
				{ className: "bcm-set-headerRow" },
				h(
					"div",
					{ className: "bcm-set-headingBlock" },
					h("h2", { className: "bcm-set-heading" }, tx("set.heading")),
					h("p", { className: "bcm-set-intro", title: tx("set.intro") }, tx("set.intro")),
				),
				h(
					"div",
					{ className: "bcm-set-enable" },
					h("span", { className: "bcm-set-enableText" }, tx("set.enabled")),
					renderSwitch(draft.enabled, setEnabled, tx("set.enabled"), saving),
				),
			);

			const levelCard = levels.length === 0
				? null
				: h(
					"section",
					{ className: "bcm-set-card" },
					h("h3", { className: "bcm-set-cardTitle" }, tx("set.levelTitle")),
					h("p", { className: "bcm-set-cardDesc", title: tx("set.levelHint") }, tx("set.levelHint")),
					levelCustom ? h("p", { className: "bcm-set-levelCustom" }, tx("set.levelCustom")) : null,
					h(
						"div",
						{ className: "bcm-set-levels", role: "radiogroup", "aria-label": tx("set.levelTitle") },
						levels.map((entry) => {
							const id = entry.id;
							const active = !levelCustom && currentLevel === id;
							const titleKey = "set.level." + id + ".title";
							const descKey = "set.level." + id + ".desc";
							const hasTitle = Object.prototype.hasOwnProperty.call(FALLBACK, titleKey);
							const hasDesc = Object.prototype.hasOwnProperty.call(FALLBACK, descKey);
							const description = hasDesc
								? tx(descKey)
								: (typeof entry.description === "string" ? entry.description : "");
							const title = hasTitle ? tx(titleKey) : (typeof entry.title === "string" && entry.title.length > 0 ? entry.title : id);
							return h(
								"button",
								{
									type: "button",
									className: "bcm-set-level",
									key: id,
									role: "radio",
									"aria-checked": active ? "true" : "false",
									"data-level": id,
									title: description,
									disabled: levelBusy || saving,
									onClick: () => applyLevel(id),
								},
								h(
									"span",
									{ className: "bcm-set-levelText" },
									h("span", { className: "bcm-set-levelTitle" }, title),
									description.length === 0 ? null : h("span", { className: "bcm-set-levelDesc" }, description),
								),
								h("span", { className: "bcm-set-levelMark", "aria-hidden": true }, active ? "\u2713" : ""),
							);
						}),
					),
					levelError.length > 0 ? h("p", { className: "bcm-set-levelError", role: "status" }, levelError) : null,
					levelBusy ? h("p", { className: "bcm-set-levelBusy", role: "status" }, tx("set.levelApplying")) : null,
				);

			const examinerProbeKey = "examiner";
			const examinerCard = h(
				"section",
				{ className: "bcm-set-card" },
				h("h3", { className: "bcm-set-cardTitle" }, tx("set.examiner")),
				h("p", { className: "bcm-set-cardDesc", title: tx("set.examinerHint") }, tx("set.examinerHint")),
				h(
					"div",
					{ className: "bcm-set-picker" },
					renderPicker("examiner"),
					h(
						"button",
						{
							type: "button",
							className: "bcm-set-secondary",
							disabled: saving || probeBusy(examinerProbeKey),
							onClick: () => probeRoute(examinerProbeKey, draft.examiner.provider, draft.examiner.model),
						},
						tx("set.probe"),
					),
				),
				renderProbeResult(examinerProbeKey),
				catalogState === "loading" ? h("p", { className: "bcm-set-hint", role: "status" }, tx("set.modelsLoading")) : null,
				catalogState === "failed" ? h("p", { className: "bcm-set-note" }, tx("set.modelsFailed")) : null,
				h("h4", { className: "bcm-set-subTitle" }, tx("set.candidates")),
				h("p", { className: "bcm-set-hint" }, tx("set.candidatesHint")),
				draft.examiner.candidates.length === 0
					? null
					: h(
						"div",
						{ className: "bcm-set-candidates" },
						draft.examiner.candidates.map((candidate, index) => renderCandidateRow(candidate, index)),
					),
				h(
					"div",
					{ className: "bcm-set-actions" },
					h("button", { type: "button", className: "bcm-set-small", disabled: saving, onClick: addCandidate }, tx("set.addCandidate")),
					h("button", { type: "button", className: "bcm-set-small", disabled: saving, onClick: () => resetVoice("examiner") }, tx("set.resetExaminer")),
				),
			);

			const actorCard = h(
				"section",
				{ className: "bcm-set-card" },
				h("h3", { className: "bcm-set-cardTitle" }, tx("set.actor")),
				h("p", { className: "bcm-set-cardDesc", title: tx("set.actorHint") }, tx("set.actorHint")),
				h("div", { className: "bcm-set-picker" }, renderPicker("actor")),
				catalogState === "loading" ? h("p", { className: "bcm-set-hint", role: "status" }, tx("set.modelsLoading")) : null,
				catalogState === "failed" ? h("p", { className: "bcm-set-note" }, tx("set.modelsFailed")) : null,
				h(
					"div",
					{ className: "bcm-set-actions" },
					h("button", { type: "button", className: "bcm-set-small", disabled: saving, onClick: () => resetVoice("actor") }, tx("set.resetActor")),
				),
			);

			const autoCard = h(
				"section",
				{ className: "bcm-set-card" },
				h("h3", { className: "bcm-set-cardTitle" }, tx("set.auto")),
				h("p", { className: "bcm-set-cardDesc", title: tx("set.autoHint") }, tx("set.autoHint")),
				renderSwitchRow(tx("set.autoEnabled"), null, draft.autoReview.enabled, (value) => setAuto("enabled", value)),
				h(
					"label",
					{ className: "bcm-set-field" },
					h("span", { className: "bcm-set-label" }, tx("set.tools")),
					h("input", {
						type: "text",
						className: "bcm-set-input",
						value: draft.autoReview.toolsText,
						"aria-label": tx("set.tools"),
						spellCheck: false,
						autoComplete: "off",
						onChange: (event) => setAuto("toolsText", event.target.value),
					}),
				),
				h("p", { className: "bcm-set-hint" }, tx("set.toolsHint")),
				h(
					"div",
					{ className: "bcm-set-subgrid" },
					NUMBER_FIELDS.map((spec) => h(
						"label",
						{ className: "bcm-set-field", key: spec.key, title: tx(spec.labelKey) },
						h("span", { className: "bcm-set-label" }, tx(spec.labelKey)),
						h(
							"span",
							{ className: "bcm-set-inputWrap" },
							h("input", {
								type: "number",
								className: "bcm-set-input",
								min: spec.min,
								max: spec.max,
								step: 1,
								value: draft.autoReview[spec.key],
								"aria-label": tx(spec.labelKey),
								onChange: (event) => setAuto(spec.key, event.target.value),
							}),
							h("span", { className: "bcm-set-unit", "aria-hidden": true }, spec.unit),
						),
					)),
				),
				renderSwitchRow(tx("set.finishGate"), tx("set.finishGateHint"), draft.autoReview.finishGate, (value) => setAuto("finishGate", value)),
				renderSwitchRow(tx("set.finishAlways"), tx("set.finishAlwaysHint"), draft.autoReview.finishAlways, (value) => setAuto("finishAlways", value)),
				renderSwitchRow(tx("set.includeErrors"), tx("set.includeErrorsHint"), draft.autoReview.includeErrors, (value) => setAuto("includeErrors", value)),
				renderSwitchRow(tx("set.subagents"), tx("set.subagentsHint"), draft.autoReview.subagents, (value) => setAuto("subagents", value)),
			);

			const budgetCard = budgetPresets.length === 0
				? null
				: h(
					"section",
					{ className: "bcm-set-card" },
					h("h3", { className: "bcm-set-cardTitle" }, tx("set.budgetTitle")),
					h("p", { className: "bcm-set-cardDesc", title: tx("set.budgetHint") }, tx("set.budgetHint")),
					h(
						"div",
						{ className: "bcm-set-levels", role: "radiogroup", "aria-label": tx("set.budgetTitle") },
						budgetPresets.map((entry) => {
							const id = entry.id;
							const active = !budgetOff && !budgetCustom && budgetTier === id;
							const titleKey = "set.budget." + id + ".title";
							const descKey = "set.budget." + id + ".desc";
							const hasTitle = Object.prototype.hasOwnProperty.call(FALLBACK, titleKey);
							const hasDesc = Object.prototype.hasOwnProperty.call(FALLBACK, descKey);
							const description = hasDesc
								? tx(descKey)
								: (typeof entry.description === "string" ? entry.description : "");
							const title = hasTitle
								? tx(titleKey)
								: (typeof entry.title === "string" && entry.title.length > 0 ? entry.title : fallbackBudgetTierTitle(id, tx));
							return h(
								"button",
								{
									type: "button",
									className: "bcm-set-level",
									key: id,
									role: "radio",
									"aria-checked": active ? "true" : "false",
									"data-tier": id,
									title: description,
									disabled: budgetBusy || saving,
									onClick: () => applyBudget(id),
								},
								h(
									"span",
									{ className: "bcm-set-levelText" },
									h("span", { className: "bcm-set-levelTitle" }, title),
									description.length === 0 ? null : h("span", { className: "bcm-set-levelDesc" }, description),
								),
								h("span", { className: "bcm-set-levelMark", "aria-hidden": true }, active ? "\u2713" : ""),
							);
						}),
					),
					budgetCustom ? h("p", { className: "bcm-set-levelCustom" }, tx("set.budgetCustom")) : null,
					budgetOff ? h("p", { className: "bcm-set-budgetOff" }, tx("set.budgetOff")) : null,
					renderSwitchRow(tx("set.budgetEnabled"), tx("set.budgetEnabledHint"), draft.budget.enabled, (value) => setBudget("enabled", value)),
					h(
						"div",
						{ className: "bcm-set-subgrid bcm-set-budgetGrid" },
						BUDGET_FIELDS.map((spec) => {
							const fieldHint = spec.key === "maxCallsPerTurn" ? ` · ${tx("set.budgetCallsHint")}` : "";
							return h(
								"label",
								{ className: "bcm-set-field", key: spec.key, title: `${tx(spec.labelKey)}${fieldHint}` },
								h("span", { className: "bcm-set-label" }, tx(spec.labelKey)),
								h(
									"span",
									{ className: "bcm-set-inputWrap" },
									h("input", {
										type: "number",
										className: "bcm-set-input",
										min: spec.min,
										max: spec.max,
										step: 1,
										value: draft.budget[spec.key],
										"aria-label": tx(spec.labelKey),
										disabled: budgetBusy || saving || draft.budget.enabled !== true,
										onChange: (event) => setBudget(spec.key, event.target.value),
									}),
									h("span", { className: "bcm-set-unit", "aria-hidden": true }, tx(spec.unitKey)),
								),
							);
						}),
					),
					budgetError.length > 0 ? h("p", { className: "bcm-set-levelError", role: "status" }, budgetError) : null,
					budgetBusy ? h("p", { className: "bcm-set-levelBusy", role: "status" }, tx("set.budgetApplying")) : null,
				);

			const reviewCard = h(
				"section",
				{ className: "bcm-set-card" },
				h("h3", { className: "bcm-set-cardTitle" }, tx("set.review")),
				h("p", { className: "bcm-set-cardDesc", title: tx("set.reviewHint") }, tx("set.reviewHint")),
				h(
					"div",
					{ className: "bcm-set-inlineRow" },
					h(
						"label",
						{ className: "bcm-set-field bcm-set-depthField", title: tx("set.depth") },
						h("span", { className: "bcm-set-label" }, tx("set.depth")),
						h(
							"select",
							{
								className: "bcm-set-select",
								value: draft.tool.defaultDepth,
								"aria-label": tx("set.depth"),
								disabled: saving,
								onChange: (event) => setDepth(event.target.value),
							},
							h("option", { value: "quick" }, tx("set.depthQuick")),
							h("option", { value: "full" }, tx("set.depthFull")),
						),
					),
					h(
						"div",
						{ className: "bcm-set-field" },
						h("span", { className: "bcm-set-label" }, tx("set.stages")),
						h(
							"div",
							{ className: "bcm-set-checks" },
							STAGE_ORDER.map((stage) => h(
								"label",
								{ className: "bcm-set-check", key: stage },
								h("input", {
									type: "checkbox",
									checked: draft.tool.fullStages.includes(stage),
									onChange: () => toggleStage(stage),
								}),
								h("span", null, tx(STAGE_KEYS[stage])),
							)),
						),
					),
				),
			);

			const statusClass = status.kind === "saved"
				? "bcm-set-status bcm-set-statusSaved"
				: status.kind === "error"
					? "bcm-set-status bcm-set-statusError"
					: "bcm-set-status bcm-set-statusInfo";
			const statusText = status.kind === "saving" ? tx("set.saving") : status.message;

			const footer = h(
				"div",
				{ className: "bcm-set-footerCard" },
				h(
					"div",
					{ className: "bcm-set-actions" },
					h("button", { type: "button", className: "bcm-set-primary", disabled: saving, onClick: onSave }, tx("set.save")),
					h(
						"button",
						{
							type: "button",
							className: "bcm-set-secondary",
							disabled: saving,
							onClick: () => setReloadToken((token) => token + 1),
						},
						tx("set.reload"),
					),
				),
				h("span", { className: statusClass, role: "status", "aria-live": "polite" }, statusText),
				h(
					"div",
					{ className: "bcm-set-meta" },
					h("span", null, tx("set.routes")),
					h("span", null, `${tx("voice.actor")} ${actorRoutes.length > 0 ? actorRoutes.join("  \u2192  ") : tx("none")}`),
					h("span", null, `${tx("voice.examiner")} ${examinerRoutes.length > 0 ? examinerRoutes.join("  \u2192  ") : tx("none")}`),
					h(
						"button",
						{
							type: "button",
							className: "bcm-set-link",
							"aria-expanded": showPath ? "true" : "false",
							"aria-label": tx("set.path"),
							onClick: () => setShowPath((value) => !value),
						},
						`${tx("set.path")} ${showPath ? "\u25be" : "\u25b8"}`,
					),
					showPath ? h("code", { className: "bcm-set-path" }, settingsPath.length > 0 ? settingsPath : tx("none")) : null,
				),
			);

			return h(
				React.Fragment,
				null,
				h("style", { key: "bicameral-mind-settings-styles" }, SETTINGS_CSS),
				h(
					"div",
					{ className: "bcm-set-root", "data-bicameral-mind-settings": true },
					headerRow,
					banner,
					levelCard,
					examinerCard,
					actorCard,
					autoCard,
					budgetCard,
					reviewCard,
					footer,
				),
			);
		}

		return {
			inject: ["slots", "locale"],
			apply(ctx) {
				// Own copy is registered through the locale service; a host that
				// already owns this namespace must not make either surface fail.
				ctx.effect(() => {
					try {
						return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
					} catch {
						return () => {};
					}
				}, "bicameral-mind: client dictionaries");

				const t = ctx.locale.bind(NS);

				// Conversation view tab + page; `label` is resolved live through the
				// locale face so a language switch renames the tab.
				ctx.slots.inject("conversation.view", () => ctx.slots.register({
					name: "conversation.view",
					id: "bicameral-mind-view",
					order: 15,
					label: () => {
						const value = t("title");
						return typeof value === "string" && value.length > 0 && value !== "title" ? value : FALLBACK.title;
					},
					locale: NS,
				}, BicameralView));

				// Composer toolbar control inside the standard controls row; the
				// trigger label comes from the Host config, so nothing is hardcoded.
				ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
					name: "conversation.input.right",
					id: "bicameral-mind-model",
					order: 40,
					locale: NS,
				}, (props) => h(BicameralModelPicker, {
					...props,
					remote: ctx.remote ?? ctx.get?.("remote"),
				})));

				// Settings navigation row + page; `label` is resolved live through
				// the locale face so a language switch renames the row. A missing
				// dictionary entry falls back to the built-in title.
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "bicameral-mind-settings",
					order: 35,
					label: () => {
						const value = t("nav");
						return typeof value === "string" && value.length > 0 && value !== "nav" ? value : FALLBACK.nav;
					},
					locale: NS,
				}, BicameralSettings));
			},
		};
	},
});
