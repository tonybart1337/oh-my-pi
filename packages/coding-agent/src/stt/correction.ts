import { completeSimple, judgeQuestions, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { concreteThinkingLevel, shouldDisableReasoning, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { prompt } from "@oh-my-pi/pi-utils";
import { resolveRoleChain } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { type JudgeRegistry, type JudgmentUsage, resolveJudge } from "../judgment";
import questionFile from "../prompts/judge/stt-correction.json" with { type: "json" };
import correctionPrompt from "../prompts/system/stt-correction.md" with { type: "text" };
import { tinyModelClient } from "../tiny/title-client";
import {
	cfgSttCorrectionGate,
	cfgSttCorrectionGateEnabled,
	cfgSttCorrectionModel,
	cfgSttCorrectionModelEnabled,
} from "./settings";

const QUESTIONS = judgeQuestions(questionFile);
const SYSTEM_PROMPT = prompt.render(correctionPrompt);

export interface CorrectionDependencies {
	settings: Settings;
	registry: JudgeRegistry;
	sessionId?: string;
	signal?: AbortSignal;
	onUsage?: (usage: JudgmentUsage) => void;
}

export interface CorrectionResult {
	text: string;
	/** Omitted when the gate was disabled. */
	needsCorrection?: boolean;
	/** Gate-only mode can flag a draft without rewriting it. */
	warning?: string;
}

/** Uses the normal judgment and chat-role fallback/credential paths, never a direct provider shortcut.
 * Failures reject so hosts retain their already-visible original draft and warn the user. */
export async function correctTranscript(transcript: string, deps: CorrectionDependencies): Promise<CorrectionResult> {
	const gateEnabled = cfgSttCorrectionGateEnabled.get(deps.settings);
	const modelEnabled = cfgSttCorrectionModelEnabled.get(deps.settings);
	if (!gateEnabled && !modelEnabled) return { text: transcript };
	const timeout = AbortSignal.timeout(60_000);
	const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
	signal.throwIfAborted();
	let needsCorrection: boolean | undefined;
	if (gateEnabled) {
		const judge = resolveJudge({
			settings: deps.settings,
			registry: deps.registry,
			sessionId: deps.sessionId,
			selector: cfgSttCorrectionGate.get(deps.settings),
			purpose: "stt-correction",
			onUsage: deps.onUsage,
		});
		const { answers } = await judge.judge({ state: { transcript }, questions: QUESTIONS }, { signal });
		const answer = answers.need_correction;
		if (answer.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
			throw new Error("Dictation gate returned an invalid need_correction answer");
		}
		needsCorrection = answer.noul >= 0.5;
		if (!needsCorrection) return { text: transcript, needsCorrection };
	}
	if (!modelEnabled) {
		return {
			text: transcript,
			needsCorrection,
			warning:
				"Dictation gate flagged possible recognition errors; correction model is disabled. Review the original draft before Send.",
		};
	}

	const candidates = resolveRoleChain(
		"smol",
		deps.settings,
		roleCandidatePool("smol", deps.settings, deps.registry),
		cfgSttCorrectionModel.get(deps.settings),
	);
	let failure: unknown = new Error("No dictation correction model is available");
	for (const { model, thinkingLevel } of candidates) {
		signal.throwIfAborted();
		try {
			const content = JSON.stringify({ transcript });
			let text: string | null;
			if (model.api === "local-inference") {
				text = await tinyModelClient.complete(model.id, content, {
					systemPrompt: SYSTEM_PROMPT,
					maxTokens: 4096,
					signal,
				});
			} else {
				if (!(await deps.registry.getApiKey(model, deps.sessionId, { signal }))) continue;
				const level = concreteThinkingLevel(thinkingLevel);
				const message = await retryTransientCompletion(
					() =>
						completeSimple(
							model,
							{
								systemPrompt: [SYSTEM_PROMPT],
								messages: [{ role: "user", content, timestamp: Date.now() }],
							},
							{
								apiKey: deps.registry.resolver(model, deps.sessionId),
								sessionId: deps.sessionId,
								maxTokens: 4096,
								reasoning: clampThinkingLevelForModel(model, toReasoningEffort(level)),
								disableReasoning: shouldDisableReasoning(level) ? true : undefined,
								signal,
								onAttempt: message =>
									deps.onUsage?.({
										purpose: "stt-correction",
										role: "smol",
										api: model.api,
										provider: model.provider,
										model: model.id,
										usage: message.usage,
										stopReason: message.stopReason,
										errorMessage: message.errorMessage,
									}),
							},
						),
					{ provider: model.provider, signal },
				);
				if (message.stopReason !== "stop")
					throw new Error(message.errorMessage || `Correction ended with ${message.stopReason}`);
				text = message.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join("")
					.trim();
			}
			signal.throwIfAborted();
			if (!text?.trim()) throw new Error("Dictation correction returned no text");
			return { text: text.trim(), needsCorrection };
		} catch (error) {
			if (signal.aborted) throw error;
			failure = error;
		}
	}
	throw failure;
}
