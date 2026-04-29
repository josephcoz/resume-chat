#!/usr/bin/env node
// Build-time linter. Fails the deploy if joe-public.json contains anything
// that violates Joe's hard rules: dollar amounts, blocklisted names, or
// proprietary keywords. Run before every deploy.

const fs = require('node:fs');
const path = require('node:path');

const BUNDLE_PATH = path.join(__dirname, '..', 'context', 'joe-public.json');
const PROMPT_PATH = path.join(__dirname, '..', 'context', 'system-prompt.md');
const PROMPT_TS_PATH = path.join(__dirname, '..', 'src', '_systemPrompt.ts');

// ---- Blocklists ----------------------------------------------------------

// Names Joe must never have the bot say. Coworkers, managers, customer-side
// folks. First-name only entries match whole-word; multi-word entries match
// case-insensitive substring.
const NAME_BLOCKLIST = [
  // Coworkers / managers (sourced from second-brain, kept here so the linter
  // can catch accidental leaks into the bundle)
  'Gavin Lawrence', 'Gavin',
  'Sanjanaa Sridhar', 'Sanjanaa',
  'Jamie Dyra', 'Jamie',
  'Austin Truong', 'Austin',
  'Angel Hsia', 'Angel',
  'Stoyan Stoyanov', 'Stoyan',
  'Hunter Britsch', 'Hunter',
  'Jenny Le', 'Jenny',
  'Josh Richins', 'Josh',
  'Domonic Capece', 'Domonic',
  'Dominic Capece', 'Dominic',
  'Patrick',
  'Eduardo',
  'Noreen',
  'Lukas Menkhoff', 'Lukas',
  'Dwight',
  'Lianna',
  'Ramen',
  'Nicole',
  'Dan Cusick', 'Cusick',
  // Customer accounts seen in the vault
  'Teamshares', 'RSC Mechanical', 'HLC Foods', 'Rivermaid',
  'GoTo Foods', 'Joey Tomato', "Joey Tomato's",
  'Sun Holdings', 'Consolidated Burger',
];

// Companies Joe legitimately worked at. These are PUBLIC on his resume and
// must NOT be flagged. Used to whitelist substring hits that would otherwise
// trip the linter.
const ALLOWED_COMPANY_TOKENS = [
  'Workstream', 'Qualtrics', 'Posit', 'RStudio',
  'BNSF', 'Hall & Partners',
  'Brigham Young University', 'BYU',
];

// Proprietary terminology / internal codenames to block.
const PROPRIETARY_KEYWORDS = [
  'OM Quote-Check',
  'OM Channel Taxonomy',
  'CSQL Review',
  'Backfill One-Pager',
  'cogs_allocation.py',
  'csm_book_reassignment',
  'CIS complexity model',
  'auto_renewal_notifications',
];

// Dollar / currency / financial figure patterns. Any match is a hard fail.
const MONEY_PATTERNS = [
  /\$\s?\d/,                  // "$50", "$ 1.2"
  /€\s?\d/,
  /£\s?\d/,
  /¥\s?\d/,
  /\bUSD\s*\d/i,
  /\bEUR\s*\d/i,
  /\b\d+\s?(?:k|K|M|B)\s+(?:ARR|MRR|TCV|ACV)\b/,
  /\b(?:ARR|MRR|TCV|ACV|GMV)\s+of\s+\$/i,
  /\b\d+(?:\.\d+)?\s?(?:million|billion|thousand)\b/i,
  /\bsalary\s+(?:of|range|band)\s+\$/i,
];

// ---- Helpers -------------------------------------------------------------

function flatten(obj, prefix = '') {
  // Walk an arbitrarily-nested JSON value and yield {path, text} for every
  // string leaf. Lets us point at exactly which JSON field tripped the linter.
  const out = [];
  if (typeof obj === 'string') {
    out.push({ path: prefix || '(root)', text: obj });
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => out.push(...flatten(v, `${prefix}[${i}]`)));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      out.push(...flatten(v, prefix ? `${prefix}.${k}` : k));
    }
  }
  return out;
}

function findHits(text, patterns) {
  const hits = [];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) hits.push({ pattern: p.toString(), match: m[0] });
  }
  return hits;
}

