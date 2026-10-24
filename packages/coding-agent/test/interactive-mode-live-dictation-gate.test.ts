import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type SttCallbacks, STTController } from "@oh-my-pi/pi-coding-agent/stt";
import * as asrClient from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import * as downloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { cfgSttEnabled, cfgSttWakePhrase } from "@oh-my-pi/pi-coding-agent/stt/settings";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode live mode vs. composer dictation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-live-dictation-gate-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		cfgSttEnabled.override(settings, true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function wakeCallbacks(): Promise<SttCallbacks> {
		cfgSttWakePhrase.override(mode.settings, "hey coach");
		let captured: SttCallbacks | undefined;
		vi.spyOn(STTController.prototype, "toggle").mockImplementation(async (_target, options) => {
			captured = options;
		});
		await mode.handleSTTToggle();
		if (!captured) throw new Error("Expected explicit speech toggle callbacks");
		return captured;
	}

	it("refuses live mode while a microphone click is still loading the recognizer", async () => {
		const pendingStart = Promise.withResolvers<void>();
		// The controller stays `idle` until the recognizer finishes loading.
		vi.spyOn(STTController.prototype, "start").mockReturnValue(pendingStart.promise);
		const liveCommand = vi.spyOn(LiveCommandController.prototype, "handleCommand").mockResolvedValue(undefined);
		const showWarning = vi.spyOn(mode, "showWarning").mockImplementation(() => {});

		await mode.handleLiveCommand();
		expect(liveCommand).toHaveBeenCalledTimes(1);

		mode.editor.onToggleDictation?.();
		await mode.handleLiveCommand();

		expect(liveCommand).toHaveBeenCalledTimes(1);
		expect(showWarning).toHaveBeenCalledWith("Finish the current speech-to-text capture before starting live mode.");
		pendingStart.resolve();
	});

	it("pauses wake commands while the agent works or assistant speech remains audible", async () => {
		const options = await wakeCallbacks();
		const speaking = vi.spyOn(vocalizer, "isSpeaking").mockReturnValue(false);
		let streaming = false;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		expect(options.acceptInput?.()).toBe(true);
		streaming = true;
		expect(options.acceptInput?.()).toBe(false);
		streaming = false;
		speaking.mockReturnValue(true);
		expect(options.acceptInput?.()).toBe(false);
		speaking.mockReturnValue(false);
		expect(options.acceptInput?.()).toBe(true);
	});

	it("does not duck assistant playback for the lifetime of continuous wake listening", async () => {
		const options = await wakeCallbacks();
		const duck = vi.spyOn(vocalizer, "duck").mockImplementation(() => {});
		const unduck = vi.spyOn(vocalizer, "unduck").mockImplementation(() => {});
		try {
			options.onStateChange("recording");
			expect(duck).not.toHaveBeenCalled();
			expect(unduck).toHaveBeenCalledTimes(1);
		} finally {
			options.onStateChange("idle");
		}
	});

	it("discards an addressed endpoint if a typed draft appears after listening starts", async () => {
		const options = await wakeCallbacks();
		mode.settings.setModelRole("dictation", "local/nemotron-streaming-en-0.6b");
		vi.spyOn(vocalizer, "isSpeaking").mockReturnValue(false);
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
		let streamOptions: asrClient.SttStreamOptions | undefined;
		const cancel = vi.fn();
		vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_key, supplied) => {
			streamOptions = supplied;
			return { pushAudio: vi.fn(), stop: vi.fn().mockResolvedValue(""), cancel };
		});
		const controller = new STTController(() => ({ stop: vi.fn() }), {
			settings: mode.settings,
			registry: session.modelRegistry,
		});
		const submit = vi.spyOn(mode.editor, "submit");
		try {
			await controller.start(mode.editor, options);
			streamOptions?.onPartial?.("hey coach proposed command");
			mode.editor.setText("typed draft stays here");
			streamOptions?.onSegment?.("hey coach proposed command", 0);
			expect(mode.editor.getText()).toBe("typed draft stays here");
			expect(submit).not.toHaveBeenCalled();
			expect(cancel).toHaveBeenCalled();
		} finally {
			controller.dispose();
			options.onStateChange("idle");
		}
	});
});
