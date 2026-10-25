import { judgeQuestions } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";
import { type JudgeRegistry, type JudgmentUsage, resolveJudge } from "../judgment";
import questionFile from "../prompts/judge/stt-reply.json" with { type: "json" };
import { cfgSttConfirmJudge } from "./settings";

const QUESTIONS = judgeQuestions(questionFile);

/** What a spoken reply to a ready voice draft asks for; `other` is more dictation or unrelated speech. */
export type VoiceReply = "send" | "reset" | "other";

const SEND_WORDS: Record<string, true> = {
	send: true,
	"send it": true,
	submit: true,
	confirm: true,
	confirmed: true,
	yes: true,
	yeah: true,
	yep: true,
	yeap: true,
	yup: true,
	go: true,
	"go ahead": true,
	"yes send": true,
	"yes send it": true,
	"ok send": true,
	"okay send": true,
};
const RESET_WORDS: Record<string, true> = {
	reset: true,
	clear: true,
	"clear it": true,
	cancel: true,
	"cancel it": true,
	"start over": true,
	discard: true,
	"discard it": true,
	"never mind": true,
	nevermind: true,
	"delete it": true,
};

export interface VoiceReplyDependencies {
	settings: Settings;
	registry?: JudgeRegistry;
	sessionId?: string;
	signal?: AbortSignal;
	onUsage?: (usage: JudgmentUsage) => void;
}

/**
 * Exact short confirmations resolve locally; other short replies ask the configured judge (Jev by
 * default). Without a judge the reply is `other`, and a judge failure rejects so the caller keeps
 * the draft; a draft is never sent on a guess. Both texts go to the judge as quoted state.
 */
export async function classifyVoiceReply(
	reply: string,
	draft: string,
	deps: VoiceReplyDependencies,
): Promise<VoiceReply> {
	const normalized = reply
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (SEND_WORDS[normalized]) return "send";
	if (RESET_WORDS[normalized]) return "reset";
	const selector = cfgSttConfirmJudge.get(deps.settings).trim();
	// Long replies are continued dictation; only short utterances are plausible confirmations.
	if (!selector || !deps.registry || normalized.split(" ").length > 8) return "other";
	const timeout = AbortSignal.timeout(15_000);
	const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
	const judge = resolveJudge({
		settings: deps.settings,
		registry: deps.registry,
		sessionId: deps.sessionId,
		selector,
		purpose: "stt-reply",
		onUsage: deps.onUsage,
	});
	const { answers } = await judge.judge({ state: { draft, reply }, questions: QUESTIONS }, { signal });
	const probability = (id: "send_draft" | "reset_draft"): number => {
		const answer = answers[id];
		return answer?.type === "noul" && Number.isFinite(answer.noul) ? answer.noul : 0;
	};
	const send = probability("send_draft");
	const reset = probability("reset_draft");
	if (send >= 0.5 && send > reset) return "send";
	if (reset >= 0.5 && reset > send) return "reset";
	return "other";
}
