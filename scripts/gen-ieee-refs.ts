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
// A reviewer asked which references are peer reviewed, so the arXiv-only
// entries are labelled as preprints, not only located.
let out = src.replace(/@misc\{[^@]*?\n\}/g, (entry) => {
  if (/howpublished|\burl\s*=|\bdoi\s*=/.test(entry)) return entry;
  const ep = entry.match(/eprint\s*=\s*\{([^}]+)\}/);
  if (!ep) return entry;
  return entry.replace(
    /(\n\s*eprint\s*=)/,
    `\n  howpublished = {arXiv preprint arXiv:${ep[1]}},$1`,
  );
});
// Web pages: IEEE reference style ends such an entry with "[Online].
// Available: URL", which IEEEtran.bst prints from a url field. The source
// bibliography carries the address inside howpublished (the other shell's
// style prints it from there), so move it into url here and keep the site
// name, where there is one, in howpublished.
let urlsMoved = 0;
out = out.replace(/@misc\{[^@]*?\n\}/g, (entry) => {
  const hp = entry.match(/\n(\s*)howpublished\s*=\s*\{((?:[^{}]|\{[^{}]*\})*)\},?/);
  if (!hp) return entry;
  const url = hp[2]!.match(/\\url\{([^}]+)\}/);
  if (!url) return entry;
  urlsMoved++;
  const site = hp[2]!.replace(/,?\s*\\url\{[^}]+\}/, "").replace(/\s+/g, " ").trim();
  const fields = `${site ? `\n${hp[1]}howpublished = {${site}},` : ""}\n${hp[1]}url = {${url[1]}},`;
  return entry.replace(hp[0], fields);
});
// IEEEtran.bst also has no doi field. IEEE reference style prints DOIs, so
// carry each entry's DOI in its note (appended when a note exists). The note
// value may contain one level of braces ("{SIGMOD} 2026"); the first
// submission's regex stopped at the inner brace and printed
// "SIGMOD; doi:... 2026", which a reviewer read as a DOI with the year
// appended.
let doisAdded = 0;
out = out.replace(/@\w+\{[^@]*?\n\}/g, (entry) => {
  const doiField = entry.match(/\n\s*doi\s*=\s*\{([^}]+)\}/);
  if (!doiField) return entry;
  doisAdded++;
  // A DOI in a note is typeset as text: underscores must be escaped or
  // pdfTeX opens math mode (10.1162/coli_a_00502 broke the build once).
  const doi = [doiField[0], doiField[1]!.replace(/_/g, "\\_")];
  const note = entry.match(/\n(\s*)note\s*=\s*\{((?:[^{}]|\{[^{}]*\})*)\}/);
  if (note) {
    return entry.replace(note[0], `\n${note[1]}note = {${note[2]}, doi:${doi[1]}}`);
  }
  return entry.replace(/\n\}$/, `,\n  note = {doi:${doi[1]}}\n}`);
});

const header = `% GENERATED from paper/refs.bib by scripts/gen-ieee-refs.ts; do not edit.
% IEEEtran.bst drops eprint fields, so arXiv identifiers are copied into
% howpublished here. Edit paper/refs.bib and re-run pnpm build:paper:ieee.
`;
writeFileSync("paper/ieee/refs.bib", header + out);
const added = out.match(/howpublished = \{arXiv preprint arXiv:/g)?.length ?? 0;
console.log(`paper/ieee/refs.bib written; arXiv locators added: ${added}; DOIs carried into notes: ${doisAdded}; web addresses moved into url: ${urlsMoved}`);
