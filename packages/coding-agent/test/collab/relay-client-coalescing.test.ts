import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { generateRoomKey, importRoomKey, open } from "../../src/collab/crypto";
import { type CollabFrame, encodeEventFrame, unpackEnvelope } from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";
import { MAX_REPLICATED_PAYLOAD_BYTES } from "../../src/collab/replication-shrink";
import { type FakeWebSocket, installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const HIGH_WATER_MARK = 64 * 1024;
const MIB = 1024 * 1024;
const DRAIN_FRAME = { t: "bye", reason: "coalescing-test-complete" } as const;
const sockets: CollabSocket[] = [];

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

async function createHarness(guestCount = 1): Promise<Harness> {
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
	const receivers: Receiver[] = [];
	for (let i = 0; i < guestCount; i++) receivers.push(await join("guest"));
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

async function holdPrepared(harness: Harness, frame: CollabFrame): Promise<void> {
	harness.ws.bufferedAmount = HIGH_WATER_MARK;
	harness.host.send(frame);
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

describe("CollabSocket adjacent streaming deltas", () => {
	afterEach(() => {
		for (const socket of sockets.reverse()) socket.close();
		sockets.length = 0;
		vi.restoreAllMocks();
		vi.useRealTimers();
		uninstallInMemoryRelay();
	});

	it("delivers bursts beyond the frame limit without losing delta bytes or retaining caller mutations", async () => {
		const harness = await createHarness();
		await holdPrepared(harness, { t: "error", message: "hold the transport" });
		const types: DeltaEvent["type"][] = ["text_delta", "thinking_delta", "toolcall_delta"];
		const expected = new Map<DeltaEvent["type"], { delta: string; latest: DeltaFrame }>();
		let finalMessage = assistant();
		for (const [turn, type] of types.entries()) {
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
				harness.host.send(frame);
				// Providers reuse and mutate their cumulative messages after each callback.
				frame.event.message.content.length = 0;
				frame.event.message.usage.output = -1;
				frame.event.assistantMessageEvent.delta = "caller mutation";
				frame.event.assistantMessageEvent.partial.content.length = 0;
				frame.event.assistantMessageEvent.partial.usage.output = -2;
			}
			finalMessage = structuredClone(message);
			harness.host.send({ t: "event", event: { type: "message_end", message: finalMessage } });
		}

		await drain(harness);
		const received = harness.receivers[0]!.frames.slice(0, -1);
		for (const type of types) {
			const updates = deltas(received).filter(frame => frame.event.assistantMessageEvent.type === type);
			const result = expected.get(type)!;
			expect(updates.map(frame => frame.event.assistantMessageEvent.delta).join("")).toBe(result.delta);
			expect(updates.at(-1)?.event.message).toEqual(result.latest.event.message);
			expect(updates.at(-1)?.event.assistantMessageEvent.partial).toEqual(
				result.latest.event.assistantMessageEvent.partial,
			);
		}
		expect(received.at(-1)).toEqual({ t: "event", event: { type: "message_end", message: finalMessage } });
		// A cumulative snapshot per token would exceed this by megabytes.
		expect(Buffer.byteLength(JSON.stringify(received))).toBeLessThan(256 * 1024);
	});

	it("coalesces pre-encoded event frames when the host passes the event they carry", async () => {
		const harness = await createHarness();
		await holdPrepared(harness, { t: "error", message: "hold the transport" });
		let cumulative = "";
		let latest = deltaFrame("");
		for (let i = 0; i < 300; i++) {
			cumulative += `${i};`;
			latest = deltaFrame(`${i};`, assistant(cumulative));
			harness.host.send(encodeEventFrame(JSON.stringify(latest.event)), 0, latest.event);
		}

		await drain(harness);
		const updates = deltas(harness.receivers[0]!.frames.slice(0, -1));
		expect(updates.length).toBeLessThan(300);
		expect(updates.map(frame => frame.event.assistantMessageEvent.delta).join("")).toBe(cumulative);
		expect(updates.at(-1)?.event.message).toEqual(latest.event.message);
	});

	it("keeps different streams, recipients, lifecycle events, prompts, and batches in order", async () => {
		const harness = await createHarness(2);
		const blocker: CollabFrame = { t: "error", message: "hold the transport" };
		await holdPrepared(harness, blocker);
		const first = harness.receivers[0]!.ws.peerId;
		const second = harness.receivers[1]!.ws.peerId;
		const expected = new Map<number, CollabFrame[]>([
			[first, [blocker]],
			[second, [blocker]],
		]);
		const send = (frame: CollabFrame, peer = first): void => {
			harness.host.send(frame, peer);
			expected.get(peer)!.push(frame);
		};
		const text = (label: string): DeltaFrame => deltaFrame(label, assistant(label));
		send(text("before-index"));
		const indexed = assistant("unchanged");
		indexed.content.push({ type: "text", text: "different-index" });
		send(deltaFrame("different-index", indexed, "text_delta", 1));
		send(text("before-type"));
		const thinking = assistant();
		thinking.content = [{ type: "thinking", thinking: "different-type" }];
		send(deltaFrame("different-type", thinking, "thinking_delta"));
		send(text("before-timestamp"));
		send(deltaFrame("different-timestamp", assistant("different-timestamp", 2)));
		send(text("before-target"));
		send(text("different-target"), second);
		send(text("after-target"));
		send({ t: "prompt", text: "ordered command" });
		send(text("after-prompt"));
		send({
			t: "event",
			event: {
				type: "message_update",
				message: assistant(),
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: assistant() },
			},
		});
		send(text("after-start"));
		send({
			t: "event",
			event: {
				type: "message_update",
				message: assistant("ended"),
				assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ended", partial: assistant("ended") },
			},
		});
		send(text("after-end"));
		send({ t: "event", event: { type: "message_start", message: assistant() } });
		send(text("after-message-start"));
		send({ t: "event", event: { type: "message_end", message: assistant("ended") } });
		send(text("before-batch"));
		const batch = [text("batch-first"), text("batch-last")];
		harness.host.sendBatch(batch, first);
		expected.get(first)!.push(...batch);
		send(text("after-batch"));

		await drain(harness);
		for (const receiver of harness.receivers) {
			expect(receiver.frames.slice(0, -1)).toEqual(expected.get(receiver.ws.peerId)!);
		}
	});

	it("keeps a pre-replacement flush pending until the latest snapshot is sealed for graceful close", async () => {
		const harness = await createHarness();
		const first = deltaFrame("first", assistant("first"));
		await holdPrepared(harness, first);
		harness.host.send(deltaFrame("second", assistant("firstsecond")));
		let flushed = false;
		const captured = harness.host.flush().then(() => {
			flushed = true;
		});
		const latest = deltaFrame("third", assistant("firstsecondthird"));
		harness.host.send(latest);

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
			expect(updates.map(frame => frame.event.assistantMessageEvent.delta).join("")).toBe("firstsecondthird");
			expect(updates.at(-1)?.event.message).toEqual(latest.event.message);
			expect(updates.at(-1)?.event.assistantMessageEvent.partial).toEqual(
				latest.event.assistantMessageEvent.partial,
			);
		} finally {
			release.resolve();
		}
	});

	it("does not replace a delta already being encrypted with later adjacent deltas", async () => {
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
			harness.host.send(first);
			await sealing.promise;
			harness.host.send(deltaFrame("b", assistant("ab")));
			const latest = deltaFrame("c", assistant("abc"));
			harness.host.send(latest);
			release.resolve();
			await drain(harness);
			const updates = deltas(harness.receivers[0]!.frames);
			expect(updates[0]).toEqual(first);
			expect(updates.map(frame => frame.event.assistantMessageEvent.delta).join("")).toBe("abc");
			expect(updates.at(-1)?.event.message).toEqual(latest.event.message);
		} finally {
			release.resolve();
		}
	});

	it("settles flush when a coalesced peer is dropped and refunds the replacement's byte charge", async () => {
		const harness = await createHarness(2);
		const blocker: CollabFrame = { t: "error", message: "hold the transport" };
		await holdPrepared(harness, blocker);
		const departed = harness.receivers[0]!.ws.peerId;
		const survivor = harness.receivers[1]!.ws.peerId;
		// Each update contains the cumulative message twice. Fifteen replacements
		// occupy about 13 MiB; charging both old and new snapshots would exceed 20 MiB.
		const older = "x".repeat(256 * 1024);
		const newer = "x".repeat(450 * 1024);
		harness.host.send(deltaFrame("a", assistant(older, 0)), departed);
		const captured = harness.host.flush();
		for (let turn = 0; turn < 15; turn++) {
			if (turn > 0) harness.host.send(deltaFrame("a", assistant(older, turn)), departed);
			harness.host.send(deltaFrame("b", assistant(newer, turn)), departed);
		}
		expect(harness.closes).toEqual([]);
		harness.host.dropPeer(departed);
		await captured;
		// Refunding only the original snapshots leaves over five MiB of phantom bytes.
		harness.host.send({ t: "prompt", text: "y".repeat(11 * MIB) }, survivor);
		expect(harness.closes).toEqual([]);
		harness.host.dropPeer(survivor);
		await harness.host.flush();
		const next: CollabFrame = { t: "prompt", text: "next guest still receives commands" };
		harness.host.send(next, survivor);
		await drain(harness);
		expect(harness.receivers[0]!.frames.slice(0, -1)).toEqual([blocker]);
		expect(harness.receivers[1]!.frames.slice(0, -1)).toEqual([blocker, next]);
	});

	it("splits bounded replacements without dropping or reordering deltas at the payload ceiling", async () => {
		const harness = await createHarness();
		await holdPrepared(harness, { t: "error", message: "hold the transport" });
		let cumulative = "";
		for (let i = 0; i < 14; i++) {
			const piece = `${i.toString().padStart(2, "0")}${"x".repeat(32 * 1024 - 2)}`;
			cumulative += piece;
			const frame = deltaFrame(piece, assistant(cumulative));
			expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(MAX_REPLICATED_PAYLOAD_BYTES);
			harness.host.send(frame);
		}
		const final: CollabFrame = { t: "event", event: { type: "message_end", message: assistant(cumulative) } };
		harness.host.send(final);
		await drain(harness);
		const received = harness.receivers[0]!.frames.slice(0, -1);
		const updates = deltas(received);
		for (const frame of updates) {
			expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
		}
		expect(updates.map(frame => frame.event.assistantMessageEvent.delta).join("")).toBe(cumulative);
		expect(updates.at(-1)?.event.message).toEqual(assistant(cumulative));
		expect(received.at(-1)).toEqual(final);
	});

	it("sheds the backlog and resyncs once drained when a bounded replacement grows the queue past its byte limit", async () => {
		const harness = await createHarness();
		let resyncs = 0;
		harness.host.onResync = () => {
			resyncs++;
		};
		await holdPrepared(harness, { t: "error", message: "hold the transport" });
		harness.host.send({ t: "prompt", text: "x".repeat(15 * MIB + MIB / 2) });
		harness.host.send(deltaFrame("a", assistant("x".repeat(128 * 1024))));
		harness.host.send(deltaFrame("b", assistant("x".repeat(400 * 1024))));
		// Dropped while recovering: nothing may refill the queue before the resync.
		harness.host.send(deltaFrame("c", assistant("c")));
		expect(resyncs).toBe(0);

		await drain(harness);
		expect(harness.closes).toEqual([]);
		expect(harness.host.isOpen).toBe(true);
		expect(resyncs).toBe(1);
		expect(deltas(harness.receivers[0]!.frames)).toEqual([]);
	});
});
