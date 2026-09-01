// Credential loading — read API keys from local dotfiles into process.env so you
// don't have to prefix every command with `KEY=$(cat file)`.
//
// Convention (each file holds ONLY the key, whitespace trimmed):
//   .gemini-key     → GEMINI_API_KEY
//   .anthropic-key  → ANTHROPIC_API_KEY
//   .figma-token    → FIGMA_TOKEN
//
// An already-set environment variable always wins — the file is only a fallback.
// All of these are gitignored. Call loadCredentials() once at process start.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root = two levels up from src/config/.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// file → the env var(s) it populates. First existing env var wins; if none set,
// the file value fills the FIRST name in the list.
const FILE_TO_ENV = {
  '.gemini-key': ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  '.anthropic-key': ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  '.figma-token': ['FIGMA_TOKEN', 'FIGMA_API_KEY'],
};

function readKeyFile(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8').trim();
    // Tolerate a `NAME=value` line as well as a bare key.
    const eq = raw.indexOf('=');
    return eq !== -1 && !/\s/.test(raw.slice(0, eq)) ? raw.slice(eq + 1).trim() : raw;
  } catch {
    return null;
  }
}

/**
 * Populate process.env from local key dotfiles (only where not already set).
 *
 * The FIRST name in each list is canonical — it's what consumers actually read
 * (`process.env.FIGMA_TOKEN`). Later names are accepted ALIASES. So when only an
 * alias is set in the environment, mirror it onto the canonical name; otherwise
 * the value is present but invisible to every reader, which looks exactly like
 * "no token" and is maddening to debug.
 *
 * Precedence is unchanged: a value already in the environment always beats the
 * file.
 *
 * @param {string} [root=ROOT]  Directory to look in (defaults to project root).
 * @returns {string[]}  The canonical env var names that now hold a value.
 */
export function loadCredentials(root = ROOT) {
  const filled = [];
  for (const [file, names] of Object.entries(FILE_TO_ENV)) {
    const canonical = names[0];

    // An alias set in the env satisfies this credential — but mirror it onto the
    // canonical name so readers can find it.
    const aliasSet = names.find((n) => process.env[n]);
    if (aliasSet) {
      if (!process.env[canonical]) {
        process.env[canonical] = process.env[aliasSet];
        filled.push(canonical);
      }
      continue;
    }

    const value = readKeyFile(path.join(root, file));
    if (value) {
      process.env[canonical] = value;
      filled.push(canonical);
    }
  }
  return filled;
}
