import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings, settings } from "../src/config/settings";
import * as asrClient from "../src/stt/asr-client";
import * as downloader from "../src/stt/downloader";
import { STTController, type STTControllerDependencies } from "../src/stt/stt-controller";
import { evaluateSubmitTrigger, type SttSubmitTrigger } from "../src/stt/submit-trigger";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

import { cfgSttSubmitTrigger, cfgSttWakePhrase, cfgSttWakeTimeoutMs } from "@oh-my-pi/pi-coding-agent/stt/settings";

const DICTATION_MODELS = [getBundledModel("local", "whisper-base")];
const WAKE_MODELS = [
	...DICTATION_MODELS,
	getBundledModel("local", "nemotron-streaming-en-0.6b"),
	getBundledModel("openai", "whisper-1"),
];
const registry: STTControllerDependencies["registry"] = {
	getError: () => undefined,
	getAvailable: () => DICTATION_MODELS,
	getAll: () => DICTATION_MODELS,
	resolver: () => () => "test-key",
};
const wakeRegistry: STTControllerDependencies["registry"] = {
	...registry,
	getAvailable: () => WAKE_MODELS,
	getAll: () => WAKE_MODELS,
};

describe("STT Submit Trigger Evaluation", () => {
	describe("never trigger", () => {
		it("should never submit", () => {
			expect(evaluateSubmitTrigger("hello world", "never")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("submit", "never")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "never")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});

	describe("release trigger", () => {
		it("should only submit if utterance has 2+ words", () => {
			expect(evaluateSubmitTrigger("hello", "release")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("  hello  ", "release")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello world", "release")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello world!", "release")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("one two three", "release")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "release")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});

	describe("release-complete trigger", () => {
		it("should submit only if utterance ends with terminal punctuation", () => {
			expect(evaluateSubmitTrigger("hello", "release-complete")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello world", "release-complete")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello.", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello?", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello!", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello...", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			// Full-width punctuation
			expect(evaluateSubmitTrigger("hello。", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello？", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello！", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello…", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "release-complete")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});

	describe("say-submit trigger", () => {
		it("should submit and trim trailing word when last word contains submit", () => {
			// Single word
			expect(evaluateSubmitTrigger("submit", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 6,
			});
			expect(evaluateSubmitTrigger("SUBMIT", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 6,
			});
			expect(evaluateSubmitTrigger("submit!", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 7,
			});

			// Multi word
			expect(evaluateSubmitTrigger("please submit", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 7, // " submit" has length 7
			});
			expect(evaluateSubmitTrigger("please submit.", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 8, // " submit." has length 8
			});
			expect(evaluateSubmitTrigger("please submit?", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 8,
			});
			expect(evaluateSubmitTrigger("please submit  ", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 9, // " submit  " has length 9
			});

			// Word containing submit
			expect(evaluateSubmitTrigger("please autosubmit", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 11, // " autosubmit" has length 11
			});
			expect(evaluateSubmitTrigger("please submitting", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 11,
			});

			// Negative cases
			expect(evaluateSubmitTrigger("submit please", "say-submit")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello", "say-submit")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "say-submit")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});
});

describe("STTController submit trigger integration", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;

	function makeEditor() {
		return {
			insertText: vi.fn(),
			setVolatileText: vi.fn(),
			clearVolatileText: vi.fn(),
			commitVolatileText: vi.fn(),
			submit: vi.fn(),
			deleteBeforeCursor: vi.fn(),
		};
	}

	function makeOptions() {
		return {
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			onStateChange: vi.fn(),
		};
	}

	async function transcribeStream(transcript: string, trigger: SttSubmitTrigger, manualSubmit?: boolean) {
		cfgSttSubmitTrigger.set(settings, trigger);
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue(transcript),
			cancel: vi.fn(),
		});
		const editor = makeEditor();
		const options = { ...makeOptions(), manualSubmit };
		controller = new STTController(() => ({ stop: vi.fn() }), { settings, registry });

		await controller.toggle(editor, options);
		expect(controller.state).toBe("recording");
		await controller.toggle(editor, options);
		expect(controller.state).toBe("idle");

		return { editor, options };
	}

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.setModelRole("dictation", "local/whisper-base");
		cfgSttSubmitTrigger.set(settings, "never");
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
	});

	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
	});

	it("submits streaming dictation on release when the transcript has at least two words", async () => {
		const { editor } = await transcribeStream("hello world", "release");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("hello world");
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("does not submit one-word streaming dictation on release", async () => {
		const { editor } = await transcribeStream("hello", "release");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("hello");
		expect(editor.submit).not.toHaveBeenCalled();
	});

	it("strips the spoken submit command before submitting streaming dictation", async () => {
		const { editor } = await transcribeStream("please review this submit.", "say-submit");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("please review this submit.");
		expect(editor.deleteBeforeCursor).toHaveBeenCalledWith(8);
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("keeps manually submitted streaming dictation intact despite the say-submit trigger", async () => {
		const { editor } = await transcribeStream("please review this submit.", "say-submit", true);

		expect(editor.commitVolatileText).toHaveBeenCalledWith("please review this submit.");
		expect(editor.deleteBeforeCursor).not.toHaveBeenCalled();
		expect(editor.submit).not.toHaveBeenCalled();
	});
});

describe("STTController continuous wake-phrase listening", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;
	let onAudio: (error: Error | null, samples: Float32Array) => void;
	let captureStarts = 0;
	const streams: Array<{ options: asrClient.SttStreamOptions; handle: asrClient.SttStreamHandle }> = [];
	const stopCapture = vi.fn();

	function editor() {
		return {
			setVolatileText: vi.fn(),
			clearVolatileText: vi.fn(),
			commitVolatileText: vi.fn(),
			submit: vi.fn(),
			deleteBeforeCursor: vi.fn(),
		};
	}

	function callbacks(acceptInput: (expectedText: string) => boolean = () => true) {
		return { showWarning: vi.fn(), showStatus: vi.fn(), onStateChange: vi.fn(), continuous: true, acceptInput };
	}

	function createController() {
		controller = new STTController(
			callback => {
				captureStarts++;
				onAudio = callback;
				return { stop: stopCapture };
			},
			{ settings, registry: wakeRegistry },
		);
		return controller;
	}

	function endpoint(text: string) {
		onAudio(null, Float32Array.of(0));
		streams.at(-1)!.options.onSegment?.(text, 0);
	}

	/** An endpoint followed by the quiet gap that ends the utterance. */
	function utterance(text: string) {
		endpoint(text);
		vi.advanceTimersByTime(700);
	}

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.setModelRole("dictation", "local/nemotron-streaming-en-0.6b");
		cfgSttWakePhrase.set(settings, "hey coach");
		cfgSttSubmitTrigger.set(settings, "never");
		cfgSttWakeTimeoutMs.set(settings, 15_000);
		vi.useFakeTimers();
		streams.length = 0;
		captureStarts = 0;
		stopCapture.mockClear();
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_key, options = {}) => {
			const handle = { pushAudio: vi.fn(), stop: vi.fn().mockResolvedValue("ambient tail"), cancel: vi.fn() };
			streams.push({ options, handle });
			return handle;
		});
	});

	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
	});

	it("never opens the microphone or worker before explicit start", () => {
		createController();
		expect(controller?.state).toBe("idle");
		expect(streams).toEqual([]);
		expect(stopCapture).not.toHaveBeenCalled();
	});

	it.each(["background conversation", "hey coaches review this", "hey"])(
		"ignores speech without the complete wake phrase: %s",
		async transcript => {
			const target = editor();
			await createController().start(target, callbacks());
			const { options } = streams[0]!;
			options.onPartial?.(transcript);
			options.onSegment?.(transcript, 0);
			vi.advanceTimersByTime(60_000);
			expect(target.setVolatileText).not.toHaveBeenCalled();
			expect(target.commitVolatileText).not.toHaveBeenCalled();
			expect(target.submit).not.toHaveBeenCalled();
		},
	);

	it("shows the command while speaking and sends it only after the speaker pauses", async () => {
		const target = editor();
		await createController().start(target, callbacks());
		const stream = streams[0]!;
		stream.options.onPartial?.("“HEY, COACH!”: What needs");
		expect(target.setVolatileText).toHaveBeenLastCalledWith("What needs");
		stream.options.onSegment?.("“HEY, COACH!”: What needs attention?", 0);
		vi.advanceTimersByTime(699);
		expect(target.submit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(target.commitVolatileText).toHaveBeenCalledWith("What needs attention?");
		expect(target.submit).toHaveBeenCalledTimes(1);
		expect(stream.handle.cancel).not.toHaveBeenCalled();
		expect(controller?.state).toBe("recording");
	});

	it("takes a one-breath command with lead-in words and endpoints inside the sentence", async () => {
		const target = editor();
		await createController().start(target, callbacks());
		const stream = streams[0]!;
		stream.options.onSegment?.("okay hey coach what tasks", 0);
		vi.advanceTimersByTime(500);
		// Speech resumes before the utterance-end gap: the same command continues.
		stream.options.onPartial?.("are running");
		vi.advanceTimersByTime(5_000);
		expect(target.submit).not.toHaveBeenCalled();
		stream.options.onSegment?.("are running right now", 1);
		vi.advanceTimersByTime(700);
		expect(target.commitVolatileText.mock.calls).toEqual([["what tasks are running right now"]]);
		expect(target.submit).toHaveBeenCalledTimes(1);
	});

	it("accepts a delayed command after the phrase alone, then requires a fresh phrase", async () => {
		const target = editor();
		const options = callbacks();
		await createController().start(target, options);
		const stream = streams[0]!;
		endpoint("hey coach");
		expect(options.showStatus).toHaveBeenLastCalledWith("“hey coach” heard · listening for your command");
		vi.advanceTimersByTime(14_000);
		utterance("first command");
		utterance("another ambient utterance");
		utterance("hey coach second command");
		expect(target.commitVolatileText.mock.calls).toEqual([["first command"], ["second command"]]);
		expect(target.submit).toHaveBeenCalledTimes(2);
		await controller?.stop();
		expect(stream.handle.stop).not.toHaveBeenCalled();
		expect(stream.handle.cancel).toHaveBeenCalled();
		expect(stopCapture).toHaveBeenCalledTimes(1);
	});

	it("closes the phrase-only window at the configured timeout", async () => {
		cfgSttWakeTimeoutMs.set(settings, 5_000);
		const target = editor();
		const options = callbacks();
		await createController().start(target, options);
		endpoint("hey coach");
		vi.advanceTimersByTime(5_000);
		expect(options.showStatus).toHaveBeenLastCalledWith("Microphone on · listening for “hey coach …”");
		utterance("late command without a new phrase");
		expect(target.commitVolatileText).not.toHaveBeenCalled();
		utterance("hey coach fresh command");
		expect(target.commitVolatileText.mock.calls).toEqual([["fresh command"]]);
	});

	it.each(["agent activity", "assistant playback", "typed draft"])(
		"clears a phrase-only window when host availability rejects %s",
		async () => {
			let available = true;
			const target = editor();
			const options = callbacks(() => available);
			await createController().start(target, options);
			endpoint("hey coach");
			available = false;
			onAudio(null, Float32Array.of(0));
			expect(options.showStatus).toHaveBeenLastCalledWith(
				"Microphone on · listening paused while input is unavailable",
			);
			available = true;
			utterance("interrupted command without a phrase");
			expect(options.showStatus).toHaveBeenCalledWith("Microphone on · listening for “hey coach …”");
			utterance("hey coach fresh command");
			expect(target.commitVolatileText.mock.calls).toEqual([["fresh command"]]);
			expect(target.submit).toHaveBeenCalledTimes(1);
		},
	);

	it("toggle-off keeps words already heard as an unsent draft and suppresses late callbacks", async () => {
		const target = editor();
		const options = callbacks();
		await createController().toggle(target, options);
		const stream = streams[0]!;
		stream.options.onPartial?.("hey coach unfinished command");
		await controller?.toggle(target, options);
		expect(target.commitVolatileText.mock.calls).toEqual([["unfinished command"]]);
		const statusCount = options.showStatus.mock.calls.length;
		vi.advanceTimersByTime(60_000);
		stream.options.onSegment?.("hey coach unfinished command", 0);
		expect(target.submit).not.toHaveBeenCalled();
		expect(options.showStatus).toHaveBeenCalledTimes(statusCount);
		expect(controller?.state).toBe("idle");
		expect(stopCapture).toHaveBeenCalledTimes(1);
	});

	it("toggle-off closes a phrase-only window; rearming needs the phrase again", async () => {
		const target = editor();
		const options = callbacks();
		await createController().toggle(target, options);
		endpoint("hey coach");
		await controller?.toggle(target, options);
		await controller?.start(target, options);
		utterance("old command after rearming without a phrase");
		expect(target.commitVolatileText).not.toHaveBeenCalled();
		expect(target.submit).not.toHaveBeenCalled();
	});

	it("discards busy or echoed utterances, resumes a fresh stream, and ignores stale endpoints", async () => {
		let available = true;
		const target = editor();
		await createController().start(
			target,
			callbacks(() => available),
		);
		const beforePause = streams[0]!;
		beforePause.options.onPartial?.("hey coach interrupted");
		available = false;
		onAudio(null, Float32Array.of(1));
		beforePause.options.onSegment?.("hey coach assistant echo", 0);
		expect(beforePause.handle.cancel).toHaveBeenCalled();
		available = true;
		onAudio(null, Float32Array.of(2));
		expect(streams).toHaveLength(2);
		beforePause.options.onSegment?.("hey coach stale queued command", 1);
		utterance("interrupted tail without a phrase");
		beforePause.options.onSegment?.("hey coach stale after ambient", 2);
		utterance("hey coach fresh command");
		expect(target.commitVolatileText.mock.calls).toEqual([["fresh command"]]);
		expect(target.submit).toHaveBeenCalledTimes(1);
	});

	it("rechecks availability at the endpoint and when the utterance ends", async () => {
		let available = true;
		const target = editor();
		await createController().start(
			target,
			callbacks(() => available),
		);
		const stream = streams[0]!;
		stream.options.onPartial?.("hey coach queued command");
		available = false;
		stream.options.onSegment?.("hey coach queued command", 0);
		expect(stream.handle.cancel).toHaveBeenCalled();
		available = true;
		endpoint("hey coach second command");
		available = false;
		vi.advanceTimersByTime(700);
		expect(target.commitVolatileText).not.toHaveBeenCalled();
		expect(target.submit).not.toHaveBeenCalled();
		await controller?.stop();
		expect(stopCapture).toHaveBeenCalledTimes(1);
	});

	it.each([true, false])(
		"dispose cancels the window without accepting later input (phrase only: %s)",
		async phraseOnly => {
			const target = editor();
			const options = callbacks();
			await createController().start(target, options);
			const stream = streams[0]!;
			if (phraseOnly) endpoint("hey coach");
			else stream.options.onSegment?.("hey coach pending", 0);
			controller?.dispose();
			const statusCount = options.showStatus.mock.calls.length;
			vi.advanceTimersByTime(60_000);
			stream.options.onSegment?.("hey coach pending", 0);
			onAudio(null, Float32Array.of(1));
			expect(target.commitVolatileText).not.toHaveBeenCalled();
			expect(target.submit).not.toHaveBeenCalled();
			expect(options.showStatus).toHaveBeenCalledTimes(statusCount);
			expect(stopCapture).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["local/whisper-base", "openai/whisper-1"])(
		"rejects non-online or cloud dictation before opening the microphone: %s",
		async model => {
			settings.setModelRole("dictation", model);
			const options = callbacks();
			await createController().start(editor(), options);
			expect(controller?.state).toBe("idle");
			expect(streams).toEqual([]);
			expect(captureStarts).toBe(0);
			expect(downloader.downloadSttModel).not.toHaveBeenCalled();
			expect(options.showWarning).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps the recording's phrase until stopped, then reads the new setting on the next start", async () => {
		const target = editor();
		const options = callbacks();
		await createController().start(target, options);
		cfgSttWakePhrase.set(settings, "hello assistant");
		utterance("hello assistant rejected during old capture");
		utterance("hey coach original phrase");
		await controller?.stop();
		await controller?.start(target, options);
		utterance("hello assistant updated phrase");
		expect(target.commitVolatileText.mock.calls).toEqual([["original phrase"], ["updated phrase"]]);
		expect(target.submit).toHaveBeenCalledTimes(2);
	});

	it("rejects a punctuation-only wake setting instead of accepting every utterance", async () => {
		cfgSttWakePhrase.set(settings, "! ...");
		const options = callbacks();
		await createController().start(editor(), options);
		expect(captureStarts).toBe(0);
		expect(streams).toEqual([]);
		expect(options.showWarning).toHaveBeenCalledTimes(1);
	});

	it("open-microphone listening without a wake phrase keeps dictation as a draft", async () => {
		cfgSttWakePhrase.set(settings, "");
		const target = editor();
		const options = callbacks();
		await createController().start(target, options);
		expect(options.showStatus).toHaveBeenLastCalledWith("Microphone on · hands-free dictation");
		utterance("first thought");
		utterance("second thought");
		expect(target.commitVolatileText.mock.calls).toEqual([["first thought"], ["second thought"]]);
		expect(target.submit).not.toHaveBeenCalled();
	});

	it("leaves manual-submit composer dictation ungated and does not auto-submit it", async () => {
		const target = editor();
		const options = { ...callbacks(() => false), manualSubmit: true };
		await createController().start(target, options);
		const stream = streams[0]!;
		stream.options.onPartial?.("ordinary draft");
		stream.options.onSegment?.("ordinary draft", 0);
		expect(target.setVolatileText).toHaveBeenCalledWith("ordinary draft");
		expect(target.commitVolatileText).toHaveBeenCalledWith("ordinary draft");
		await controller?.stop();
		expect(stream.handle.stop).toHaveBeenCalledTimes(1);
		expect(target.submit).not.toHaveBeenCalled();
	});
});
