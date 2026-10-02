// opencode's configuration for runner-sandbox: the bot's own,
// dotfiles/.config/opencode in a homegit checkout (providers, model and
// instructions, as bot-opencode uses locally). Only that directory is
// copied to runner-sandbox. It must make the praxis broker the only
// provider; the broker's base URL, sharing and the run token are set here,
// whatever the file says, and written 0600 because the token is in it.
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { asSandbox } from "../scripts/runner-sandbox.mjs";

export const OPENCODE_SRC_DIR = "dotfiles/.config/opencode";
export const OPENCODE_CONFIG_FILE = "opencode.json";
// Where opencode reads its global configuration, in runner-sandbox's home.
export const OPENCODE_CONFIG_DIR = ".config/opencode";
export const PRAXIS_PROVIDER = "praxis";
// The only files copied: opencode also merges other configuration files
// (opencode.jsonc, config.json) and runs plugins, tools and commands found
// in its configuration directory, none of which the provider check below
// covers. The rest of the directory is left behind.
export const COPIED_FILES = [OPENCODE_CONFIG_FILE, "AGENTS.md"];

// text with the comments and trailing commas of JSONC removed, ready for
// JSON.parse. String-aware, so a "//" in a URL stays.
export function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c === ",") {
      // A trailing comma if the next token that isn't whitespace or a
      // comment closes a container.
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === "/" && text[j + 1] === "/") while (j < text.length && text[j] !== "\n") j++;
        else if (text[j] === "/" && text[j + 1] === "*") {
          const end = text.indexOf("*/", j + 2);
          j = end < 0 ? text.length : end + 2;
        } else break;
      }
      if (text[j] !== "}" && text[j] !== "]") out += c;
    } else out += c;
  }
  return out;
}

// Parses homegit's configuration and checks the broker is its only
// provider, so that nothing the checkout holds can send the work elsewhere.
export function parseOpencodeConfig(text) {
  let config;
  try {
    config = JSON.parse(stripJsonc(text));
  } catch (e) {
    throw new Error(`homegit's ${OPENCODE_CONFIG_FILE} isn't valid JSONC: ${e.message}`);
  }
  const providers = Object.keys(config.provider ?? {});
  if (JSON.stringify(config.enabled_providers) !== JSON.stringify([PRAXIS_PROVIDER]) || providers.join() !== PRAXIS_PROVIDER) {
    throw new Error(`homegit's ${OPENCODE_CONFIG_FILE} must enable only the ${PRAXIS_PROVIDER} provider`);
  }
  return config;
}

// The configuration the run uses: homegit's, with the broker's base URL,
// the key (the run token) and sharing off.
export function runConfig(config, { baseURL, apiKey }) {
  const provider = config.provider[PRAXIS_PROVIDER];
  return {
    ...config,
    share: "disabled",
    provider: { [PRAXIS_PROVIDER]: { ...provider, options: { ...provider.options, baseURL, apiKey } } },
  };
}

// The names of COPIED_FILES present in dir, each (symlinks followed)
// resolved to a regular file inside root, so a link can't pull in anything
// from outside the checkout.
export function configFiles(dir, root) {
  const out = [];
  for (const name of COPIED_FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const real = realpathSync(path);
    const rel = relative(root, real);
    if (rel === "" || rel.split(sep)[0] === "..") throw new Error(`${path} points outside the homegit checkout`);
    if (!lstatSync(real).isFile()) throw new Error(`${path} is not a regular file`);
    out.push(name);
  }
  return out;
}

// Gives runner-sandbox homegit's opencode configuration (COPIED_FILES), with opencode.json rewritten by runConfig and mode 0600.
// Returns a one-line description for the log.
export function installOpencodeConfig(homegitDir, { baseURL, apiKey }) {
  const root = realpathSync(homegitDir);
  const dir = join(root, OPENCODE_SRC_DIR);
  if (!existsSync(join(dir, OPENCODE_CONFIG_FILE))) throw new Error(`${OPENCODE_SRC_DIR}/${OPENCODE_CONFIG_FILE} is missing from ${homegitDir}`);
  const config = runConfig(parseOpencodeConfig(readFileSync(join(dir, OPENCODE_CONFIG_FILE), "utf8")), { baseURL, apiKey });
  const files = configFiles(dir, root);
  const stage = mkdtempSync(join(tmpdir(), "opencode-config-"));
  try {
    for (const f of files) {
      mkdirSync(dirname(join(stage, f)), { recursive: true });
      copyFileSync(join(dir, f), join(stage, f));
    }
    writeFileSync(join(stage, OPENCODE_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const tar = spawnSync("tar", ["-C", stage, "-cf", "-", "."], { maxBuffer: 1 << 26 });
    if (tar.status !== 0) throw new Error("packing homegit's opencode configuration failed");
    // The archive goes over stdin, never onto a command line; umask 077 from
    // the start so the run token is never readable by others.
    const write = asSandbox(["sh", "-c",
      `umask 077 && mkdir -p "$HOME/${OPENCODE_CONFIG_DIR}" && chmod 0700 "$HOME/${OPENCODE_CONFIG_DIR}" `
      + `&& tar -xf - -C "$HOME/${OPENCODE_CONFIG_DIR}" && chmod 0600 "$HOME/${OPENCODE_CONFIG_DIR}/${OPENCODE_CONFIG_FILE}"`],
    { input: tar.stdout });
    if (write.status !== 0) throw new Error("writing runner-sandbox's opencode configuration failed");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const head = spawnSync("git", ["-C", root, "log", "-1", "--format=%h %s"], { encoding: "utf8" }).stdout.trim();
  return `${homegitDir} (${head}), ${files.join(", ")}`;
}
