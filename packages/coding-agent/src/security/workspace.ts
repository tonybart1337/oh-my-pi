import * as path from "node:path";
import { resolveToCwd } from "../tools/path-utils";

/** Roots whose scans `security://scans` lists: the working directory, then `/add-dir` workspace directories. */
export function securityWorkspaceRoots(cwd: string, additionalDirectories: readonly string[] = []): string[] {
	return [...new Set([cwd, ...additionalDirectories].map(dir => path.resolve(dir)))];
}

/**
 * Directory whose Git repository a security operation targets: the working
 * directory, or any requested checkout (another repository, a fresh worktree).
 * Approval of the `exec`-tier operation is the consent boundary.
 */
export function resolveSecurityRepository(cwd: string, requested: string | undefined): string {
	return requested?.trim() ? resolveToCwd(requested.trim(), cwd) : path.resolve(cwd);
}
