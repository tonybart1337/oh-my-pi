import * as path from "node:path";
import { resolveToCwd } from "../tools/path-utils";

/** Roots a session may scan: its working directory, then its `/add-dir` workspace directories. */
export function securityWorkspaceRoots(cwd: string, additionalDirectories: readonly string[] = []): string[] {
	return [...new Set([cwd, ...additionalDirectories].map(dir => path.resolve(dir)))];
}

/**
 * Directory whose Git repository a security operation targets. Defaults to the
 * working directory; an explicit path must lie within a workspace root, so a
 * scan reaches another repository only after `/add-dir` admitted it.
 */
export function resolveSecurityRepository(
	cwd: string,
	additionalDirectories: readonly string[] | undefined,
	requested: string | undefined,
): string {
	if (!requested?.trim()) return path.resolve(cwd);
	const resolved = resolveToCwd(requested.trim(), cwd);
	const roots = securityWorkspaceRoots(cwd, additionalDirectories);
	if (!roots.some(root => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
		throw new Error(
			`Security repository ${resolved} is outside this session's workspace; add it with /add-dir first`,
		);
	}
	return resolved;
}
