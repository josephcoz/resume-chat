// Selective story injection.
//
// Why this exists: the bundle grew to ~35k tokens, and against that much JSON a
// 17B-active model stopped following the behavioural rules in the prompt — it
// defaulted to the statistically obvious shape for "assess a candidate against a
// job description," which is a polite survey. Three rounds of prompt fixes lost.
//
// So instead of sending 33 stories and asking for depth, send the handful that
// match the question. Context drops by roughly a factor of four, the
// instructions get proportionally more weight, and surveying twenty requirements
// stops being available because the material for it is not there.
//
// Selection is deterministic keyword scoring. No extra model call, no latency.

export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 8;

export type Story = {
  id?: string;
  title: string;
  maps_to: string[];
  [k: string]: unknown;
};

// Query vocabulary → the tag vocabulary the stories are written in. Recruiters
// and job descriptions do not use the same words the stories do, and without
// this bridge a question about "headcount planning" misses stories tagged
// "capacity". Left side is what someone types; right side is what to boost.
const SYNONYMS: Array<[RegExp, string[]]> = [
  [/\bforecast(ing|s)?\b|\bprojection|revenue point of view|landing\b/i,
    ['forecasting', 'bottoms-up revenue models', 'scenario modeling', 'forecast hygiene', 'revenue point of view']],
  [/\bquota|capacity|headcount|ramp\b|seller[- ]level|\bCAC\b|coverage model/i,
    ['quota and capacity planning', 'CAC-rightsized capacity models', 'seller-level goals', 'headcount planning']],
  [/\bWBR\b|\bQBR\b|\bMBR\b|business review|rhythm|cadence|operating review/i,
    ['rhythm of business', 'WBR/QBR cadence', 'operating cadence', 'executive reporting']],
  [/\breport(ing)?\b|dashboard|scorecard|executive narrative|stakeholder/i,
    ['executive reporting', 'trusted reporting', 'metric definition']],
  [/\bpricing|price|discount|margin|packaging|floor|unit economics/i,
    ['pricing strategy', 'margin analysis', 'unit economics', 'deal desk']],
  [/\bcomp(ensation)?\b|commission|accelerator|payout|incentive|comp plan/i,
    ['compensation design', 'quota and capacity planning']],
  [/\bplan(ning)?\b|annual plan|target setting|source of truth|channel split/i,
    ['annual planning', 'planning source of truth', 'target setting', 'channel splits']],
  [/data integrity|reconcil|source of truth|metric definition|trusted without/i,
    ['data integrity', 'metric definition', 'Finance partnership', 'trusted reporting']],
  [/\bfinance\b|FP&A|billing|invoice|bookings|units to revenue/i,
    ['Finance partnership', 'units to revenue', 'revenue point of view']],
  [/\bAI\b|agentic|automat(e|ion)|Claude|LLM|bot\b|tool stack/i,
    ['agentic AI', 'automation', 'AI safety design', 'systems design']],
  [/salesforce|\bCRM\b|anaplan|system|architecture|integration|deploy/i,
    ['systems design', 'analysis to implementation', 'process design']],
  [/segment|\bICP\b|\bTAM\b|\bSAM\b|market siz|territory|coverage/i,
    ['segmentation', 'territory design', 'coverage model', 'go-to-market strategy']],
  [/retention|churn|\bNRR\b|\bGRR\b|renewal|expansion/i,
    ['retention', 'metric definition', 'compensation design']],
  [/hiring|interview|team|onboard|enable|teach|train|adoption/i,
    ['hiring', 'enablement', 'adoption', 'team building']],
  [/prioriti|mandate|scope|stakeholder|operating model|own(ing|ership)?\b/i,
    ['prioritization', 'function ownership', 'operating model', 'operational ownership']],
  [/handoff|continuity|document|leave|transition/i,
    ['documentation', 'team continuity', 'operational ownership']],
  [/funnel|win rate|conversion|pipeline health|deal size/i,
    ['sales funnel metrics', 'win rate analysis', 'variance to plan']],
];

const STOP = new Set(['the','and','for','with','that','this','from','have','has','are','was','you','your',
  'joe','about','what','how','does','did','can','would','a','an','of','to','in','on','is','it','at','as','be','or']);

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9&/+ ]+/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w)),
  );
}

/** Higher is more relevant. Deterministic — same inputs, same ordering. */
export function scoreStory(story: Story, query: string): number {
  const q = query.toLowerCase();
  const qTokens = tokenize(query);
  let score = 0;

  for (const tag of story.maps_to ?? []) {
    const t = tag.toLowerCase();
    if (q.includes(t)) score += 6;                                  // whole tag phrase present
    else {
      const overlap = [...tokenize(tag)].filter(w => qTokens.has(w)).length;
      if (overlap) score += Math.min(overlap, 3) * 1.5;             // partial, capped
    }
  }

  for (const [pattern, tags] of SYNONYMS) {
    if (!pattern.test(query)) continue;
    for (const tag of tags) if ((story.maps_to ?? []).includes(tag)) score += 4;
  }

  const titleOverlap = [...tokenize(story.title)].filter(w => qTokens.has(w)).length;
  score += Math.min(titleOverlap, 4) * 0.75;

  return score;
}

/**
 * Top-scoring stories for a query. Ties break on original bundle order so the
 * result is stable across identical requests.
 */
export function selectStories(stories: Story[], query: string, limit = DEFAULT_LIMIT): Story[] {
  const n = Math.max(1, Math.min(limit, MAX_LIMIT));
  if (!stories.length) return [];

  const scored = stories.map((story, index) => ({ story, index, score: scoreStory(story, query) }));
  const relevant = scored.filter(s => s.score > 0);

  // Nothing matched — a greeting, or a question about something the library does
  // not cover. Send a broad default rather than nothing, so the bot still has
  // something concrete to reach for.
  const pool = relevant.length ? relevant : scored.slice(0, n);
  pool.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return pool.slice(0, n).map(s => s.story);
}

/** One line per story: enough for the model to know what else exists and offer it. */
export function buildStoryIndex(stories: Story[]): string[] {
  return stories.map(s => `${s.title} — [${(s.maps_to ?? []).join(', ')}]`);
}

export function buildStoriesMessage(selected: Story[]): string {
  if (!selected.length) return '';
  return [
    '## Stories loaded for this question',
    '',
    'These are the full stories most relevant to what was just asked, chosen from the wider library.',
    '**Answer from these.** Tell one properly rather than mentioning several. The `key_decisions` are the',
    'judgment calls — what he chose, and what he chose not to do. The `follow_up_detail` is what to reach',
    'for when someone pushes for specifics.',
    '',
    'The index in the bundle lists everything else. If a question is better served by a story not loaded',
    'here, say it exists, describe it in a sentence, and offer to go into it — do not improvise the detail.',
    '',
    '```json',
    JSON.stringify(selected, null, 2),
    '```',
  ].join('\n');
}
