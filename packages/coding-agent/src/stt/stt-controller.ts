import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import { transcribeAudio } from "@oh-my-pi/pi-ai/transcription";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { AudioCapture } from "@oh-my-pi/pi-natives";
import type { ModelBrowserRegistry } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { logger } from "@oh-my-pi/pi-utils";
import { type RoleChainCandidate, resolveConfiguredModelPatterns, resolveRoleChain } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import { type Settings, settings } from "../config/settings";
import type { JudgeRegistry } from "../judgment";
import { type SttStreamHandle, sttClient } from "./asr-client";
import { correctTranscript } from "./correction";
import { downloadSttModel, isSttModelCached } from "./downloader";
import { resolveSttModelSpec, type SttModelKey } from "./models";
import { evaluateSubmitTrigger } from "./submit-trigger";
import { encodePcm16Wav, floatToPcm16 } from "./wav";

import {
	cfgSttCorrectionEnabled,
	cfgSttCorrectionGateEnabled,
	cfgSttCorrectionModelEnabled,
	cfgSttLanguage,
	cfgSttSubmitTrigger,
	cfgSttWakePhrase,
	cfgSttWakeTimeoutMs,
} from "./settings";

export type SttState = "idle" | "recording" | "transcribing";

/** How a capture reports progress and state to its host. */
export interface SttCallbacks {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStateChange(state: SttState): void;
	/** Keep this capture as a draft, without interpreting submit commands. */
	manualSubmit?: boolean;
	/** Wake listening only: false discards recognition until the host can accept a new command. */
	acceptInput?(): boolean;
}

/** The slice of a text input the controller dictates into. */
export interface SttTarget {
	setVolatileText(text: string): void;
	clearVolatileText(): void;
	commitVolatileText(text: string): void;
	submit(): void;
	deleteBeforeCursor(count: number): void;
	/** Optional draft snapshot surface; without it review safely retains the original. */
	getText?(): string;
	setText?(text: string): void;
}

interface CaptureHandle {
	stop(): void;
}

type CaptureFactory = (onAudio: (error: Error | null, samples: Float32Array) => void) => CaptureHandle;

interface SttRegistry extends ModelBrowserRegistry {
	resolver(model: Model<Api>, sessionId?: string): ApiKeyResolver;
	getApiKey?: JudgeRegistry["getApiKey"];
	resolveModelHeaders?: JudgeRegistry["resolveModelHeaders"];
}

function supportsReview(registry: SttRegistry | undefined): registry is SttRegistry & JudgeRegistry {
	return !!registry?.getApiKey && !!registry.resolveModelHeaders;
}

export interface STTControllerDependencies {
	settings: Settings;
	registry: SttRegistry;
	getSessionId?: () => string;
}

/** Coordinates native microphone capture with streaming local or buffered cloud transcription. */
export class STTController {
	#state: SttState = "idle";
	#resolvedModelKey: SttModelKey | null = null;
	#toggling = false;
	#stopAfterStart = false;
	/** Cancels the start in flight: its model preflight wait and whatever start step follows it. */
	#startAbort: AbortController | null = null;
	#disposed = false;
	#processingTranscript = false;
	#reviewAbort: AbortController | null = null;
	#reviewEnabled = false;
	#reviewSegments = "";
	#reviewPartial = "";
	readonly #createCapture: CaptureFactory;
	readonly #settings: Settings;
	readonly #registry: SttRegistry | undefined;
	readonly #getSessionId: (() => string) | undefined;

	// Live streaming capture.
	#stream: SttStreamHandle | null = null;
	#streamRecorder: CaptureHandle | null = null;
	#streamEditor: SttTarget | null = null;
	/** Callbacks of the running capture, from the {@link start} that began it. */
	#streamCallbacks: SttCallbacks | null = null;
	#streamCommitted = false;
	#streamAbort: AbortController | null = null;
	#streamUtterance = "";
	#wakePhrase = "";
	#wakeWords: string[] = [];
	#wakeStatus = "";
	#wakeTimeoutMs = 15_000;
	#wakeDeadline: number | null = null;
	#wakeTimer: Timer | undefined;
	/** A recognized command beginning inside the window may finish after its deadline. */
	#wakeCommandStarted = false;
	/** Until this segment ends, a partial prefix must still be present in its final transcript. */
	#wakePhraseInSegment = false;

