import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

/** More than the socket's 256 pending sends, emitted synchronously: no send can drain in between. */
const BURST = 1000;

interface Notice {
	level: string;
	message: string;
}

function makeHostContext(eventBus: EventBus, notices: Notice[]): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(),
		session: {
			isStreaming: false,
			isAborting: false,
			isSessionTransitioning: false,
			queuedMessageCount: 0,
			sessionName: "host session",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: (level: string, message: string) => notices.push({ level, message }),
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

function lifecycle(index: number): Record<string, unknown> {
	return {
		id: `Burst${index}`,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		parentToolCallId: `call-${index}`,
		index,
	};
}

/**
 * Waits for a frame-level condition. Delivery crosses real WebCrypto sealing and
 * the in-memory relay's async dispatch, which fake timers cannot drive.
 */
async function until(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message);
		await Bun.sleep(5);
	}
}

/** Whether a marker bus frame (emitted after a burst) has arrived; FIFO puts any earlier frame ahead of it. */
function hasMarker(frames: CollabFrame[], id: string): boolean {
	return frames.some(
		frame =>
			frame.t === "bus" &&
			typeof frame.data === "object" &&
			frame.data !== null &&
			"id" in frame.data &&
			frame.data.id === id,
	);
}

interface Guest {
	socket: CollabSocket;
	frames: CollabFrame[];
	closes: string[];
}

async function joinGuest(host: CollabHost): Promise<Guest> {
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	const guest: Guest = { socket, frames: [], closes: [] };
	socket.onFrame = frame => guest.frames.push(frame);
	socket.onClose = reason => guest.closes.push(reason);
	socket.onOpen = () => {
		socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: "probe-guest",
			writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
		});
	};
	socket.connect();
	await until(() => guest.frames.some(frame => frame.t === "snapshot-chunk" && frame.final), "guest never welcomed");
	return guest;
}

function count(frames: CollabFrame[], t: CollabFrame["t"]): number {
	return frames.filter(frame => frame.t === t).length;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab host send backlog", () => {
	it("keeps sharing through a burst while no guest is connected, and a later joiner still gets current state", async () => {
		const bus = new EventBus();
		const notices: Notice[] = [];
		const host = new CollabHost(makeHostContext(bus, notices));
		await host.start("ws://localhost:8788");
		try {
			for (let i = 0; i < BURST; i++) bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle(i));

			// Joining proves the room survived the burst.
			const guest = await joinGuest(host);
			// Nothing from before the join is replayed live; the welcome covers it.
			expect(count(guest.frames, "bus")).toBe(0);
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle(BURST));
			await until(() => hasMarker(guest.frames, `Burst${BURST}`), "post-join frame not delivered");
			expect(count(guest.frames, "bus")).toBe(1);
			expect(count(guest.frames, "welcome")).toBe(1);
			expect(notices.filter(notice => notice.level === "warning")).toEqual([]);
			expect(host.relayConnected).toBe(true);
			guest.socket.close();
		} finally {
			await host.stop("test cleanup").catch(() => {});
		}
	}, 20_000);

	it("resyncs connected guests instead of ending sharing when a burst overflows the backlog", async () => {
		const bus = new EventBus();
		const notices: Notice[] = [];
		const host = new CollabHost(makeHostContext(bus, notices));
		await host.start("ws://localhost:8788");
		try {
			const guest = await joinGuest(host);
			expect(count(guest.frames, "welcome")).toBe(1);

			for (let i = 0; i < BURST; i++) bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle(i));
			await until(() => count(guest.frames, "welcome") === 2, "guest was not resynced");
			const resync = guest.frames.findLastIndex(frame => frame.t === "welcome");
			await until(
				() => guest.frames.slice(resync).some(frame => frame.t === "snapshot-chunk" && frame.final),
				"resync snapshot incomplete",
			);

			// The overflowing burst was shed, not partly delivered after the resync.
			expect(guest.frames.slice(resync).some(frame => frame.t === "bus")).toBe(false);
			expect(count(guest.frames, "bus")).toBeLessThan(BURST);
			expect(notices.filter(notice => notice.level === "warning")).toEqual([]);
			expect(guest.closes).toEqual([]);
			expect(host.relayConnected).toBe(true);

			// Live traffic flows again after the resync.
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle(BURST));
			await until(() => hasMarker(guest.frames.slice(resync), `Burst${BURST}`), "post-resync frame not delivered");
			guest.socket.close();
		} finally {
			await host.stop("test cleanup").catch(() => {});
		}
	}, 20_000);

	it("survives repeated overflow bursts with one resync per drain", async () => {
		const bus = new EventBus();
		const notices: Notice[] = [];
		const host = new CollabHost(makeHostContext(bus, notices));
		await host.start("ws://localhost:8788");
		try {
			const guest = await joinGuest(host);
			for (let round = 1; round <= 5; round++) {
				for (let i = 0; i < BURST; i++) bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle(i));
				await until(() => count(guest.frames, "welcome") === round + 1, `round ${round} not resynced`);
			}
			// A marker after the last burst flushes anything still queued ahead of it,
			// including a duplicate resync.
			bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle(BURST));
			await until(() => hasMarker(guest.frames, `Burst${BURST}`), "post-burst marker not delivered");
			expect(count(guest.frames, "welcome")).toBe(6);
			expect(notices.filter(notice => notice.level === "warning")).toEqual([]);
			expect(host.relayConnected).toBe(true);
			guest.socket.close();
		} finally {
			await host.stop("test cleanup").catch(() => {});
		}
	}, 20_000);
});
