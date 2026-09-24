import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { generateRoomKey, importRoomKey, open } from "../../src/collab/crypto";
import { CollabHost } from "../../src/collab/host";
import {
	COLLAB_PROTO,
	type CollabFrame,
	encodeEventFrame,
	parseCollabLink,
	unpackEnvelope,
} from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";
import { MAX_REPLICATED_PAYLOAD_BYTES } from "../../src/collab/replication-shrink";
import type { AgentSessionEvent, AgentSessionEventListener } from "../../src/session/agent-session-events";
import { type FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import {
	type HostObservations,
	instrumentRelay,
	makeHostContext,
	type Snapshot,
	waitFor,
} from "./helpers/throttled-host";

const HIGH_WATER_MARK = 64 * 1024;
const DRAIN_FRAME = { t: "bye", reason: "coalescing-test-complete" } as const;
const KEY = "message_update:1";
const sockets: CollabSocket[] = [];
const cleanups: (() => void)[] = [];

type DeltaEvent = Extract<AssistantMessageEvent, { delta: string }>;
type DeltaFrame = {
	t: "event";
	event: { type: "message_update"; message: AssistantMessage; assistantMessageEvent: DeltaEvent };
};

interface Receiver {
	socket: CollabSocket;
	ws: FakeWebSocket;
	frames: CollabFrame[];
	drained: Promise<void>;
}

interface Harness {
	host: CollabSocket;
	ws: FakeWebSocket;
	key: CryptoKey;
	receivers: Receiver[];
	closes: { reason: string; reconnect: boolean }[];
	closed: Promise<void>;
}

async function createHarness(): Promise<Harness> {
	vi.useFakeTimers();
	const relay = installInMemoryRelay();
	const connected = vi.spyOn(relay, "connect");
	const key = await importRoomKey(generateRoomKey());
	async function join(role: "host" | "guest"): Promise<Receiver> {
		const socket = new CollabSocket({ wsUrl: "ws://localhost:8788/r/coalescing", role, key });
		sockets.push(socket);
		const ready = Promise.withResolvers<void>();
		const drained = Promise.withResolvers<void>();
		const frames: CollabFrame[] = [];
		socket.onOpen = ready.resolve;
		socket.onFrame = frame => {
			frames.push(frame);
			if (frame.t === "bye" && frame.reason === DRAIN_FRAME.reason) drained.resolve();
		};
		socket.connect();
		await ready.promise;
		const ws = connected.mock.calls.at(-1)?.[0];
		if (!ws) throw new Error("socket did not join the in-memory relay");
		return { socket, ws, frames, drained: drained.promise };
	}
	const host = await join("host");
	const receivers = [await join("guest")];
	const closes: Harness["closes"] = [];
	const closed = Promise.withResolvers<void>();
	host.socket.onClose = (reason, reconnect) => {
		closes.push({ reason, reconnect });
		closed.resolve();
	};
	return { host: host.socket, ws: host.ws, key, receivers, closes, closed: closed.promise };
}

function assistant(text = "", timestamp = 1): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "streaming-fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function deltaFrame(
	delta: string,
	message = assistant(delta),
	type: DeltaEvent["type"] = "text_delta",
	contentIndex = 0,
): DeltaFrame {
	const partial = structuredClone(message);
	partial.duration = message.usage.output;
	return {
		t: "event",
		event: {
			type: "message_update",
			message: structuredClone(message),
			assistantMessageEvent: { type, contentIndex, delta, partial },
		},
	};
}

function deltas(frames: CollabFrame[]): DeltaFrame[] {
	return frames.filter(
		(frame): frame is DeltaFrame =>
			frame.t === "event" &&
			frame.event.type === "message_update" &&
			frame.event.message.role === "assistant" &&
			(frame.event.assistantMessageEvent.type === "text_delta" ||
				frame.event.assistantMessageEvent.type === "thinking_delta" ||
				frame.event.assistantMessageEvent.type === "toolcall_delta"),
	);
}

function joined(updates: DeltaFrame[]): string {
	return updates.map(frame => frame.event.assistantMessageEvent.delta).join("");
}

