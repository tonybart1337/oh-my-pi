import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { ModelRegistry } from "../../src/config/model-registry";
import type { CodexSecurityCloudFetch } from "../../src/security";
import {
	CodexSecurityCloudClient,
	CodexSecurityCloudHttpError,
	createCodexSecurityCloudClient,
	pullCodexSecurityCloudResults,
	SecurityStore,
} from "../../src/security";
import { AuthStorage } from "../../src/session/auth-storage";

const ACCOUNT = { provider: "openai-codex", credentialId: 42, accountId: "workspace-a" } as const;

function jwt(subject = "user-a"): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function authStorage(accessToken = jwt()): AuthStorage {
	return {
		oauth: {
			accessById: async (_provider: string, credentialId: number) => ({
				ok: true as const,
				accessToken,
				credentialId,
				accountId: "workspace-a",
			}),
		},
	} as unknown as AuthStorage;
}

function configuration() {
	return {
		id: "config-source",
		hid: "config-public",
		created_at: "2026-07-29T00:00:00.000Z",
		updated_at: "2026-07-29T00:05:00.000Z",
		current_step: "waiting_for_new_commits",
		scans_remaining: 4,
		total_scans: 5,
		scan_input: {
			environment_id: "env-a",
			repo_id: "repo-a",
			repo_url: "https://github.com/example/repository",
			state: "enabled",
		},
	};
}

