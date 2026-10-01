/**
 * Check for and install updates.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import { CliUsageError } from "../cli/usage-error";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
		canary: Flags.boolean({ description: "Switch to the canary channel and update", default: false }),
		stable: Flags.boolean({ description: "Switch back to the stable channel", default: false }),
	};

	static examples = [
		"omp update",
		"omp update --check",
		"omp update --canary",
		"# If GitHub rate-limits release metadata, set GITHUB_TOKEN or GH_TOKEN\n  GITHUB_TOKEN=... omp update",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.canary && flags.stable) throw new CliUsageError("--canary and --stable are mutually exclusive");
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
		} else {
			// Fork build: omp-fork rebuilds this binary from upstream releases plus the
			// fork's patches. Upstream's updater would replace it with an unpatched release.
			if (flags.canary || flags.stable || flags.force) {
				throw new CliUsageError("This omp is a fork build; --canary/--stable/--force are not supported");
			}
			const command = ["omp-fork", flags.check ? "status" : "update"];
			let proc: Bun.Subprocess;
			try {
				proc = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"] });
			} catch (err) {
				throw new Error(`This omp is a fork build; updates run through \`${command.join(" ")}\``, { cause: err });
			}
			process.exitCode = await proc.exited;
		}
	}
}