/** Leaves `frame` sealed at the queue head, waiting on backpressure, so later sends stay queued. */
async function holdPrepared(harness: Harness, send: () => void): Promise<void> {
	harness.ws.bufferedAmount = HIGH_WATER_MARK;
	send();
	await harness.host.flush();
}

async function drain(harness: Harness): Promise<void> {
	harness.host.send(DRAIN_FRAME);
	harness.ws.bufferedAmount = 0;
	vi.advanceTimersByTime(25);
	await Promise.race([Promise.all(harness.receivers.map(receiver => receiver.drained)), harness.closed]);
	expect(harness.closes).toEqual([]);
	for (const receiver of harness.receivers) expect(receiver.frames.at(-1)).toEqual(DRAIN_FRAME);
}

describe("CollabSocket.sendLatest streaming deltas", () => {
	afterEach(() => {
		for (const socket of sockets.reverse()) socket.close();
		sockets.length = 0;
		vi.restoreAllMocks();
		vi.useRealTimers();
		uninstallInMemoryRelay();
	});

	it("folds superseded deltas into the newest update without retaining caller mutations", async () => {
		const harness = await createHarness();
		await holdPrepared(harness, () => harness.host.send({ t: "error", message: "hold the transport" }));
		const types: DeltaEvent["type"][] = ["text_delta", "thinking_delta", "toolcall_delta"];
		const expected = new Map<DeltaEvent["type"], { delta: string; latest: DeltaFrame }>();
		for (const [turn, type] of types.entries()) {
			const key = `message_update:${turn}`;
			const message = assistant("", turn + 1);
			harness.host.send({ t: "event", event: { type: "message_start", message: structuredClone(message) } });
			let cumulative = "";
			let concatenated = "";
			for (let i = 0; i < 300; i++) {
				const piece = type === "toolcall_delta" ? String.fromCharCode(97 + (i % 26)) : `${i}:é"\\\n`;
				cumulative += piece;
				const delta =
					type === "toolcall_delta" ? `${i === 0 ? '{"command":"' : ""}${piece}${i === 299 ? '"}' : ""}` : piece;
				concatenated += delta;
				message.content =
					type === "text_delta"
						? [{ type: "text", text: cumulative }]
						: type === "thinking_delta"
							? [{ type: "thinking", thinking: cumulative }]
							: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: cumulative } }];
				message.usage.output = i + 1;
				const frame = deltaFrame(delta, message, type);
				if (i === 299) expected.set(type, { delta: concatenated, latest: structuredClone(frame) });
				harness.host.sendLatest(key, frame);
				// Providers reuse and mutate their cumulative messages after each callback.
				frame.event.message.content.length = 0;
				frame.event.message.usage.output = -1;
				frame.event.assistantMessageEvent.delta = "caller mutation";
				frame.event.assistantMessageEvent.partial.content.length = 0;
				frame.event.assistantMessageEvent.partial.usage.output = -2;
			}
			harness.host.send({ t: "event", event: { type: "message_end", message: structuredClone(message) } });
		}

		await drain(harness);
		const received = harness.receivers[0]!.frames.slice(0, -1);
		for (const type of types) {
			const updates = deltas(received).filter(frame => frame.event.assistantMessageEvent.type === type);
			const result = expected.get(type)!;
			// Superseded: one update per message survives, carrying every fragment.
			expect(updates).toHaveLength(1);
			expect(joined(updates)).toBe(result.delta);
			expect(updates[0]!.event.message).toEqual(result.latest.event.message);
			expect(updates[0]!.event.assistantMessageEvent.partial).toEqual(
				result.latest.event.assistantMessageEvent.partial,
			);
		}
	});

	it("folds pre-encoded frames when the caller passes the event they carry", async () => {
		const harness = await createHarness();
		await holdPrepared(harness, () => harness.host.send({ t: "error", message: "hold the transport" }));
		let cumulative = "";
		let latest = deltaFrame("");
		for (let i = 0; i < 300; i++) {
			cumulative += `${i};`;
			latest = deltaFrame(`${i};`, assistant(cumulative));
			harness.host.sendLatest(KEY, encodeEventFrame(JSON.stringify(latest.event)), latest.event);
		}

		await drain(harness);
		const updates = deltas(harness.receivers[0]!.frames.slice(0, -1));
		expect(updates).toHaveLength(1);
		expect(joined(updates)).toBe(cumulative);
		expect(updates[0]!.event.message).toEqual(latest.event.message);
	});

	it("never folds a delta into another content block, delta type, or message", async () => {
		const harness = await createHarness();
		await holdPrepared(harness, () => harness.host.send({ t: "error", message: "hold the transport" }));
		harness.host.sendLatest(KEY, deltaFrame("text", assistant("text")));
		const tool = assistant("text");
		tool.content.push({ type: "toolCall", id: "call-1", name: "bash", arguments: {} });
		harness.host.sendLatest(KEY, deltaFrame("{", tool, "toolcall_delta", 1));
		harness.host.sendLatest("message_update:2", deltaFrame("next", assistant("next", 2)));

		await drain(harness);
		const updates = deltas(harness.receivers[0]!.frames.slice(0, -1));
		expect(updates.map(frame => frame.event.assistantMessageEvent.delta)).toEqual(["{", "next"]);
		expect(updates[0]!.event.message).toEqual(tool);
	});

	it("keeps a flush that covered a superseded frame pending until its successor is sealed", async () => {
		const harness = await createHarness();
		const first = deltaFrame("first", assistant("first"));
		await holdPrepared(harness, () => harness.host.sendLatest(KEY, first));
		harness.host.sendLatest(KEY, deltaFrame("second", assistant("firstsecond")));
		let flushed = false;
		const captured = harness.host.flush().then(() => {
			flushed = true;
		});
		const latest = deltaFrame("third", assistant("firstsecondthird"));
		harness.host.sendLatest(KEY, latest);

		const sealing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
		vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(
			async (...args: Parameters<typeof crypto.subtle.encrypt>) => {
				sealing.resolve();
				await release.promise;
				return realEncrypt(...args);
			},
		);
		const realSend = harness.ws.send.bind(harness.ws);
		const writes = vi.spyOn(harness.ws, "send").mockImplementation(bytes => {
			realSend(bytes);
			harness.ws.bufferedAmount = HIGH_WATER_MARK;
		});
		try {
			harness.ws.bufferedAmount = 0;
			vi.advanceTimersByTime(25);
			await sealing.promise;
			expect(flushed).toBe(false);
			release.resolve();
			await captured;
			harness.host.close();
			const delivered: CollabFrame[] = [];
			for (const [bytes] of writes.mock.calls) {
				const envelope = unpackEnvelope(bytes)!;
				delivered.push(await open(harness.key, envelope.payload));
			}
			const updates = deltas(delivered);
			expect(updates[0]).toEqual(first);
			expect(joined(updates)).toBe("firstsecondthird");
			expect(updates.at(-1)?.event.message).toEqual(latest.event.message);
		} finally {
			release.resolve();
		}
	});

	it("does not fold the queue head, which may already be sealing", async () => {
		const harness = await createHarness();
		const sealing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
		vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(
			async (...args: Parameters<typeof crypto.subtle.encrypt>) => {
				sealing.resolve();
				await release.promise;
				return realEncrypt(...args);
			},
		);
		const first = deltaFrame("a", assistant("a"));
		try {
			harness.host.sendLatest(KEY, first);
			await sealing.promise;
			harness.host.sendLatest(KEY, deltaFrame("b", assistant("ab")));
			const latest = deltaFrame("c", assistant("abc"));
			harness.host.sendLatest(KEY, latest);
			release.resolve();
			await drain(harness);
			const updates = deltas(harness.receivers[0]!.frames);
			expect(updates.map(frame => frame.event.assistantMessageEvent.delta)).toEqual(["a", "bc"]);
			expect(updates.at(-1)?.event.message).toEqual(latest.event.message);
		} finally {
			release.resolve();
		}
	});

	it("skips a fold that would pass the payload ceiling and still sends the newest snapshot", async () => {
		const harness = await createHarness();
		await holdPrepared(harness, () => harness.host.send({ t: "error", message: "hold the transport" }));
		let cumulative = "";
		let lastPiece = "";
		for (let i = 0; i < 14; i++) {
			lastPiece = `${i.toString().padStart(2, "0")}${"x".repeat(32 * 1024 - 2)}`;
			cumulative += lastPiece;
			const frame = deltaFrame(lastPiece, assistant(cumulative));
			expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(MAX_REPLICATED_PAYLOAD_BYTES);
			harness.host.sendLatest(KEY, frame);
		}

		await drain(harness);
		const updates = deltas(harness.receivers[0]!.frames.slice(0, -1));
		expect(updates).toHaveLength(1);
		expect(Buffer.byteLength(JSON.stringify(updates[0]))).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
		expect(updates[0]!.event.message).toEqual(assistant(cumulative));
		// The fold restarts from the update that could not carry its predecessors.
		const delta = updates[0]!.event.assistantMessageEvent.delta;
		expect(delta.endsWith(lastPiece)).toBe(true);
		expect(cumulative.endsWith(delta)).toBe(true);
		expect(delta.length).toBeLessThan(cumulative.length);
	});
});

