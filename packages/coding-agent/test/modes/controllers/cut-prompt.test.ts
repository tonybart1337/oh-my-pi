import { afterEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { createPromptActionAutocompleteProvider } from "@oh-my-pi/pi-coding-agent/autocomplete/prompt-actions";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { Composer } from "../../../src/ui/composer/composer";

function cutContext(text: string) {
	const composer = new Composer();
	composer.setText(text);
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const ctx = { composer, showStatus, showWarning } as unknown as InteractiveModeContext;
	return { controller: new InputController(ctx), composer, showStatus, showWarning };
}

describe("'#' Cut whole prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is offered among the prompt actions and runs the host's cut", async () => {
		const cutPrompt = vi.fn();
		const noop = () => {};
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: KeybindingsManager.inMemory(),
			copyCurrentLine: noop,
			copyPrompt: noop,
			cutPrompt,
			undo: noop,
			moveCursorToMessageEnd: noop,
			moveCursorToMessageStart: noop,
			moveCursorToLineStart: noop,
			moveCursorToLineEnd: noop,
		});
		const suggestions = await provider.getSuggestions(["#cut"], 0, 4);
		const item = suggestions?.items.find(entry => entry.label === "Cut whole prompt");
		expect(item).toBeDefined();
		provider.applyCompletion(["#cut"], 0, 4, item!, suggestions!.prefix).onApplied?.();
		expect(cutPrompt).toHaveBeenCalledTimes(1);
	});

	it("copies the composer's draft to the clipboard and clears it", () => {
		const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const { controller, composer, showStatus } = cutContext("draft to move elsewhere");
		controller.handleCutPrompt();
		expect(copy).toHaveBeenCalledWith("draft to move elsewhere");
		expect(composer.text()).toBe("");
		expect(showStatus).toHaveBeenCalledWith("Cut: draft to move elsewhere");
	});

	it("keeps the draft when the clipboard refuses it", () => {
		vi.spyOn(clipboard, "copyToClipboard").mockImplementation(() => {
			throw new Error("no clipboard");
		});
		const { controller, composer, showWarning } = cutContext("keep me");
		controller.handleCutPrompt();
		expect(composer.text()).toBe("keep me");
		expect(showWarning).toHaveBeenCalledWith("Failed to copy to clipboard");
	});
});
