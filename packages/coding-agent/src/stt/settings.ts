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

/** Opt-in prefix-gated continuous local dictation; recording still starts explicitly. */
export const cfgSttWakePhrase = register({ id: "stt.wakePhrase", type: "string", default: "" });

/** Time to begin the next command after detecting the wake phrase, not a speech-duration limit. */
export const cfgSttWakeTimeoutMs = register({
	id: "stt.wakeTimeoutMs",
	type: "number",
	default: 15_000,
	validate: value => {
		if (value === undefined) return;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
			throw new Error("stt.wakeTimeoutMs must be a positive number no greater than 2147483647.");
		}
	},
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