	// Buffered cloud capture.
	#cloudModel: Model<Api> | null = null;
	/** Captured cloud-dictation audio, converted to 16-bit PCM on arrival (half the Float32 footprint). */
	#cloudAudio: Int16Array[] = [];

	/** Creates a controller; tests may replace the hardware capture boundary. */
	constructor();
	constructor(createCapture: CaptureFactory);
	constructor(dependencies: STTControllerDependencies);
	constructor(createCapture: CaptureFactory, dependencies: STTControllerDependencies);
	constructor(
		createCaptureOrDependencies?: CaptureFactory | STTControllerDependencies,
		dependencies?: STTControllerDependencies,
	) {
		if (typeof createCaptureOrDependencies === "function") {
			this.#createCapture = createCaptureOrDependencies;
			this.#settings = dependencies?.settings ?? settings;
			this.#registry = dependencies?.registry;
			this.#getSessionId = dependencies?.getSessionId;
		} else {
			this.#createCapture = onAudio => new AudioCapture(16_000, onAudio);
			this.#settings = createCaptureOrDependencies?.settings ?? settings;
			this.#registry = createCaptureOrDependencies?.registry;
			this.#getSessionId = createCaptureOrDependencies?.getSessionId;
		}
	}

	get state(): SttState {
		return this.#state;
	}

