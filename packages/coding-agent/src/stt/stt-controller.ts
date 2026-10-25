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
import { correctTranscript, summarizeCorrection } from "./correction";
import { downloadSttModel, isSttModelCached } from "./downloader";
import { resolveSttModelSpec, type SttModelKey } from "./models";
import { evaluateSubmitTrigger } from "./submit-trigger";
import { encodePcm16Wav, floatToPcm16 } from "./wav";

import {
	cfgSttConfirmEnabled,
	cfgSttConfirmWindowMs,
	cfgSttCorrectionEnabled,
	cfgSttCorrectionGateEnabled,
	cfgSttCorrectionModelEnabled,
	cfgSttLanguage,
	cfgSttSubmitTrigger,
	cfgSttUtteranceEndMs,
	cfgSttWakePhrase,
	cfgSttWakeTimeoutMs,
} from "./settings";
import { classifyVoiceReply, type VoiceReply } from "./voice-reply";

export type SttState = "idle" | "recording" | "transcribing";

/** How a capture reports progress and state to its host. */
export interface SttCallbacks {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStateChange(state: SttState): void;
	/** Keep this capture as a draft, without interpreting submit commands. */
	manualSubmit?: boolean;
	/** Keep listening across utterances: wake-phrase commands when `stt.wakePhrase` is set, otherwise
	 *  open-microphone dictation. Requires a local online recognizer; ignored with `manualSubmit`. */
	continuous?: boolean;
	/**
	 * Continuous listening only: whether recognition may reach the editor now. `expectedText` is the
	 * exact editor text the controller last left (its own draft and preview); any other text means the
	 * user took over. False discards recognition until the host can accept input again.
	 */
	acceptInput?(expectedText: string): boolean;
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

/** Joins recognized phrases with single spaces, skipping empty ones. */
function joinWords(...parts: string[]): string {
	return parts
		.map(part => part.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join(" ");
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

	// Continuous listening: wake-phrase commands, or open-microphone dictation when always-on.
	#continuous = false;
	#wakePhrase = "";
	#wakeWords: string[] = [];
	#listenStatus = "";
	/** Set while recognition is paused for unavailable input, so resuming announces listening again. */
	#paused = false;
	#wakeTimeoutMs = 15_000;
	/** A phrase-only utterance opens this window, in which the next speech is the command. */
	#wakeOpenUntil: number | null = null;
	#wakeTimer: Timer | undefined;
	/** Recognized command text of the utterance in progress; segments join until a quiet gap ends it. */
	#utterance = "";
	/** The utterance in progress was addressed (wake phrase or open microphone), not just a reply. */
	#utteranceAddressed = false;
	#utteranceTimer: Timer | undefined;
	/** Volatile preview currently inserted after {@link #owned}. */
	#preview = "";
	/** Exact editor text (without preview) this controller last left; anything else is the user's. */
	#owned = "";
	/** A ready voice draft awaiting a spoken send/reset. Wake listening accepts unaddressed replies until `until`. */
	#voiceDraft: { until: number | null } | null = null;
	#voiceDraftTimer: Timer | undefined;

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

	#supportsContinuous(model: Model<Api> | undefined, options: SttCallbacks): boolean {
		const spec = resolveSttModelSpec(model?.id);
		if ((!model || model.api === "local-inference") && spec.engine === "sherpa" && spec.mode === "online") {
			return true;
		}
		options.showWarning(
			"Continuous listening (wake phrase or always-on) requires a local online speech-to-text model (Nemotron streaming).",
		);
		return false;
	}

	async #startWith(editor: SttTarget, options: SttCallbacks, signal: AbortSignal): Promise<void> {
		this.#reviewEnabled = cfgSttCorrectionEnabled.get(this.#settings);
		this.#reviewSegments = "";
		this.#reviewPartial = "";
		const continuous = options.continuous === true && !options.manualSubmit;
		const wakePhrase = continuous ? cfgSttWakePhrase.get(this.#settings).trim() : "";
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
		if (continuous && !this.#supportsContinuous(model, options)) return;
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
		if (continuous && !this.#supportsContinuous(model, options)) return;
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
		await this.#startStreaming(editor, options, modelKey, wakePhrase, continuous);
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

	/** Classic capture: recognized text stays visible while speaking, in review mode too, so the
	 *  reviewed draft can be compared with what was heard. */
	#previewTranscript(text: string): void {
		if (this.#reviewEnabled) {
			this.#reviewPartial = text.trim();
			const preview = joinWords(this.#reviewSegments, this.#reviewPartial);
			if (preview) this.#streamEditor?.setVolatileText(preview);
			return;
		}
		this.#streamEditor?.setVolatileText(this.#prefixed(text));
	}

	#commitTranscriptSegment(text: string): void {
		if (this.#reviewEnabled) {
			this.#reviewSegments = joinWords(this.#reviewSegments, text);
			this.#reviewPartial = "";
			if (this.#reviewSegments) this.#streamEditor?.setVolatileText(this.#reviewSegments);
			return;
		}
		const prefixed = this.#prefixed(text);
		if (prefixed) {
			this.#streamEditor?.commitVolatileText(prefixed);
			this.#streamCommitted = true;
			this.#streamUtterance += prefixed;
		} else this.#streamEditor?.clearVolatileText();
	}

	/**
	 * Inserts `prefix + original` as an editable draft in place of any volatile preview, then lets
	 * review replace exactly that insertion. The original is durable before any model call; edits,
	 * Send, cancellation and failures never lose it or overwrite the user's own changes.
	 */
	async #reviewDraft(
		original: string,
		editor: SttTarget,
		options: SttCallbacks,
		ready: string,
		failed = false,
		prefix = "",
	): Promise<void> {
		editor.clearVolatileText();
		this.#preview = "";
		const before = editor.getText?.();
		const inserted = prefix + original;
		editor.commitVolatileText(inserted);
		const expected = editor.getText?.();
		this.#owned = expected ?? "";
		this.#listenStatus = "";
		options.showStatus(ready);
		if (
			failed ||
			!this.#reviewEnabled ||
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
			if (corrected === original) return;
			// Replace only our unchanged insertion. Never replace a user's typed,
			// edited, submitted, or switched-away draft with a late model result.
			let index = expected?.indexOf(inserted) ?? -1;
			while (index >= 0 && expected!.slice(0, index) + expected!.slice(index + inserted.length) !== before) {
				index = expected!.indexOf(inserted, index + 1);
			}
			if (index >= 0 && expected !== undefined && editor.setText && editor.getText?.() === expected) {
				editor.setText(expected.slice(0, index) + prefix + corrected + expected.slice(index + inserted.length));
				this.#owned = editor.getText?.() ?? "";
				options.showStatus(`Corrected: ${summarizeCorrection(original, corrected)} · ${ready}`);
			} else {
				options.showWarning("Dictation draft changed during correction; kept your draft without overwriting it.");
			}
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

	// ── Continuous listening ────────────────────────────────────────

	/** Text after the last complete wake phrase anywhere in `text` ("" when it ends there), or null.
	 *  Leading filler or a cut-off previous sentence in the same segment must not hide the phrase. */
	#afterWakePhrase(text: string): string | null {
		const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
		const length = this.#wakeWords.length;
		for (let start = words.length - length; start >= 0; start--) {
			const matches = this.#wakeWords.every(
				(word, offset) => words[start + offset]![0].normalize("NFKC").toLowerCase() === word,
			);
			if (!matches) continue;
			const last = words[start + length - 1]!;
			return text
				.slice(last.index + last[0].length)
				.replace(/^[\s\p{P}\p{S}]+/u, "")
				.trim();
		}
		return null;
	}

	#wakeWindowOpen(): boolean {
		return this.#wakeOpenUntil !== null && Date.now() < this.#wakeOpenUntil;
	}

	#replyWindowOpen(): boolean {
		return this.#voiceDraft !== null && (this.#voiceDraft.until === null || Date.now() < this.#voiceDraft.until);
	}

	/** The part of recognized `text` meant for the editor, or null for speech to ignore. Open-mic
	 *  speech is always addressed; wake listening needs the phrase, its open window, the utterance it
	 *  already started, or (unaddressed) a reply while a voice draft awaits confirmation. */
	#heard(text: string): { command: string; addressed: boolean } | null {
		if (this.#wakeWords.length === 0) return { command: text.trim(), addressed: true };
		const command = this.#afterWakePhrase(text);
		if (command !== null) return { command, addressed: true };
		if (this.#utterance) return { command: text.trim(), addressed: this.#utteranceAddressed };
		if (this.#wakeWindowOpen()) return { command: text.trim(), addressed: true };
		if (this.#replyWindowOpen()) return { command: text.trim(), addressed: false };
		return null;
	}

	#showListenStatus(message: string): void {
		if (message === this.#listenStatus) return;
		this.#listenStatus = message;
		this.#streamCallbacks?.showStatus(message);
	}

	#idleListenStatus(): string {
		if (this.#voiceDraft) {
			return this.#replyWindowOpen()
				? "Draft ready · say “send” to submit or “reset” to clear"
				: `Draft ready · say “${this.#wakePhrase}, send” or “${this.#wakePhrase}, reset”`;
		}
		return this.#wakeWords.length > 0
			? `Microphone on · listening for “${this.#wakePhrase} …”`
			: "Microphone on · hands-free dictation";
	}

	/** Whether the editor still holds exactly this controller's draft and preview. After the user
	 *  types or replaces text, clearing or committing the preview would delete their characters. */
	#previewIntact(): boolean {
		const text = this.#streamEditor?.getText?.();
		return text === undefined || text === this.#owned + this.#preview;
	}

	#showPreview(text: string): void {
		const value = text ? `${this.#owned.trim() ? " " : ""}${text}` : "";
		if (value === this.#preview) return;
		this.#preview = value;
		if (value) this.#streamEditor?.setVolatileText(value);
		else this.#streamEditor?.clearVolatileText();
	}

	#openWakeWindow(): void {
		clearTimeout(this.#wakeTimer);
		this.#wakeOpenUntil = Date.now() + this.#wakeTimeoutMs;
		this.#wakeTimer = setTimeout(() => {
			this.#wakeTimer = undefined;
			this.#wakeOpenUntil = null;
			if (!this.#utterance && this.#state === "recording") this.#showListenStatus(this.#idleListenStatus());
		}, this.#wakeTimeoutMs);
		this.#showListenStatus(`“${this.#wakePhrase}” heard · listening for your command`);
	}

	#closeWakeWindow(): void {
		clearTimeout(this.#wakeTimer);
		this.#wakeTimer = undefined;
		this.#wakeOpenUntil = null;
	}

	#dropUtterance(): void {
		clearTimeout(this.#utteranceTimer);
		this.#utteranceTimer = undefined;
		this.#utterance = "";
		this.#utteranceAddressed = false;
		this.#closeWakeWindow();
		this.#showPreview("");
	}

	#cancelStream(): void {
		const stream = this.#stream;
		this.#stream = null;
		stream?.cancel();
	}

	#startVoiceDraft(): void {
		this.#clearVoiceDraft();
		const windowMs = cfgSttConfirmWindowMs.get(this.#settings);
		const wake = this.#wakeWords.length > 0;
		this.#voiceDraft = { until: wake ? Date.now() + windowMs : null };
		if (!wake) return;
		this.#voiceDraftTimer = setTimeout(() => {
			this.#voiceDraftTimer = undefined;
			if (this.#voiceDraft && !this.#utterance && this.#state === "recording") {
				this.#showListenStatus(this.#idleListenStatus());
			}
		}, windowMs);
	}

	#clearVoiceDraft(): void {
		clearTimeout(this.#voiceDraftTimer);
		this.#voiceDraftTimer = undefined;
		this.#voiceDraft = null;
	}

	/** Whether recognition may reach the editor now. An editor emptied by Send or a manual clear
	 *  releases this controller's draft; any other change means the user took over. Unavailable input
	 *  drops the utterance in flight and its native stream, so resuming never replays stale or echoed
	 *  speech. Review and reply checks pause recognition the same way. */
	#acceptContinuousInput(): boolean {
		if (!this.#processingTranscript) {
			const accept = this.#streamCallbacks?.acceptInput;
			if (!accept || accept(this.#owned + this.#preview)) return true;
			if ((this.#owned || this.#preview) && accept("")) {
				this.#owned = "";
				this.#preview = "";
				this.#clearVoiceDraft();
				return true;
			}
		}
		// The user took over: forget the preview without touching their text.
		if (!this.#previewIntact()) this.#preview = "";
		this.#dropUtterance();
		this.#cancelStream();
		if (!this.#processingTranscript) {
			this.#paused = true;
			this.#showListenStatus("Microphone on · listening paused while input is unavailable");
		}
		return false;
	}

	#onContinuousPartial(text: string): void {
		if (!text.trim() || !this.#acceptContinuousInput()) return;
		const heard = this.#heard(text);
		if (!heard) return;
		// Speech resumed: the utterance is not finished yet.
		clearTimeout(this.#utteranceTimer);
		this.#utteranceTimer = undefined;
		if (!heard.command) {
			if (!this.#utterance) this.#showListenStatus(`“${this.#wakePhrase}” heard · listening for your command`);
			return;
		}
		this.#showPreview(joinWords(this.#utterance, heard.command));
		this.#showListenStatus(heard.addressed ? "Listening…" : "Listening for your reply…");
	}

	#onContinuousSegment(text: string): void {
		if (this.#state !== "recording" || !this.#acceptContinuousInput()) return;
		const heard = this.#heard(text);
		if (!heard) {
			if (!this.#utterance) this.#showPreview("");
			return;
		}
		if (!heard.command) {
			// A phrase-only segment: the next speech within the window is the command.
			if (!this.#utterance) this.#openWakeWindow();
			return;
		}
		this.#closeWakeWindow();
		this.#utteranceAddressed ||= heard.addressed;
		this.#utterance = joinWords(this.#utterance, heard.command);
		this.#showPreview(this.#utterance);
		clearTimeout(this.#utteranceTimer);
		this.#utteranceTimer = setTimeout(() => void this.#finishUtterance(), cfgSttUtteranceEndMs.get(this.#settings));
	}

	/** The speaker paused long enough: the utterance is either a reply to a ready draft or new text. */
	async #finishUtterance(): Promise<void> {
		this.#utteranceTimer = undefined;
		const text = this.#utterance;
		const addressed = this.#utteranceAddressed;
		this.#utterance = "";
		this.#utteranceAddressed = false;
		const editor = this.#streamEditor;
		const options = this.#streamCallbacks;
		if (!text || !editor || !options || this.#disposed || !this.#acceptContinuousInput()) return;
		if (this.#voiceDraft) {
			const reply = await this.#classifyReply(text, options);
			if (this.#disposed || this.#streamEditor !== editor) return;
			if (reply === null) {
				this.#showPreview("");
				return;
			}
			if (reply !== "other") {
				this.#applyReply(reply, editor, options);
				return;
			}
			if (!addressed) {
				this.#showPreview("");
				this.#listenStatus = "";
				this.#showListenStatus(`Not a send or reset · ${this.#idleListenStatus()}`);
				return;
			}
		}
		await this.#deliverUtterance(text, editor, options);
	}

	async #classifyReply(text: string, options: SttCallbacks): Promise<VoiceReply | null> {
		const abort = new AbortController();
		this.#reviewAbort = abort;
		this.#processingTranscript = true;
		this.#listenStatus = "";
		options.showStatus("Checking your reply…");
		try {
			const signal = this.#streamAbort ? AbortSignal.any([abort.signal, this.#streamAbort.signal]) : abort.signal;
			const registry = supportsReview(this.#registry) ? this.#registry : undefined;
			return await classifyVoiceReply(text, this.#owned, {
				settings: this.#settings,
				registry,
				sessionId: this.#getSessionId?.(),
				signal,
			});
		} catch (error) {
			if (!this.#disposed && !abort.signal.aborted) {
				options.showWarning(
					`Could not interpret the spoken reply; draft kept. ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return null;
		} finally {
			if (this.#reviewAbort === abort) {
				this.#reviewAbort = null;
				this.#processingTranscript = false;
			}
		}
	}

	#applyReply(reply: "send" | "reset", editor: SttTarget, options: SttCallbacks): void {
		this.#showPreview("");
		this.#listenStatus = "";
		if (editor.getText?.() !== this.#owned || (reply === "reset" && !editor.setText)) {
			options.showWarning("The draft changed before your spoken reply; nothing was sent or cleared.");
			return;
		}
		this.#clearVoiceDraft();
		this.#owned = "";
		if (reply === "send") {
			editor.submit();
			options.showStatus("Sent by voice.");
		} else {
			editor.setText!("");
			options.showStatus("Draft cleared by voice.");
		}
	}

	async #deliverUtterance(text: string, editor: SttTarget, options: SttCallbacks): Promise<void> {
		const confirm = cfgSttConfirmEnabled.get(this.#settings);
		const prefix = this.#owned.trim() ? " " : "";
		if (!this.#reviewEnabled && !confirm && this.#wakeWords.length > 0) {
			// Without review or spoken confirmation, an addressed wake command is sent at once.
			editor.clearVolatileText();
			this.#preview = "";
			editor.commitVolatileText(prefix + text);
			editor.submit();
			this.#owned = "";
			return;
		}
		const ready = confirm
			? "Draft ready · say “send” to submit or “reset” to clear"
			: "Dictation draft · review and press Send.";
		await this.#reviewDraft(text, editor, options, ready, false, prefix);
		if (!this.#disposed && this.#streamEditor === editor && confirm) this.#startVoiceDraft();
	}

	#openStream(modelKey: SttModelKey, language: string): SttStreamHandle {
		const stream = sttClient.startStream(modelKey, {
			language: language || undefined,
			signal: this.#streamAbort?.signal,
			discardTranscript: this.#continuous,
			onPartial: text => {
				if (this.#disposed || this.#stream !== stream || this.#state !== "recording") return;
				if (this.#continuous) this.#onContinuousPartial(text);
				else this.#previewTranscript(text);
			},
			onSegment: text => {
				if (this.#disposed || this.#stream !== stream) return;
				// The worker resets the recognizer at every endpoint, so one stream carries every
				// utterance; reopening it per segment would drop audio queued past the endpoint.
				if (this.#continuous) this.#onContinuousSegment(text);
				else this.#commitTranscriptSegment(text);
			},
		});
		return stream;
	}

	async #startStreaming(
		editor: SttTarget,
		options: SttCallbacks,
		modelKey: SttModelKey,
		wakePhrase: string,
		continuous: boolean,
	): Promise<void> {
		const language = cfgSttLanguage.get(this.#settings);
		this.#streamEditor = editor;
		this.#streamCallbacks = options;
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		const abort = new AbortController();
		this.#streamAbort = abort;
		this.#continuous = continuous;
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
					if (this.#continuous) {
						// Keep what was heard of an unfinished utterance as raw draft text.
						if (this.#preview && this.#previewIntact()) this.#streamEditor?.commitVolatileText(this.#preview);
					} else if (this.#reviewEnabled) {
						const text = joinWords(this.#reviewSegments, this.#reviewPartial);
						if (text) this.#streamEditor?.commitVolatileText(text);
					} else this.#streamEditor?.clearVolatileText();
					this.#cleanupStream();
					this.#setState("idle", options);
					options.showWarning(error.message);
					return;
				}
				if (this.#continuous) {
					if (!this.#acceptContinuousInput()) return;
					if (!this.#stream) {
						this.#stream = this.#openStream(modelKey, language);
						if (this.#paused) {
							this.#paused = false;
							this.#showListenStatus(this.#idleListenStatus());
						}
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
		if (this.#continuous && this.#acceptContinuousInput()) this.#showListenStatus(this.#idleListenStatus());
		logger.debug("STT live recording started", { modelKey, continuous });
	}

	async #stopStreaming(options: SttCallbacks): Promise<void> {
		const stream = this.#stream;
		const recorder = this.#streamRecorder;
		if (this.#continuous) {
			// Toggle-off ends listening, not an utterance: nothing is reviewed or sent, and the
			// worker's ambient transcript is never replayed. Text already heard stays as raw draft.
			this.#setState("transcribing", options);
			try {
				recorder?.stop();
			} catch (err) {
				logger.debug("stt: continuous recorder stop failed", { error: String(err) });
			}
			if (this.#preview && this.#previewIntact()) this.#streamEditor?.commitVolatileText(this.#preview);
			this.#streamAbort?.abort();
			this.#reviewAbort?.abort();
			stream?.cancel();
			this.#cleanupStream();
			this.#setState("idle", options);
			options.showStatus("Listening stopped.");
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
		clearTimeout(this.#utteranceTimer);
		this.#utteranceTimer = undefined;
		this.#closeWakeWindow();
		this.#clearVoiceDraft();
		this.#continuous = false;
		this.#wakePhrase = "";
		this.#wakeWords = [];
		this.#listenStatus = "";
		this.#paused = false;
		this.#utterance = "";
		this.#utteranceAddressed = false;
		this.#preview = "";
		this.#owned = "";
	}

	async #finishTranscript(finalText: string, failed: boolean, options: SttCallbacks): Promise<void> {
		if (this.#reviewEnabled) {
			const text = finalText || joinWords(this.#reviewSegments, this.#reviewPartial);
			this.#reviewSegments = "";
			this.#reviewPartial = "";
			if (text && this.#streamEditor) {
				await this.#reviewDraft(
					text,
					this.#streamEditor,
					options,
					"Dictation draft · review and press Send.",
					failed,
				);
			} else {
				this.#streamEditor?.clearVolatileText();
				if (!failed) options.showStatus("No speech detected.");
			}
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
		if (this.#reviewEnabled && !this.#processingTranscript && !this.#continuous) {
			const text = joinWords(this.#reviewSegments, this.#reviewPartial);
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