describe("Codex Security cloud client", () => {
	test("pins one account and refreshes the same credential once after a 401", async () => {
		const resolutions: Array<{ forceRefresh: boolean; refreshReason?: string }> = [];
		const requests: Array<{ authorization: string | null; accountId: string | null }> = [];
		const storage = {
			oauth: {
				accessById: async (
					_provider: string,
					credentialId: number,
					options: { forceRefresh: boolean; refreshReason?: string },
				) => {
					resolutions.push({ forceRefresh: options.forceRefresh, refreshReason: options.refreshReason });
					return {
						ok: true as const,
						accessToken: options.forceRefresh ? "refreshed-token" : "initial-token",
						credentialId,
						accountId: "workspace-a",
					};
				},
			},
		} as unknown as AuthStorage;
		let attempt = 0;
		const fetchMock: CodexSecurityCloudFetch = async (_input, init) => {
			const headers = new Headers(init?.headers);
			requests.push({
				authorization: headers.get("Authorization"),
				accountId: headers.get("ChatGPT-Account-Id"),
			});
			attempt += 1;
			return attempt === 1 ? json({}, 401) : json({ items: [configuration()], total_in_account: 1 });
		};
		const client = new CodexSecurityCloudClient({
			authStorage: storage,
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: fetchMock,
		});

		const page = await client.listConfigurations();

		expect(resolutions).toEqual([
			{ forceRefresh: false, refreshReason: undefined },
			{ forceRefresh: true, refreshReason: "auth-recovery" },
		]);
		expect(requests).toEqual([
			{ authorization: "Bearer initial-token", accountId: "workspace-a" },
			{ authorization: "Bearer refreshed-token", accountId: "workspace-a" },
		]);
		expect(page.items[0]).toMatchObject({
			id: "config-public",
			sourceId: "config-source",
			repositoryId: "repo-a",
			environmentId: "env-a",
			remainingScans: 4,
		});
	});

	test("creates the documented cloud scan configuration without runtime attribution spoofing", async () => {
		let requestUrl = "";
		let requestBody: unknown;
		const fetchMock: CodexSecurityCloudFetch = async (input, init) => {
			requestUrl = String(input);
			requestBody = JSON.parse(String(init?.body));
			return json(configuration());
		};
		const client = new CodexSecurityCloudClient({
			authStorage: authStorage(jwt("user-exact")),
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: fetchMock,
		});

		await client.startScan({
			repositoryId: "repo-a",
			repositoryUrl: "https://github.com/example/repository",
			environmentId: "env-a",
			lookbackDays: "all",
		});

		expect(requestUrl).toBe("https://example.test/backend-api/aardvark/scan_configurations");
		expect(requestBody).toEqual({
			scan_input: {
				environment_id: "env-a",
				lookback_days: null,
				notification_rules: [],
				owner_id: "user-exact",
				repo_id: "repo-a",
				repo_url: "https://github.com/example/repository",
				share_targets: [],
				state: "enabled",
			},
		});
		expect(JSON.stringify(requestBody)).not.toContain("codex_sdk_ts");
	});

	test("imports cloud findings into the canonical store and SARIF", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-security-repo-"));
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-security-state-"));
		await $`git init --initial-branch=main`.cwd(repositoryRoot).quiet();
		await $`git remote add origin https://github.com/example/repository.git`.cwd(repositoryRoot).quiet();
		const store = await SecurityStore.open(repositoryRoot, { stateRoot });
		const fetchMock: CodexSecurityCloudFetch = async input => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/scan_configurations")) {
				return json({ items: [configuration()], total_in_account: 1 });
			}
			if (url.pathname.endsWith("/scan_configurations/config-public/stats")) {
				return json({
					config_id: "config-source",
					current_step: "waiting_for_new_commits",
					pending_commits: 0,
					finished_commits: 3,
					failed_commits: 0,
					critical_findings: 0,
					high_findings: 1,
					medium_findings: 0,
					low_findings: 0,
					informational_findings: 0,
					last_scanned_commit_hash: "abc123",
					last_scanned_commit_dt: "2026-07-29T00:04:00.000Z",
					updated_at: "2026-07-29T00:05:00.000Z",
				});
			}
			if (url.pathname.endsWith("/scan-findings")) {
				expect(url.searchParams.get("status")).toBe(
					"new,triaged,in_progress,fixed,wontfix,duplicate,false_positive",
				);
				return json({
					items: [{ id: "finding-source", hid: "finding-public", configured_scan_id: "config-source" }],
					next_cursor: null,
				});
			}
			if (url.pathname.endsWith("/scan-findings/finding-public")) {
				return json({
					id: "finding-source",
					hid: "finding-public",
					configured_scan_id: "config-source",
					scan_id: "cloud-scan-a",
					job_id: "cloud-job-a",
					created_at: "2026-07-29T00:02:00.000Z",
					updated_at: "2026-07-29T00:03:00.000Z",
					criticality: "high",
					criticality_reason: "Attacker-controlled data reaches a command sink.",
					status: "new",
					version: 2,
					commit_analysis: {
						title: "Command injection",
						description: "Untrusted input reaches shell execution.",
						commit_hash: "abc123",
						validated: true,
						validation_confidence: 1,
						validation_method: "crash",
						validation_finished_at: "2026-07-29T00:03:00.000Z",
						validation_report: "The exploit reproduced in an isolated environment.",
						proposed_patch: "Use argument-array process execution.",
						relevant_lines: [
							{
								path: "src/command.ts",
								start_line_number: 7,
								end_line_number: 9,
								content: "exec(input)",
								comment: "Untrusted input is interpolated into a shell command.",
							},
						],
					},
				});
			}
			throw new Error(`Unexpected request: ${url}`);
		};
		const client = new CodexSecurityCloudClient({
			authStorage: authStorage(),
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: fetchMock,
		});

		const bundle = await pullCodexSecurityCloudResults({ client, configurationId: "config-public", store });

		expect(bundle.scan.producer.kind).toBe("codex-security-cloud");
		expect(bundle.scan.target.revision).toBe("abc123");
		expect(bundle.findings).toHaveLength(1);
		expect(bundle.findings[0]).toMatchObject({
			title: "Command injection",
			severity: { level: "high" },
			confidence: { level: "high" },
			validation: { status: "validated" },
			disposition: { status: "open" },
			remediation: "Use argument-array process execution.",
		});
		expect(bundle.findings[0]!.occurrences[0]!.locations[0]).toEqual({
			path: "src/command.ts",
			startLine: 7,
			endLine: 9,
		});
		expect(bundle.findings[0]!.evidence.map(item => item.kind)).toEqual(["code", "validation"]);
		expect(bundle.sarif?.runs).toBeArray();
		expect((await store.getBundle(bundle.scan.id))?.findings[0]?.provenance.sourceIds).toMatchObject({
			cloudConfigurationId: "config-public",
			cloudFindingId: "finding-public",
			cloudScanId: "cloud-scan-a",
		});
		expect(JSON.stringify(bundle)).not.toContain("workspace-a");
	});

	test("drops finding details attributed to another cloud configuration", async () => {
		const client = new CodexSecurityCloudClient({
			authStorage: authStorage(),
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: async input => {
				const url = new URL(String(input));
				if (url.pathname.endsWith("/scan-findings")) {
					return json({ items: [{ hid: "finding-public" }] });
				}
				if (url.pathname.endsWith("/scan-findings/finding-public")) {
					return json({ hid: "finding-public", configured_scan_id: "different-config" });
				}
				throw new Error(`Unexpected request: ${url}`);
			},
		});
		const details = await client.listFindingDetails("https://github.com/example/repository", {
			id: "config-public",
			sourceId: "config-source",
			repositoryId: "repo-a",
			repositoryUrl: "https://github.com/example/repository",
			environmentId: "env-a",
		});
		expect(details).toEqual([]);
	});

	test("refuses cloud imports when repository identity cannot be verified", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-security-no-origin-repo-"));
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-security-no-origin-state-"));
		const store = await SecurityStore.open(repositoryRoot, { stateRoot });
		const client = new CodexSecurityCloudClient({
			authStorage: authStorage(),
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: async input => {
				const url = new URL(String(input));
				if (url.pathname.endsWith("/scan_configurations")) {
					return json({ items: [configuration()], total_in_account: 1 });
				}
				if (url.pathname.endsWith("/scan_configurations/config-public/stats")) {
					return json({
						config_id: "config-source",
						pending_commits: 0,
						finished_commits: 1,
						failed_commits: 0,
					});
				}
				throw new Error(`Finding data should not be fetched without repository identity: ${url}`);
			},
		});

		await expect(pullCodexSecurityCloudResults({ client, configurationId: "config-public", store })).rejects.toThrow(
			"has no 'origin' remote",
		);
	});

	test("refuses to import a cloud configuration for another repository", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-security-mismatch-repo-"));
		const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-security-mismatch-state-"));
		await $`git init --initial-branch=main`.cwd(repositoryRoot).quiet();
		await $`git remote add origin https://github.com/example/different-repository.git`.cwd(repositoryRoot).quiet();
		const store = await SecurityStore.open(repositoryRoot, { stateRoot });
		const fetchMock: CodexSecurityCloudFetch = async input => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/scan_configurations")) {
				return json({ items: [configuration()], total_in_account: 1 });
			}
			if (url.pathname.endsWith("/scan_configurations/config-public/stats")) {
				return json({
					config_id: "config-source",
					current_step: "waiting_for_new_commits",
					pending_commits: 0,
					finished_commits: 1,
					failed_commits: 0,
				});
			}
			throw new Error(`Finding data should not be fetched for a mismatched repository: ${url}`);
		};
		const client = new CodexSecurityCloudClient({
			authStorage: authStorage(),
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: fetchMock,
		});

		await expect(pullCodexSecurityCloudResults({ client, configurationId: "config-public", store })).rejects.toThrow(
			"does not match this project's origin remote",
		);
	});

	test("returns a sanitized error without reflecting response bodies", async () => {
		const client = new CodexSecurityCloudClient({
			authStorage: authStorage(),
			account: ACCOUNT,
			baseUrl: "https://example.test/backend-api/aardvark",
			fetch: async () => new Response("secret backend detail", { status: 403 }),
		});
		let caught: unknown;
		try {
			await client.listConfigurations();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CodexSecurityCloudHttpError);
		if (!(caught instanceof Error)) throw new Error("expected cloud HTTP error");
		expect(caught.message).not.toContain("secret backend detail");
	});

	test("a provider route leaves credentials to its proxy and takes the owner from the route", async () => {
		const requests: Array<{ url: string; authorization: string | null; accountId: string | null; body?: unknown }> =
			[];
		let status = 401;
		const client = new CodexSecurityCloudClient({
			provider: "proxy",
			route: { baseUrl: "http://proxy.test/t/p:c/backend-api/aardvark/", ownerId: async () => "google-oauth2|7" },
			apiKey: async () => "proxy-stub",
			fetch: async (input, init) => {
				const headers = new Headers(init?.headers);
				requests.push({
					url: String(input),
					authorization: headers.get("Authorization"),
					accountId: headers.get("ChatGPT-Account-Id"),
					body: init?.body ? JSON.parse(String(init.body)) : undefined,
				});
				return status === 200 ? json(configuration()) : json({}, status);
			},
		});

		// The proxy owns refresh: a 401 is reported, not retried with another token.
		await expect(client.listConfigurations()).rejects.toBeInstanceOf(CodexSecurityCloudHttpError);
		expect(requests).toHaveLength(1);
		status = 200;
		await client.startScan({
			repositoryId: "repo-a",
			repositoryUrl: "https://github.com/a/b",
			environmentId: "env-a",
		});
		expect(requests[1]).toMatchObject({
			url: "http://proxy.test/t/p:c/backend-api/aardvark/scan_configurations",
			authorization: "Bearer proxy-stub",
			accountId: null,
			body: { scan_input: { owner_id: "google-oauth2|7" } },
		});
	});

	test("cloud selection prefers a stored OAuth account, then the sole route, and never guesses among routes", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cloud-routes-"));
		const registryAuth = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(registryAuth, path.join(stateDir, "models.yaml"));
			const register = (name: string, withRoute: boolean) =>
				registry.registerProvider(
					name,
					{
						apiKey: `${name}-stub`,
						...(withRoute
							? { codexSecurityCloud: { baseUrl: `http://${name}.test/aardvark`, ownerId: async () => name } }
							: {}),
					},
					"cloud-test",
				);
			const seen: string[] = [];
			const fetchMock: CodexSecurityCloudFetch = async (input, init) => {
				seen.push(`${new URL(String(input)).host} ${new Headers(init?.headers).get("Authorization")}`);
				return json({ items: [] });
			};
			const withAccounts = (accounts: unknown[]) =>
				({
					...authStorage(),
					oauth: { ...authStorage().oauth, accounts: () => accounts },
				}) as unknown as AuthStorage;
			const noOAuth = withAccounts([]);
			const list = (storage: AuthStorage, options: { provider?: string; credentialId?: number } = {}) =>
				createCodexSecurityCloudClient({
					authStorage: storage,
					registry,
					fetch: fetchMock,
					...options,
				}).listConfigurations();

			register("proxy-a", true);
			await list(noOAuth);
			await list(withAccounts([{ credentialId: 42, position: 0, active: true, accountId: "workspace-a" }]));
			expect(seen).toEqual(["proxy-a.test Bearer proxy-a-stub", `chatgpt.com Bearer ${jwt()}`]);

			register("proxy-b", true);
			expect(() => createCodexSecurityCloudClient({ authStorage: noOAuth, registry })).toThrow(
				"choose one with cloud_provider",
			);
			await list(noOAuth, { provider: "proxy-b" });
			expect(seen.at(-1)).toBe("proxy-b.test Bearer proxy-b-stub");
			expect(() =>
				createCodexSecurityCloudClient({ authStorage: noOAuth, registry, provider: "proxy-b", credentialId: 42 }),
			).toThrow("cannot select a provider route");

			// Re-registering without the route, or unregistering, withdraws it.
			register("proxy-b", false);
			registry.unregisterProvider("proxy-a");
			expect(() => createCodexSecurityCloudClient({ authStorage: noOAuth, registry })).toThrow(
				"require a stored OAuth account for openai-codex",
			);
		} finally {
			registryAuth.close();
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});
});
