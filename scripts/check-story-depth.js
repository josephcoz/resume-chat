#!/usr/bin/env node
// Depth guard for the story library.
//
// The failure this exists to prevent: stories drift back toward capability
// statements ("owns capacity planning"), and the bot starts answering "Joe has
// experience with X" for every question. That regression is invisible until
// someone reads a transcript, so it gets asserted here instead.

const fs = require('node:fs');
const path = require('node:path');

const MIN_CHARS = 2500;        // below this a story cannot survive a follow-up
const MIN_DECISIONS = 3;       // the judgment calls are the point
const MIN_FOLLOW_UP = 3;       // what he reaches for when a recruiter pushes
const REQUIRED = ['id', 'title', 'maps_to', 'situation', 'task', 'action', 'key_decisions', 'follow_up_detail'];

// Phrasings that mean the story reverted to a capability statement.
const FILLER = [
  /\bhas experience (with|in)\b/i,
  /\bhas a strong background\b/i,
  /\bis familiar with\b/i,
  /\bhas worked with .{0,40} to\b/i,
  /\bproven track record\b/i,
];

const bundle = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'context', 'joe-public.json'), 'utf8'),
);
const stories = bundle.stories ?? [];
const errors = [];

if (stories.length === 0) errors.push('(root) — bundle has no stories');

const seen = new Set();
for (const s of stories) {
  const id = s.id ?? '(missing id)';
  if (seen.has(id)) errors.push(`${id} — duplicate id`);
  seen.add(id);

  for (const f of REQUIRED) {
    if (!s[f] || (Array.isArray(s[f]) && s[f].length === 0)) errors.push(`${id} — missing or empty "${f}"`);
  }

  const size = JSON.stringify(s).length;
  if (size < MIN_CHARS) errors.push(`${id} — ${size} chars, below the ${MIN_CHARS} floor (too thin to survive a follow-up)`);
  if ((s.key_decisions ?? []).length < MIN_DECISIONS) errors.push(`${id} — ${(s.key_decisions ?? []).length} key_decisions, need ${MIN_DECISIONS}`);
  if ((s.follow_up_detail ?? []).length < MIN_FOLLOW_UP) errors.push(`${id} — ${(s.follow_up_detail ?? []).length} follow_up_detail, need ${MIN_FOLLOW_UP}`);
  if (!Array.isArray(s.maps_to) || s.maps_to.length < 2) errors.push(`${id} — needs at least 2 maps_to tags so it can be selected`);

  const prose = [s.situation, s.task, s.action, s.result ?? ''].join(' ');
  for (const re of FILLER) {
    if (re.test(prose)) errors.push(`${id} — filler phrasing "${prose.match(re)[0]}" (say the specific thing instead)`);
  }
}

if (errors.length) {
  console.error(`✗ story-depth FAILED — ${errors.length} issue(s):\n`);
  for (const e of errors) console.error(`  ${e}`);
  console.error('');
  process.exit(1);
}

const sizes = stories.map(s => JSON.stringify(s).length);
const total = sizes.reduce((a, b) => a + b, 0);
console.log(
  `✓ story-depth passed: ${stories.length} stories, ` +
  `${Math.round(total / stories.length)} chars avg (min ${Math.min(...sizes)}), ` +
  `~${Math.round(total / 4).toLocaleString()} tokens total.`,
);
