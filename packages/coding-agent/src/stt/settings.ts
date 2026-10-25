/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { STT_SUBMIT_TRIGGER_OPTIONS, STT_SUBMIT_TRIGGER_VALUES } from "./submit-trigger";

// Speech-to-text
export const cfgSttEnabled = register({
	id: "stt.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Speech",
		label: "Speech-to-Text",
		description: "Enable speech-to-text input via microphone",
	},
});

export const cfgSttLanguage = register({ id: "stt.language", type: "string", default: "en" });

/** Rejects a configured duration that is not a positive timer delay; an unset value keeps the default. */
function positiveMs(id: string): (value: unknown) => void {
	return value => {
		if (value === undefined) return;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
			throw new Error(`${id} must be a positive number no greater than 2147483647.`);
		}
	};
}

/** Opt-in prefix-gated continuous local dictation; recording still starts explicitly unless always-on. */
export const cfgSttWakePhrase = register({ id: "stt.wakePhrase", type: "string", default: "" });

/** Time to begin the next command after detecting the wake phrase, not a speech-duration limit. */
export const cfgSttWakeTimeoutMs = register({
	id: "stt.wakeTimeoutMs",
	type: "number",
	default: 15_000,
	validate: positiveMs("stt.wakeTimeoutMs"),
});

/**
 * Arm continuous listening when the interactive session starts: wake-phrase listening when
 * `stt.wakePhrase` is set, otherwise open-microphone dictation. Audio is streamed to the
 * recognizer in memory only; the toggle key still turns the microphone off for the session.
 */
export const cfgSttAlwaysOn = register({ id: "stt.alwaysOn", type: "boolean", default: false });

/** Quiet time after a recognized segment before continuous listening treats the utterance as finished. */
export const cfgSttUtteranceEndMs = register({
	id: "stt.utteranceEndMs",
	type: "number",
	default: 700,
	validate: positiveMs("stt.utteranceEndMs"),
});

export const cfgSttSubmitTrigger = register({
	id: "stt.submitTrigger",
	type: "enum",
	values: STT_SUBMIT_TRIGGER_VALUES,
	default: "never",
	ui: {
		tab: "interaction",
		group: "Speech",
		label: "Speech-to-Text Submit Trigger",
		description:
			"Choose when speech dictation automatically submits: Never, Release (2+ words), Release with complete sentence, or When I Say Submit.",
		options: STT_SUBMIT_TRIGGER_OPTIONS,
	},
});

/** Review is opt-in globally; scoped settings may enable it for a voice workspace. */
export const cfgSttCorrectionEnabled = register({ id: "stt.correction.enabled", type: "boolean", default: false });
export const cfgSttCorrectionGateEnabled = register({
	id: "stt.correction.gateEnabled",
	type: "boolean",
	default: true,
});
export const cfgSttCorrectionModelEnabled = register({
	id: "stt.correction.modelEnabled",
	type: "boolean",
	default: true,
});
export const cfgSttCorrectionGate = register({ id: "stt.correction.gate", type: "string", default: "@judge" });
export const cfgSttCorrectionModel = register({
	id: "stt.correction.model",
	type: "string",
	default: "haiku-latest:auto",
});

/** Continuous listening only: after a voice draft is ready, a spoken reply can send or clear it. */
export const cfgSttConfirmEnabled = register({ id: "stt.confirm.enabled", type: "boolean", default: false });
/** Judge selector deciding whether an ambiguous reply means send or reset; empty uses keywords only. */
export const cfgSttConfirmJudge = register({ id: "stt.confirm.judge", type: "string", default: "@judge" });
/** Wake listening only: how long a reply needs no wake phrase after the draft is ready. */
export const cfgSttConfirmWindowMs = register({
	id: "stt.confirm.windowMs",
	type: "number",
	default: 20_000,
	validate: positiveMs("stt.confirm.windowMs"),
});
