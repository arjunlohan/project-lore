/**
 * paper/ieee/refs.bib generator. The single source of truth is
 * paper/refs.bib: ACM-Reference-Format prints arXiv identifiers from eprint
 * fields, but IEEEtran.bst has no eprint support and silently drops them,
 * which would leave every arXiv-only @misc entry as a bare title with no
 * locator, a direct hit on the reviewer question "are the references
 * applicable and sufficient". This emits a copy with
 * howpublished = {arXiv:ID} added to exactly those entries, so neither
 * bibliography style loses information and neither prints it twice.
 *
 * Run via `pnpm build:paper:ieee`; the output is committed so the IEEE
 * build works from a clean clone without tsx.
 */
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("paper/refs.bib", "utf8");

// Entries never contain '@' internally, so a lazy [^@] scan cannot cross
// into the next entry. Only arXiv @misc entries (eprint present; no other
// locator field) need the howpublished line.
const out = src.replace(/@misc\{[^@]*?\n\}/g, (entry) => {
  if (/howpublished|\burl\s*=|\bdoi\s*=/.test(entry)) return entry;
  const ep = entry.match(/eprint\s*=\s*\{([^}]+)\}/);
  if (!ep) return entry;
  return entry.replace(
    /(\n\s*eprint\s*=)/,
    `\n  howpublished = {arXiv:${ep[1]}},$1`,
  );
});

const header = `% GENERATED from paper/refs.bib by scripts/gen-ieee-refs.ts; do not edit.
% IEEEtran.bst drops eprint fields, so arXiv identifiers are copied into
% howpublished here. Edit paper/refs.bib and re-run pnpm build:paper:ieee.
`;
writeFileSync("paper/ieee/refs.bib", header + out);
const added = out.match(/howpublished = \{arXiv:/g)?.length ?? 0;
console.log(`paper/ieee/refs.bib written; arXiv locators added: ${added}`);
