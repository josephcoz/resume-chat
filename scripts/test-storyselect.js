#!/usr/bin/env node
// Tests for selective story injection, plus an end-to-end assertion on the
// assembled prompt.
//
// The end-to-end part exists because a silent no-op edit once shipped a preview
// missing two fixes I believed were deployed — I had "verified" them with a
// script that re-implemented the logic instead of reading the source. These
// assertions run against the real modules.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const load = rel => {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const m = { exports: {} };
  new Function('module', 'exports', 'require', js)(m, m.exports, require);
  return m.exports;
};

const sel = load('src/storySelect.ts');
const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'context', 'joe-public.json'), 'utf8'));
const stories = bundle.stories;

let pass = 0, fail = 0;
const t = (name, actual, expected) => {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  if (ok) pass++;
  else { fail++; console.error(`  ✗ ${name}\n      got: ${JSON.stringify(actual)?.slice(0, 220)}`); }
};
const ids = out => out.map(s => s.id);
const pick = q => ids(sel.selectStories(stories, q));

console.log('relevance');
t('capacity question finds the hiring-plan test', pick('does he have quota and capacity planning experience?'),
  v => v.includes('capacity_marginal_roi'));
t('forecasting question finds forecast stories', pick('tell me about his forecasting work'),
  v => v.includes('forecast_regime_cone') || v.includes('annual_plan'));
t('WBR/QBR question finds the cadence story', pick('has he run a WBR or QBR cadence?'),
  v => v.includes('owns_the_cadence'));
t('pricing question finds pricing stories', pick('what pricing work has he done?'),
  v => v.some(id => ['declined_the_discount', 'changed_the_lens', 'price_program_end_to_end'].includes(id)));
t('comp question finds comp design', pick('has he designed a compensation plan?'),
  v => v.some(id => ['grr_not_nrr', 'no_one_nets_down', 'comp_to_pricing'].includes(id)));
t('AI question finds the agentic work', pick('what is his agentic AI experience?'),
  v => v.includes('deterministic_core'));
t('hiring question finds the hiring bar', pick('has he hired or built a team?'),
  v => v.includes('hiring_bar'));

console.log('discrimination');
t('different questions select different sets',
  JSON.stringify(pick('forecasting and revenue models')) !== JSON.stringify(pick('how does he prioritise his work?')), true);
t('capacity question does not return the whole library', pick('capacity planning').length, sel.DEFAULT_LIMIT);
t('unrelated question still returns something', pick('hello there').length, v => v > 0);
t('respects an explicit limit', ids(sel.selectStories(stories, 'forecasting', 2)).length, 2);
// At most MAX_LIMIT — fewer is correct when fewer stories are relevant, which
// is the point of scoring rather than padding to a fixed count.
t('never exceeds MAX_LIMIT', ids(sel.selectStories(stories, 'forecasting', 99)).length,
  v => v > 0 && v <= sel.MAX_LIMIT);
t('a broad query can fill the cap', ids(sel.selectStories(stories,
  'forecasting quota capacity pricing compensation reporting automation hiring segmentation retention', 99)).length,
  v => v === sel.MAX_LIMIT);
t('deterministic across runs', JSON.stringify(pick('quota and capacity')), JSON.stringify(pick('quota and capacity')));

console.log('job-description text drives selection');
const jd = `Build and own an independent EMM forecast and revenue point of view.
Run the EMM rhythm of business — own WBR/QBR cadence and decision follow-through.
Own EMM quota and capacity planning; build CAC-rightsized capacity models.
Advanced modeling in Excel; Anaplan; Tableau. Agentic AI fluency.`;
const jdPick = pick(jd);
t('JD selects across its own themes', jdPick, v => v.length === sel.DEFAULT_LIMIT);
t('JD surfaces a planning story', jdPick,
  v => v.some(id => ['annual_plan', 'capacity_marginal_roi', 'forecast_regime_cone', 'owns_the_cadence'].includes(id)));

console.log('injection payload');
const msg = sel.buildStoriesMessage(sel.selectStories(stories, 'capacity planning'));
t('payload names the loaded stories', msg, s => s.includes('Stories loaded for this question'));
t('payload tells the model to answer from these', msg, s => /Answer from these/i.test(s));
t('payload is far smaller than the whole library', msg.length,
  v => v < JSON.stringify(stories).length / 2);
// The model quoted an id back as the name of the work. Stripping them from the
// bundle missed this path entirely, because the injected bodies come from source.
t('no story ids reach the model', msg, s => !/"id"\s*:/.test(s));
t('no id value leaks either', msg, s => !stories.some(st => s.includes('"' + st.id + '"')));
t('story content itself survives the strip', msg,
  s => s.includes('situation') && s.includes('key_decisions'));

console.log('assembled prompt (reads the real source, not a copy)');
const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat.ts'), 'utf8');
t('story bodies are removed from the bundle', chatSrc, s => s.includes('delete clone.stories'));
t('an index replaces them', chatSrc, s => s.includes('clone.story_index = buildStoryIndex'));
t('reminder is a trailing message', chatSrc, s => /grounding = \[[\s\S]*OUTPUT_REMINDER[\s\S]*\];/.test(s));
t('selected stories are injected', chatSrc, s => s.includes('buildStoriesMessage(selected)'));
t('index carries no story bodies', JSON.stringify(sel.buildStoryIndex(stories)),
  s => !s.includes('situation') && !s.includes('key_decisions'));

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
