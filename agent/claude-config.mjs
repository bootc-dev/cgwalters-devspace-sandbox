// Claude Code's configuration for runner-sandbox. Unlike opencode's, none
// of it comes from homegit: the runner has no login, only the praxis
// broker's Anthropic Messages route, which adds the broker's own Claude
// credential to the requests of a registered run (INTERNALS.md in
// cgwalters-bot/praxis-credential-broker, "injected"). Three files:
//
//   ~/.config/claude-runner/run.json   (0600) the environment that points
//       Claude Code at the broker, the run token included; the only place
//       the agent gets the token. claude-launch.mjs applies it.
//   /etc/claude-code/managed-settings.json   root's, no secret. Claude
//       Code applies the env of settings files over its own environment,
//       the target repository's .claude/settings.json included, and
//       managed settings over those: so the endpoint and the provider
//       switches are pinned here, and hooks and permission rules are
//       limited to managed ones (there are none), which keeps every
//       command and edit a permission request that bot-harness answers
//       and records.
//       That is tidiness, not the boundary: the agent can read the run
//       token and run any command anyway, and what contains it is the
//       sandbox user and the egress proxy.
//   ~/.claude/CLAUDE.md   the runner's profile (claude-runner.md).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asSandbox } from "../scripts/runner-sandbox.mjs";

// In runner-sandbox's home.
export const CLAUDE_RUN_DIR = ".config/claude-runner";
export const CLAUDE_RUN_FILE = "run.json";
export const CLAUDE_MEMORY_FILE = ".claude/CLAUDE.md";
export const MANAGED_SETTINGS_FILE = "/etc/claude-code/managed-settings.json";
const RUNNER_PROFILE = join(dirname(fileURLToPath(import.meta.url)), "claude-runner.md");
// What the broker takes as "use your own credential" on its Anthropic
// routes; it grants nothing without a run token beside it.
export const PLACEHOLDER_CREDENTIAL = "praxis-substitute:anthropic";
// Where the broker reads the run token when Authorization holds the
// placeholder.
export const RUN_TOKEN_HEADER = "x-run-token";
// The broker's Anthropic routes, beside its Responses ones (/v1).
const RESPONSES_PATH = "/v1";
const ANTHROPIC_PATH = "/anthropic";

export const CONFIG_INSTALL_COMMAND =
  `umask 077 && mkdir -p "$HOME/${CLAUDE_RUN_DIR}" && chmod 0700 "$HOME/${CLAUDE_RUN_DIR}" `
  + `&& rm -f "$HOME/${CLAUDE_RUN_DIR}/${CLAUDE_RUN_FILE}" "$HOME/${CLAUDE_MEMORY_FILE}" `
  + `&& tar -xf - -C "$HOME" && chmod 0600 "$HOME/${CLAUDE_RUN_DIR}/${CLAUDE_RUN_FILE}"`;

// Claude Code's base URL for the broker whose Responses base URL
// (PRAXIS_BASE_URL, http://HOST:PORT/v1) is given; it appends /v1/messages.
export function anthropicBaseUrl(praxisBaseUrl) {
  const url = new URL(praxisBaseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith(RESPONSES_PATH)) {
    throw new Error(`PRAXIS_BASE_URL must end in ${RESPONSES_PATH} to find the broker's ${ANTHROPIC_PATH} routes beside it, not '${url.pathname}'`);
  }
  url.pathname = `${path.slice(0, -RESPONSES_PATH.length)}${ANTHROPIC_PATH}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

// Where inference goes, without the run token.
function endpointEnv(baseURL) {
  return { ANTHROPIC_BASE_URL: anthropicBaseUrl(baseURL), ANTHROPIC_AUTH_TOKEN: PLACEHOLDER_CREDENTIAL };
}

// The environment claude-launch.mjs gives Claude Code: the broker, the
// placeholder as its credential and the run token in a header of its own.
export function runEnv({ baseURL, runToken }) {
  return { ...endpointEnv(baseURL), ANTHROPIC_CUSTOM_HEADERS: `${RUN_TOKEN_HEADER}: ${runToken}` };
}

// The switches that would send inference to another provider's endpoint,
// which ANTHROPIC_BASE_URL doesn't govern; pinned empty (off).
const PROVIDER_SWITCHES = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

// Managed settings: they win over the user's and the project's, key by key.
export function managedSettings({ baseURL }) {
  return {
    env: {
      ...endpointEnv(baseURL), ...Object.fromEntries(PROVIDER_SWITCHES.map((name) => [name, ""])),
      // As claude-launch.mjs sets them.
      DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    allowManagedHooksOnly: true,
    allowManagedPermissionRulesOnly: true,
    permissions: { defaultMode: "default", disableBypassPermissionsMode: "disable" },
  };
}

// Writes the three files. Returns a one-line description for the log.
export function installClaudeConfig({ baseURL, runToken }) {
  if (!runToken) throw new Error("the broker gave no run token, and its Claude credential is only for a registered run");
  const stage = mkdtempSync(join(tmpdir(), "claude-config-"));
  try {
    const files = [join(CLAUDE_RUN_DIR, CLAUDE_RUN_FILE), CLAUDE_MEMORY_FILE];
    for (const f of files) mkdirSync(dirname(join(stage, f)), { recursive: true });
    writeFileSync(join(stage, files[0]), `${JSON.stringify({ env: runEnv({ baseURL, runToken }) })}\n`, { mode: 0o600 });
    copyFileSync(RUNNER_PROFILE, join(stage, CLAUDE_MEMORY_FILE));
    // Only the files: an archive of the directory would also set the mode
    // of runner-sandbox's home.
    const tar = spawnSync("tar", ["-C", stage, "-cf", "-", ...files], { maxBuffer: 1 << 26 });
    if (tar.status !== 0) throw new Error("packing Claude Code's configuration failed");
    // Over stdin, never onto a command line; umask 077 from the start so
    // the run token is never readable by others.
    if (asSandbox(["sh", "-c", CONFIG_INSTALL_COMMAND], { input: tar.stdout }).status !== 0) {
      throw new Error("writing runner-sandbox's Claude Code configuration failed");
    }
    const managed = join(stage, "managed-settings.json");
    writeFileSync(managed, `${JSON.stringify(managedSettings({ baseURL }), null, 2)}\n`);
    const install = spawnSync("sudo", ["install", "-D", "-o", "root", "-g", "root", "-m", "0644", managed, MANAGED_SETTINGS_FILE], { stdio: "inherit" });
    if (install.status !== 0) throw new Error(`writing ${MANAGED_SETTINGS_FILE} failed`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return `${anthropicBaseUrl(baseURL)}, ${MANAGED_SETTINGS_FILE}`;
}