describe("CollabHost streaming deltas", () => {
	afterEach(() => {
		for (const cleanup of cleanups.splice(0).reverse()) cleanup();
		uninstallInMemoryRelay();
	});

	it("delivers every text fragment of an answer that outpaces the uplink", async () => {
		const relay = installInMemoryRelay();
		const probe = instrumentRelay(relay, { throttle: true });
		const snapshot: Snapshot = {
			header: { type: "session", id: "stream", timestamp: "2026-10-27T00:00:00Z", cwd: "/tmp" },
			entries: [],
		};
		const seen: HostObservations = { notices: [], participantCounts: [] };
		const ctx = makeHostContext(snapshot, seen);
		const listeners: AgentSessionEventListener[] = [];
		const subscribe = ctx.session.subscribe.bind(ctx.session);
		ctx.session.subscribe = listener => {
			listeners.push(listener);
			return subscribe(listener);
		};
		const emit = (event: AgentSessionEvent) => {
			for (const listener of listeners.slice()) listener(event);
		};
		const host = new CollabHost(ctx);
		cleanups.push(() => void host.stop("test done"));
		await host.start("ws://localhost:8788");
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(parsed.key);
		const hostWs = probe.hostSocket();

		const guest = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		cleanups.push(() => guest.close());
		const events: AgentSessionEvent[] = [];
		const welcomed = Promise.withResolvers<void>();
		guest.onFrame = (frame: CollabFrame) => {
			if (frame.t === "welcome") welcomed.resolve();
			if (frame.t === "event") events.push(frame.event as AgentSessionEvent);
		};
		guest.onOpen = () => guest.send({ t: "hello", proto: COLLAB_PROTO, name: "watcher" });
		guest.connect();
		await welcomed.promise;
		await waitFor(() => seen.participantCounts.some(count => count > 0), "host never registered the guest");

		let text = "";
		emit({ type: "message_start", message: assistant("", 0) });
		for (let i = 0; i < 600; i++) {
			const chunk = `${i} geology of the Carpathian basin; `;
			text += chunk;
			const message = assistant(text, 0);
			emit({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk, partial: message },
			});
		}
		emit({ type: "message_end", message: assistant(text, 0) });

		const throttledSend = hostWs.send.bind(hostWs);
		hostWs.send = data => {
			throttledSend(data);
			hostWs.bufferedAmount = 0;
		};
		hostWs.bufferedAmount = 0;
		await waitFor(() => events.some(event => event.type === "message_end"), "guest never received message_end");

		const updates = events.filter(
			(event): event is Extract<AgentSessionEvent, { type: "message_update" }> => event.type === "message_update",
		);
		expect(updates.length).toBeLessThan(20);
		const fragments = updates.map(event =>
			event.assistantMessageEvent.type === "text_delta" ? event.assistantMessageEvent.delta : "",
		);
		expect(fragments.join("")).toBe(text);
		expect(seen.notices.filter(notice => notice.includes("Collab ended"))).toEqual([]);
	}, 15_000);
});
