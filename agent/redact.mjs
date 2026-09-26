// Replace secrets with [REDACTED] before anything is logged or uploaded.
// The rules are the "Redaction" section of docs/devspace-agent-runs.md in
// cgwalters-bot/homegit: the literal values of the job's own tokens, GitHub,
// Anthropic/OpenAI and Tailscale token patterns, JWTs, and whole PEM
// private key blocks. It's a safety net, not the defense: the agent's
// environment holds no secret worth leaking.
import { lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPLACEMENT = "[REDACTED]";
// Shorter literals would redact ordinary words.
const MIN_LITERAL = 8;
export const SECRET_PATTERNS = [
  "gh[posu]_[A-Za-z0-9_]{20,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  "sk-ant-[A-Za-z0-9_-]{20,}",
  "sk-[A-Za-z0-9_-]{20,}",
  "tskey-[A-Za-z0-9-]{10,}",
  // JWTs, such as GitHub's OIDC tokens and the Actions runtime token
  "eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]*",
  // A whole block, also when a JSON string holds it with escaped
  // newlines; an unterminated one is cut to the end of the line.
  "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[^\\n]*)",
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A redactor for LITERALS plus the patterns: redact(text) returns the text
// with secrets replaced, and .count is the running total of replacements.
export function makeRedactor(literals = []) {
  const parts = [...new Set(literals.filter((s) => s.length >= MIN_LITERAL))]
    .sort((a, b) => b.length - a.length).map(escape).concat(SECRET_PATTERNS);
  const rule = new RegExp(parts.map((p) => `(?:${p})`).join("|"), "g");
  const redact = (text) => text.replace(rule, () => {
    redact.count++;
    return REPLACEMENT;
  });
  redact.count = 0;
  return redact;
}

// Redacts every UTF-8 text file under PATHS in place, and deletes symlinks
// (and anything else but files and directories), which could point outside.
export function redactTree(redact, paths) {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (const path of paths) {
    const st = lstatSync(path);
    if (st.isDirectory()) {
      redactTree(redact, readdirSync(path).map((name) => join(path, name)));
    } else if (!st.isFile()) {
      unlinkSync(path);
    } else {
      let text;
      try {
        text = utf8.decode(readFileSync(path));
      } catch {
        continue;
      }
      const before = redact.count;
      const out = redact(text);
      if (redact.count !== before) {
        writeFileSync(path, out);
      }
    }
  }
}