function findNameHits(text) {
  const hits = [];
  const lower = text.toLowerCase();
  for (const name of NAME_BLOCKLIST) {
    const lname = name.toLowerCase();
    // Single-word entries: word-boundary match (case-insensitive).
    if (!name.includes(' ')) {
      const re = new RegExp(`\\b${name}\\b`, 'i');
      if (re.test(text)) {
        // But skip if it overlaps with an allowed company token. (e.g.,
        // "Workstream" obviously is fine even if a name like "Stream" were
        // ever in the blocklist — defensive.)
        const overlaps = ALLOWED_COMPANY_TOKENS.some(c =>
          text.includes(c) && c.toLowerCase().includes(lname)
        );
        if (!overlaps) hits.push({ name, kind: 'word-boundary' });
      }
    } else {
      // Multi-word entries: simple case-insensitive substring.
      if (lower.includes(lname)) hits.push({ name, kind: 'substring' });
    }
  }
  return hits;
}

function findKeywordHits(text) {
  const hits = [];
  const lower = text.toLowerCase();
  for (const kw of PROPRIETARY_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) hits.push(kw);
  }
  return hits;
}

// ---- Main ----------------------------------------------------------------

function checkFile(filePath, label) {
  const errors = [];
  const raw = fs.readFileSync(filePath, 'utf8');
  let leaves;

  if (filePath.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return [{ path: '(parse)', message: `Invalid JSON: ${e.message}` }];
    }
    leaves = flatten(parsed);
  } else {
    // Markdown or plain text — treat the whole file as one leaf.
    leaves = [{ path: '(file)', text: raw }];
  }

  for (const { path: p, text } of leaves) {
    const moneyHits = findHits(text, MONEY_PATTERNS);
    if (moneyHits.length) {
      errors.push({
        path: p,
        message: `Money/currency pattern detected: ${moneyHits.map(h => h.match).join(', ')}`,
        snippet: text.slice(0, 200),
      });
    }
    const nameHits = findNameHits(text);
    if (nameHits.length) {
      errors.push({
        path: p,
        message: `Blocklisted name(s) detected: ${nameHits.map(h => h.name).join(', ')}`,
        snippet: text.slice(0, 200),
      });
    }
    const kwHits = findKeywordHits(text);
    if (kwHits.length) {
      errors.push({
        path: p,
        message: `Proprietary keyword(s) detected: ${kwHits.join(', ')}`,
        snippet: text.slice(0, 200),
      });
    }
  }

  return errors.map(e => ({ ...e, file: label }));
}

function regeneratePromptTs() {
  if (!fs.existsSync(PROMPT_PATH)) {
    console.error(`✗ Missing: ${PROMPT_PATH}`);
    process.exit(2);
  }
  const md = fs.readFileSync(PROMPT_PATH, 'utf8').trimEnd();
  const escaped = md.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  const out = [
    '// AUTO-GENERATED from /context/system-prompt.md by scripts/sanitize-check.js.',
    '// Edit the markdown source, not this file.',
    '',
    `export const SYSTEM_PROMPT = \`${escaped}\`;`,
    '',
  ].join('\n');
  fs.writeFileSync(PROMPT_TS_PATH, out);
}

function main() {
  let allErrors = [];

  // Keep _systemPrompt.ts in sync with the markdown source.
  regeneratePromptTs();

  if (!fs.existsSync(BUNDLE_PATH)) {
    console.error(`✗ Missing: ${BUNDLE_PATH}`);
    process.exit(2);
  }
  allErrors = allErrors.concat(checkFile(BUNDLE_PATH, 'context/joe-public.json'));

  if (fs.existsSync(PROMPT_PATH)) {
    // Note: the system prompt INTENTIONALLY references the existence of
    // dollar-amount and name boundaries. Skip prompt scanning by default —
    // it's the rules file, not the data file. Toggle with --strict to scan.
    if (process.argv.includes('--strict')) {
      allErrors = allErrors.concat(checkFile(PROMPT_PATH, 'context/system-prompt.md'));
    }
  }

  if (allErrors.length === 0) {
    console.log('✓ sanitize-check passed: bundle is clean.');
    process.exit(0);
  }

  console.error(`✗ sanitize-check FAILED — ${allErrors.length} issue(s):\n`);
  for (const err of allErrors) {
    console.error(`  [${err.file}] ${err.path}`);
    console.error(`    ${err.message}`);
    if (err.snippet) console.error(`    snippet: ${err.snippet.replace(/\s+/g, ' ').trim()}`);
    console.error('');
  }
  process.exit(1);
}

main();