	#setState(state: SttState, options: SttCallbacks): void {
		this.#state = state;
		options.onStateChange(state);
	}

	/** Start dictating into `editor`, reporting to `options` until the capture ends. A no-op while a
	 *  capture is starting, recording, or transcribing. */
	async start(editor: SttTarget, options: SttCallbacks): Promise<void> {
		if (this.#state === "transcribing") options.showStatus("Transcription in progress...");
		if (this.#disposed || this.#toggling || this.#state !== "idle") return;
		await this.#transition(options, () => this.#start(editor, options));
	}

	/** Stop the running capture and transcribe it. A capture still starting is cancelled: a pending
	 *  model preflight stops waiting (the worker keeps loading), otherwise it stops once it is up.
	 *  A no-op unless starting or recording. */
	async stop(): Promise<void> {
		if (this.#processingTranscript) this.#reviewAbort?.abort();
		if (this.#toggling) {
			if (this.#state === "idle" || this.#state === "recording") this.#stopAfterStart = true;
			if (this.#state === "idle") this.#startAbort?.abort();
			return;
		}
		const callbacks = this.#streamCallbacks;
		if (this.#state === "recording" && callbacks) await this.#transition(callbacks, () => this.#stop(callbacks));
	}

	/** Stop a capture that is starting or recording; otherwise start one into `editor`. */
	async toggle(editor: SttTarget, options: SttCallbacks): Promise<void> {
		if (this.#state === "recording" || (this.#toggling && this.#state === "idle")) await this.stop();
		else await this.start(editor, options);
	}

	/** Run one start/stop step, then honor a stop requested while it was in flight. */
	async #transition(options: SttCallbacks, step: () => Promise<void>): Promise<void> {
		this.#toggling = true;
		try {
			await step();
			if (this.#stopAfterStart && this.#state === "recording") {
				this.#stopAfterStart = false;
				await this.#stop(options);
			} else if (this.#state !== "recording") {
				this.#stopAfterStart = false;
			}
		} finally {
			this.#toggling = false;
		}
	}

	#resolveCandidate(): RoleChainCandidate | undefined {
		if (!this.#registry) return undefined;
		const pool = roleCandidatePool("dictation", this.#settings, this.#registry);
		return resolveRoleChain("dictation", this.#settings, pool)[0];
	}

	#resolveModelKey(model = this.#resolveCandidate()?.model): SttModelKey {
		return resolveSttModelSpec(model?.id).key;
	}

	async #ensureDeps(options: SttCallbacks, modelKey: SttModelKey, signal: AbortSignal): Promise<SttModelKey | null> {
		// Keyed on the resolved role model rather than a one-shot flag: changing
		// modelRoles.dictation mid-session re-runs preflight for the new model.
		if (this.#resolvedModelKey === modelKey) return modelKey;
		try {
			// Native streaming needs a ready recognizer before the microphone opens;
			// otherwise the first words queue behind a cold model load. Buffered
			// models can still warm in the background while recording.
			const spec = resolveSttModelSpec(modelKey);
			const online = spec.engine === "sherpa" && spec.mode === "online";
			if (!online && (await isSttModelCached(modelKey))) {
				this.#warmModel(modelKey);
			} else {
				await downloadSttModel(modelKey, undefined, { signal });
			}
			this.#resolvedModelKey = modelKey;
			return modelKey;
		} catch (err) {
			// A cancelled start is not a setup failure; the worker finishes the load for the next start.
			if (signal.aborted) return null;
			const msg = err instanceof Error ? err.message : "Failed to setup STT dependencies";
			options.showWarning(msg);
			logger.error("STT dependency setup failed", { error: msg });
			return null;
		}
	}

	/** Warm the speech model in the worker without blocking recording. The worker
	 *  memoizes the load, so the stream/transcribe path reuses it and the model is
	 *  hot by the time recording stops. Only called when the weights are already
	 *  cached, so no network fetch happens. On load failure (corrupt cache, OOM,
	 *  runtime install) invalidate the resolved key so the next toggle re-runs
	 *  preflight and retries instead of skipping it forever. */
	#warmModel(modelKey: SttModelKey): void {
		void downloadSttModel(modelKey).catch(err => {
			// Guard against a concurrent model switch clobbering a newer resolution.
			if (!this.#disposed && this.#resolvedModelKey === modelKey) this.#resolvedModelKey = null;
			logger.debug("stt: background model warmup failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	async #start(editor: SttTarget, options: SttCallbacks): Promise<void> {
		const abort = new AbortController();
		this.#startAbort = abort;
		try {
			await this.#startWith(editor, options, abort.signal);
		} finally {
			if (this.#startAbort === abort) this.#startAbort = null;
		}
	}

	#supportsWakePhrase(model: Model<Api> | undefined, options: SttCallbacks): boolean {
		const spec = resolveSttModelSpec(model?.id);
		if ((!model || model.api === "local-inference") && spec.engine === "sherpa" && spec.mode === "online") {
			return true;
		}
		options.showWarning("Wake-phrase listening requires a local online speech-to-text model (Nemotron streaming).");
		return false;
	}

	async #startWith(editor: SttTarget, options: SttCallbacks, signal: AbortSignal): Promise<void> {
		this.#reviewEnabled = cfgSttCorrectionEnabled.get(this.#settings);
		this.#reviewSegments = "";
		this.#reviewPartial = "";
		const wakePhrase = options.manualSubmit ? "" : cfgSttWakePhrase.get(this.#settings).trim();
		if (wakePhrase && !/[\p{L}\p{N}]/u.test(wakePhrase)) {
			options.showWarning("The speech-to-text wake phrase must contain words.");
			return;
		}
		const first = this.#resolveCandidate();
		if (first?.replaces) {
			options.showWarning(
				`Dictation model ${first.replaces} not found; using ${first.model.provider}/${first.model.id}`,
			);
		} else if (!first && this.#registry) {
			// Empty chain: nothing replaced the configured selector, so the built-in local model runs.
			const role = this.#settings.getModelRole("dictation")?.trim();
			const qualified = role
				? (resolveConfiguredModelPatterns(role, this.#settings) ?? [role]).find(pattern => pattern.includes("/"))
				: undefined;
			if (qualified) options.showWarning(`Dictation model ${qualified} not found; using the built-in local model`);
		}
		let model = first?.model;
		if (wakePhrase && !this.#supportsWakePhrase(model, options)) return;
		if (model?.api === "openai-transcriptions") {
			this.#startBuffered(editor, options, model);
			return;
		}
		if (model && model.api !== "local-inference") {
			options.showWarning(`Unsupported speech-to-text API: ${model.api}`);
			return;
		}

		let modelKey = await this.#ensureDeps(options, this.#resolveModelKey(model), signal);
		if (!modelKey || signal.aborted) return;
		model = this.#resolveCandidate()?.model;
		if (wakePhrase && !this.#supportsWakePhrase(model, options)) return;
		if (model?.api === "openai-transcriptions") {
			this.#startBuffered(editor, options, model);
			return;
		}
		if (model && model.api !== "local-inference") {
			options.showWarning(`Unsupported speech-to-text API: ${model.api}`);
			return;
		}
		const startModelKey = this.#resolveModelKey(model);
		if (startModelKey !== modelKey) {
			modelKey = await this.#ensureDeps(options, startModelKey, signal);
			if (!modelKey || signal.aborted) return;
		}
		await this.#startStreaming(editor, options, modelKey, wakePhrase);
	}

	async #stop(options: SttCallbacks): Promise<void> {
		if (this.#cloudModel) await this.#stopBuffered(options);
		else await this.#stopStreaming(options);
	}

	// ── Buffered cloud transcription ────────────────────────────────

	#startBuffered(editor: SttTarget, options: SttCallbacks, model: Model<Api>): void {
		this.#streamEditor = editor;
		this.#streamCallbacks = options;
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		this.#streamAbort = new AbortController();
		this.#cloudModel = model;
		this.#cloudAudio = [];

		try {
			this.#streamRecorder = this.#createCapture((error, samples) => {
				if (this.#disposed || this.#cloudModel !== model || this.#state !== "recording") return;
				if (error) {
					logger.error("Native microphone capture failed", { error: error.message });
					const recorder = this.#streamRecorder;
					this.#streamRecorder = null;
					try {
						recorder?.stop();
					} catch (cause) {
						logger.debug("stt: microphone cleanup failed", {
							error: cause instanceof Error ? cause.message : String(cause),
						});
					}
					this.#streamAbort?.abort(error);
					this.#streamEditor?.clearVolatileText();
					this.#cleanupCloud();
					this.#setState("idle", options);
					options.showWarning(error.message);
					return;
				}
				if (samples.length > 0) this.#cloudAudio.push(floatToPcm16(samples));
			});
		} catch (err) {
			this.#streamAbort?.abort();
			this.#cleanupCloud();
			const msg = err instanceof Error ? err.message : "Failed to start microphone capture";
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
			return;
		}

		this.#setState("recording", options);
		logger.debug("STT buffered recording started", { model: `${model.provider}/${model.id}` });
	}

	async #stopBuffered(options: SttCallbacks): Promise<void> {
		const model = this.#cloudModel;
		const recorder = this.#streamRecorder;
		const abort = this.#streamAbort;
		if (!model || !abort || !this.#registry) {
			this.#cleanupCloud();
			this.#setState("idle", options);
			return;
		}

		this.#setState("transcribing", options);
		options.showStatus("Transcribing...");
		try {
			recorder?.stop();
		} catch (err) {
			logger.debug("stt: buffered recorder stop failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		this.#streamRecorder = null;

		let failed = false;
		let finalText = "";
		try {
			const language = cfgSttLanguage.get(this.#settings);
			const result = await transcribeAudio(
				model,
				{
					audio: encodePcm16Wav(this.#cloudAudio),
					mimeType: "audio/wav",
					fileName: "dictation.wav",
					responseFormat: "json",
					...(language && { language }),
				},
				{
					apiKey: this.#registry.resolver(model, this.#getSessionId?.()),
					signal: abort.signal,
				},
			);
			finalText = result.text.trim();
		} catch (err) {
			failed = true;
			if (!this.#disposed) {
				const msg = err instanceof Error ? err.message : "Transcription failed";
				options.showWarning(msg);
				logger.error("STT cloud transcription failed", { error: msg });
			}
		}
		if (this.#disposed) {
			this.#cleanupCloud();
			return;
		}

		await this.#finishTranscript(finalText, failed, options);
		this.#cleanupCloud();
		if (!this.#disposed) this.#setState("idle", options);
	}

	#cleanupCloud(): void {
		this.#cloudModel = null;
		this.#cloudAudio = [];
		this.#streamRecorder = null;
		this.#streamEditor = null;
		this.#streamCallbacks = null;
		this.#streamCommitted = false;
		this.#streamAbort = null;
		this.#streamUtterance = "";
	}

	// ── Live streaming ──────────────────────────────────────────────

	/** Segment text gets a leading space once a prior segment is committed, so
	 *  phrases join naturally; the first phrase is inserted at the cursor as-is. */
	#prefixed(text: string): string {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (!normalized) return "";
		return this.#streamCommitted ? ` ${normalized}` : normalized;
	}

	#previewTranscript(text: string): void {
		if (this.#reviewEnabled) {
			this.#reviewPartial = text.trim();
			return;
		}
		this.#streamEditor?.setVolatileText(this.#prefixed(text));
	}

	#commitTranscriptSegment(text: string): void {
		if (this.#reviewEnabled) {
			if (text.trim()) this.#reviewSegments += `${this.#reviewSegments ? " " : ""}${text.trim()}`;
			this.#reviewPartial = "";
			return;
		}
		const prefixed = this.#prefixed(text);
		if (prefixed) {
			this.#streamEditor?.commitVolatileText(prefixed);
			this.#streamCommitted = true;
			this.#streamUtterance += prefixed;
		} else this.#streamEditor?.clearVolatileText();
	}

	async #deliverWakeCommand(command: string): Promise<void> {
		const editor = this.#streamEditor;
		const options = this.#streamCallbacks;
		if (!editor || !options || this.#disposed || this.#processingTranscript) return;
		if (this.#reviewEnabled) await this.#reviewDraft(command, editor, options);
		else {
			editor.commitVolatileText(command);
			editor.submit();
		}
	}

	async #reviewDraft(original: string, editor: SttTarget, options: SttCallbacks, failed = false): Promise<void> {
		// The original is durable before any model call. Edits, Send, cancellation,
		// and failures can never strand a transcript in an asynchronous operation.
		const before = editor.getText?.();
		editor.commitVolatileText(original);
		const expected = editor.getText?.();
		options.showStatus("Dictation draft · review and press Send.");
		if (
			failed ||
			(!cfgSttCorrectionGateEnabled.get(this.#settings) && !cfgSttCorrectionModelEnabled.get(this.#settings))
		)
			return;
		const abort = new AbortController();
		this.#reviewAbort = abort;
		this.#processingTranscript = true;
		const sessionId = this.#getSessionId?.();
		try {
			const registry = this.#registry;
			if (!supportsReview(registry)) throw new Error("Model credentials are unavailable");
			const signal = this.#streamAbort ? AbortSignal.any([abort.signal, this.#streamAbort.signal]) : abort.signal;
			const result = await correctTranscript(original, { settings: this.#settings, registry, sessionId, signal });
			if (this.#disposed || signal.aborted || this.#getSessionId?.() !== sessionId || this.#streamEditor !== editor)
				return;
			if (result.warning) options.showWarning(result.warning);
			const corrected = result.text;
			if (corrected !== original) {
				// Replace only our unchanged insertion. Never replace a user's typed,
				// edited, submitted, or switched-away draft with a late model result.
				let index = expected?.indexOf(original) ?? -1;
				while (index >= 0 && expected!.slice(0, index) + expected!.slice(index + original.length) !== before) {
					index = expected!.indexOf(original, index + 1);
				}
				if (index >= 0 && expected !== undefined && editor.setText && editor.getText?.() === expected) {
					editor.setText(expected.slice(0, index) + corrected + expected.slice(index + original.length));
				} else
					options.showWarning(
						"Dictation draft changed during correction; kept your draft without overwriting it.",
					);
			}
			options.showStatus("Dictation draft · review and press Send.");
		} catch (error) {
			if (!this.#disposed && !abort.signal.aborted) {
				options.showWarning(
					`Dictation correction failed; original draft retained. ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} finally {
			if (this.#reviewAbort === abort) {
				this.#reviewAbort = null;
				this.#processingTranscript = false;
			}
		}
	}

	/** Match complete normalized words at the prefix, retaining the command's original spelling. */
	#stripWakePhrase(text: string): string | null {
		let index = 0;
		for (const word of text.matchAll(/[\p{L}\p{N}]+/gu)) {
			if (word[0].normalize("NFKC").toLowerCase() !== this.#wakeWords[index]) return null;
			if (++index === this.#wakeWords.length) {
				return text
					.slice(word.index + word[0].length)
					.replace(/^[\s\p{P}\p{S}]+/u, "")
					.trim();
			}
		}
		return null;
	}

	#showWakeStatus(message: string): void {
		if (message === this.#wakeStatus) return;
		this.#wakeStatus = message;
		this.#streamCallbacks?.showStatus(message);
	}

	#wakeListeningStatus(): string {
		return `Microphone on · listening for “${this.#wakePhrase} …”`;
	}

	#wakeCurrentStatus(): string {
		return this.#wakeDeadline === null
			? this.#wakeListeningStatus()
			: "Microphone on · wake phrase detected; listening for command";
	}

	#resetWakeWindow(): void {
		clearTimeout(this.#wakeTimer);
		this.#wakeTimer = undefined;
		this.#wakeDeadline = null;
		this.#wakeCommandStarted = false;
		this.#wakePhraseInSegment = false;
	}

	#cancelWakeStream(): void {
		const stream = this.#stream;
		this.#stream = null;
		stream?.cancel();
	}

	#expireWakeWindow(): void {
		this.#resetWakeWindow();
		this.#cancelWakeStream();
		if (!this.#disposed && this.#state === "recording" && this.#acceptWakeInput()) {
			this.#showWakeStatus(this.#wakeListeningStatus());
		}
	}

	#scheduleWakeExpiry(): void {
		clearTimeout(this.#wakeTimer);
		this.#wakeTimer = undefined;
		if (this.#wakeDeadline === null) return;
		const remaining = this.#wakeDeadline - Date.now();
		if (remaining <= 0) {
			this.#expireWakeWindow();
			return;
		}
		this.#wakeTimer = setTimeout(() => this.#expireWakeWindow(), remaining);
	}

	#observeWakePartial(text: string): void {
		if (this.#wakeDeadline !== null && !this.#wakeCommandStarted && Date.now() >= this.#wakeDeadline) {
			this.#expireWakeWindow();
			return;
		}
		const stripped = this.#stripWakePhrase(text);
		if (this.#wakeDeadline === null) {
			if (stripped === null) return;
			this.#wakeDeadline = Date.now() + this.#wakeTimeoutMs;
			this.#wakePhraseInSegment = true;
			this.#scheduleWakeExpiry();
		}
		const command = stripped ?? (this.#wakePhraseInSegment ? "" : text.trim());
		if (command) {
			this.#wakeCommandStarted = true;
			clearTimeout(this.#wakeTimer);
			this.#wakeTimer = undefined;
		}
		this.#showWakeStatus(this.#wakeCurrentStatus());
	}

	#takeWakeCommand(text: string): string | null {
		if (this.#wakeDeadline !== null && !this.#wakeCommandStarted && Date.now() >= this.#wakeDeadline) {
			this.#expireWakeWindow();
			return null;
		}
		const stripped = this.#stripWakePhrase(text);
		if (this.#wakeDeadline === null) {
			if (stripped === null) return null;
			this.#wakeDeadline = Date.now() + this.#wakeTimeoutMs;
			this.#wakePhraseInSegment = true;
		}
		const command = stripped ?? (this.#wakePhraseInSegment ? null : text.trim());
		if (command) {
			this.#resetWakeWindow();
			return command;
		}
		if (stripped === "") {
			// A phrase-only endpoint opens the next segment, without restarting the
			// window already announced by its first matching partial.
			this.#wakePhraseInSegment = false;
			this.#wakeCommandStarted = false;
			this.#scheduleWakeExpiry();
		} else {
			this.#resetWakeWindow();
		}
		return null;
	}

	#acceptWakeInput(): boolean {
		if (!this.#processingTranscript && this.#streamCallbacks?.acceptInput?.() !== false) return true;
		// Drop the native utterance as well as any in-flight text, so resuming cannot
		// complete assistant echo or a command spoken while the host was busy.
		this.#resetWakeWindow();
		this.#cancelWakeStream();
		this.#showWakeStatus("Microphone on · wake listening paused while input is unavailable");
		return false;
	}

	#openStream(modelKey: SttModelKey, language: string): SttStreamHandle {
		const stream = sttClient.startStream(modelKey, {
			language: language || undefined,
			signal: this.#streamAbort?.signal,
			discardTranscript: this.#wakeWords.length > 0,
			onPartial: text => {
				if (this.#disposed || this.#stream !== stream || this.#state !== "recording") return;
				if (this.#wakeWords.length > 0) {
					if (!this.#acceptWakeInput()) return;
					this.#observeWakePartial(text);
					return;
				}
				this.#previewTranscript(text);
			},
			onSegment: text => {
				if (this.#disposed || this.#stream !== stream) return;
				if (this.#wakeWords.length > 0) {
					if (this.#state !== "recording" || !this.#acceptWakeInput()) return;
					// A fresh command must not inherit the previous utterance's native
					// decoder/cache context, including discarded ambient speech.
					this.#cancelWakeStream();
					const command = this.#takeWakeCommand(text);
					if (command) void this.#deliverWakeCommand(command);
					else if (this.#acceptWakeInput()) this.#showWakeStatus(this.#wakeCurrentStatus());
					return;
				}
				this.#commitTranscriptSegment(text);
			},
		});
		return stream;
	}

	async #startStreaming(
		editor: SttTarget,
		options: SttCallbacks,
		modelKey: SttModelKey,
		wakePhrase: string,
	): Promise<void> {
		const language = cfgSttLanguage.get(this.#settings);
		this.#streamEditor = editor;
		this.#streamCallbacks = options;
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		const abort = new AbortController();
		this.#streamAbort = abort;
		this.#resetWakeWindow();
		this.#wakeTimeoutMs = cfgSttWakeTimeoutMs.get(this.#settings);
		this.#wakePhrase = wakePhrase;
		this.#wakeWords =
			wakePhrase
				.normalize("NFKC")
				.toLowerCase()
				.match(/[\p{L}\p{N}]+/gu) ?? [];
		this.#stream = this.#openStream(modelKey, language);
		let recorder: CaptureHandle;
		try {
			recorder = this.#createCapture((error, samples) => {
				if (this.#disposed || this.#streamAbort !== abort || this.#state !== "recording") return;
				if (error) {
					logger.error("Native microphone capture failed", { error: error.message });
					const activeRecorder = this.#streamRecorder;
					this.#streamRecorder = null;
					try {
						activeRecorder?.stop();
					} catch (cause) {
						logger.debug("stt: microphone cleanup failed", {
							error: cause instanceof Error ? cause.message : String(cause),
						});
					}
					this.#streamAbort?.abort(error);
					this.#stream?.cancel();
					if (this.#wakeWords.length === 0) {
						if (this.#reviewEnabled) {
							const text = [this.#reviewSegments, this.#reviewPartial].filter(Boolean).join(" ");
							if (text) this.#streamEditor?.commitVolatileText(text);
						} else this.#streamEditor?.clearVolatileText();
					}
					this.#cleanupStream();
					this.#setState("idle", options);
					options.showWarning(error.message);
					return;
				}
				if (this.#wakeWords.length > 0) {
					if (!this.#acceptWakeInput()) return;
					if (!this.#stream) {
						this.#stream = this.#openStream(modelKey, language);
						this.#showWakeStatus(this.#wakeCurrentStatus());
					}
				}
				this.#stream?.pushAudio(samples);
			});
		} catch (err) {
			this.#stream?.cancel();
			this.#cleanupStream();
			const msg = err instanceof Error ? err.message : "Failed to start microphone capture";
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
			return;
		}
		this.#streamRecorder = recorder;
		this.#setState("recording", options);
		if (this.#wakeWords.length > 0 && this.#acceptWakeInput()) this.#showWakeStatus(this.#wakeListeningStatus());
		logger.debug("STT live recording started", { modelKey });
	}

	async #stopStreaming(options: SttCallbacks): Promise<void> {
		const stream = this.#stream;
		const recorder = this.#streamRecorder;
		if (this.#wakeWords.length > 0) {
			// Toggle-off is cancellation, not an utterance endpoint: do not flush a
			// pending command or replay the worker's joined ambient transcript.
			this.#setState("transcribing", options);
			try {
				recorder?.stop();
			} catch (err) {
				logger.debug("stt: wake recorder stop failed", { error: String(err) });
			}
			this.#streamAbort?.abort();
			this.#reviewAbort?.abort();
			stream?.cancel();
			this.#cleanupStream();
			this.#setState("idle", options);
			options.showStatus("Wake-phrase listening stopped.");
			return;
		}
		if (!stream) {
			this.#setState("idle", options);
			return;
		}
		this.#setState("transcribing", options);
		// Stop the mic first so no further audio is fed, then flush the worker.
		try {
			recorder?.stop();
		} catch (err) {
			logger.debug("stt: streaming recorder stop failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		this.#streamRecorder = null;

		let failed = false;
		let finalText = "";
		try {
			finalText = (await stream.stop()).trim();
		} catch (err) {
			failed = true;
			if (!this.#disposed) {
				const msg = err instanceof Error ? err.message : "Transcription failed";
				options.showWarning(msg);
				logger.error("STT live transcription failed", { error: msg });
			}
		}
		if (this.#disposed) {
			this.#cleanupStream();
			return;
		}
		await this.#finishTranscript(finalText, failed, options);
		this.#cleanupStream();
		if (!this.#disposed) this.#setState("idle", options);
	}

	#cleanupStream(): void {
		this.#stream = null;
		this.#streamRecorder = null;
		this.#streamEditor = null;
		this.#streamCallbacks = null;
		this.#streamCommitted = false;
		this.#streamAbort = null;
		this.#streamUtterance = "";
		this.#wakePhrase = "";
		this.#wakeWords = [];
		this.#wakeStatus = "";
		this.#resetWakeWindow();
	}

	async #finishTranscript(finalText: string, failed: boolean, options: SttCallbacks): Promise<void> {
		if (this.#reviewEnabled) {
			const text = finalText || [this.#reviewSegments, this.#reviewPartial].filter(Boolean).join(" ");
			this.#reviewSegments = "";
			this.#reviewPartial = "";
			if (text && this.#streamEditor) await this.#reviewDraft(text, this.#streamEditor, options, failed);
			else if (!failed) options.showStatus("No speech detected.");
			return;
		}
		if (!this.#streamCommitted && finalText) {
			const prefixed = this.#prefixed(finalText);
			this.#streamEditor?.commitVolatileText(prefixed);
			this.#streamCommitted = true;
			this.#streamUtterance = prefixed;
		} else {
			this.#streamEditor?.clearVolatileText();
		}
		if (!failed) options.showStatus(this.#streamCommitted ? "" : "No speech detected.");

		if (!options.manualSubmit && this.#streamCommitted && !failed && this.#streamEditor) {
			const trigger = cfgSttSubmitTrigger.get(this.#settings);
			const { submit, trimTrailing } = evaluateSubmitTrigger(this.#streamUtterance, trigger);
			if (trimTrailing > 0) {
				this.#streamEditor.deleteBeforeCursor(trimTrailing);
			}
			if (submit) {
				this.#streamEditor.submit();
			}
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		if (this.#reviewEnabled && !this.#processingTranscript && this.#wakeWords.length === 0) {
			const text = [this.#reviewSegments, this.#reviewPartial].filter(Boolean).join(" ");
			if (text) this.#streamEditor?.commitVolatileText(text);
		}
		this.#disposed = true;
		this.#reviewAbort?.abort();
		this.#startAbort?.abort();
		if (this.#streamAbort) {
			this.#streamAbort.abort();
			this.#streamAbort = null;
		}
		this.#stream?.cancel();
		try {
			this.#streamRecorder?.stop();
		} catch {
			// best effort cleanup
		}
		this.#cleanupStream();
		this.#cloudModel = null;
		this.#cloudAudio = [];
		this.#state = "idle";
		this.#resolvedModelKey = null;
	}
}
