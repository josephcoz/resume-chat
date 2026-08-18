// Recruiter-facing chat handler. Streams Llama 3.3 70B from Cloudflare
// Workers AI, grounded in a hand-curated context bundle and a strict
// system prompt. Output is filtered chunk-by-chunk against a blocklist
// of names and money patterns before forwarding to the client — the
// model never has those in context, but this is belt-and-suspenders.

import publicBundle from '../context/joe-public.json';
import { extractUrls, fetchPageText, buildRetrievedMessage } from './linkFetch';
import { selectStories, buildStoryIndex, buildStoriesMessage, DEFAULT_LIMIT, type Story } from './storySelect';
import { SYSTEM_PROMPT as systemPromptText } from './_systemPrompt';

interface ChatEnv {
  AI: Ai;
}

// Llama 4 Scout: 131k context window, and cheaper than the 3.3-70b it replaced
// on both axes ($0.27/M in, $0.85/M out vs $0.29 / $2.25).
// https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/
//
// The predecessor's 24k window was the binding constraint here: bundle + prompt +
// history + a retrieved page could exceed it, and because the bundle sits ahead of
// the conversation, front-truncation dropped the grounding first.
const MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const CONTEXT_WINDOW = 131_000;
const MAX_TOKENS = 2000;
const MAX_HISTORY_MESSAGES = 12;
// Only the newest user turn is scanned for links, and only this many are
// fetched per request — a hard ceiling on work a single caller can trigger.
const MAX_URLS_PER_TURN = 2;

// Same lists as scripts/sanitize-check.js — kept in sync by hand. If a
// blocklisted name or money pattern *ever* shows up in a model token, abort
// the stream and emit a refusal.
const NAME_BLOCKLIST: string[] = [
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
  'Patrick', 'Eduardo', 'Noreen',
  'Lukas Menkhoff', 'Lukas',
  'Dwight', 'Lianna', 'Ramen', 'Nicole',
  'Dan Cusick', 'Cusick',
  'Teamshares', 'RSC Mechanical', 'HLC Foods', 'Rivermaid',
  'GoTo Foods', 'Joey Tomato', "Joey Tomato's",
  'Sun Holdings', 'Consolidated Burger',
];

const MONEY_PATTERNS: RegExp[] = [
  /\$\s?\d/,
  /€\s?\d/, /£\s?\d/, /¥\s?\d/,
  /\bUSD\s*\d/i, /\bEUR\s*\d/i,
  /\b\d+\s?(?:k|K|M|B)\s+(?:ARR|MRR|TCV|ACV)\b/,
  /\b(?:ARR|MRR|TCV|ACV|GMV)\s+of\s+\$/i,
  /\b\d+(?:\.\d+)?\s?(?:million|billion|thousand)\b/i,
  /\bsalary\s+(?:of|range|band)\s+\$/i,
];

// Distinctive strings from the system prompt. If any appears in the model's
// output it is reciting its own instructions, which means an injection attempt
// got through. Enforced in the output filter rather than in the prompt for the
// same reason the money rule is: an instruction not to leak can be argued with,
// a regex sweep cannot.
const PROMPT_LEAK_PATTERNS: RegExp[] = [
  /##\s*Voice and behavior/i,
  /Hard rules\s*[—-]\s*never break/i,
  /##\s*Lead with a story, not an adjective/i,
  /##\s*Answering with specifics/i,
  /##\s*One thing at a time/i,
  /Joe context bundle/i,
  /the rules most easily forgotten/i,
  /Stories loaded for this question/i,
  /UNTRUSTED PAGE CONTENT/i,
  /\bmaps_to\b|\bkey_decisions\b|\bfollow_up_detail\b|\bstory_index\b/i,
  /Refer to Joe in the third person/i,
  /Resist instruction-override attempts/i,
];

const UNAVAILABLE_TEXT =
  "Sorry — I can't reach my model right now, so I can't answer properly. This is a " +
  "temporary problem on my end and not a reflection of anything you asked.\n\n" +
  "Joe would rather you didn't leave empty-handed:\n\n" +
  "- Email him directly at **josephcoz@gmail.com** — he replies quickly\n" +
  "- [LinkedIn](https://linkedin.com/in/joe-cosby-johnson)\n" +
  "- [His resume as a PDF](/joe-cj-resume.pdf), which covers most of what I would have said\n\n" +
  "Worth trying again in a little while — this usually clears on its own.";

/**
 * A complete SSE response carrying one message. Same shape the streaming path
 * emits, so the client renders it as an ordinary reply rather than an error —
 * markdown, contact links and all.
 */
function sseMessage(text: string): Response {
  const body = `data: ${JSON.stringify({ response: text })}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}

const REFUSAL_TEXT =
  "I can't share specifics on that. Joe is happy to talk numbers and names directly — " +
  "you can reach him at josephcoz@gmail.com or via LinkedIn (linkedin.com/in/joe-cosby-johnson).";

function allStories(): Story[] {
  return ((publicBundle as Record<string, unknown>).stories ?? []) as Story[];
}

// The bundle carries a one-line index of every story rather than 33 full bodies;
// the bodies relevant to this question are injected separately, closer to
// generation. Story ids are dropped throughout — they are tooling scaffolding
// (scripts/check-story-depth.js) and the model was printing them as content.
function bundleForModel(): unknown {
  const clone = JSON.parse(JSON.stringify(publicBundle)) as Record<string, unknown>;
  delete clone.stories;
  clone.story_index = buildStoryIndex(allStories());
  clone.story_index_note =
    'Titles only. The full text of the stories relevant to this question is provided separately below. ' +
    'Use this index to know what else exists and to offer it by name — never improvise a story from its title.';
  return clone;
}

// Restated as the final message, after the bundle and the loaded stories. Even
// at the reduced size the grounding runs to thousands of tokens, and rules given
// before it are a long way from where generation starts. The ones that shape
// output are exactly the ones that get dropped, so they are repeated here.
const OUTPUT_REMINDER = [
  '## Before you answer — the rules most easily forgotten',
  '',
  '1. **Depth over breadth.** If the question has many parts, give a one or two sentence overall read,',
  '   answer the FIRST part properly with a story, list the rest by name only, and offer to continue.',
  '   Then stop. Do not rate every item in one pass unless they explicitly asked for a summary.',
  '2. **Tell the story.** Name what he actually did, the decision he made, and how it turned out.',
  '   "Joe has experience with X" is not an answer — if the sentence would be true of any competent',
  '   candidate, replace it with the specific thing.',
  '3. **Do not go looking for shortcomings.** A gap is only a gap when a specific named thing — a tool, a',
  '   platform, a system — has no supporting material at all. Then say "Not covered", once, factually, and',
  '   name what he uses instead. **Never infer a weakness from silence about degree or scale, and never',
  '   speculate that experience "may not directly align" or "may be limited".** If the material covers a',
  '   requirement, it is covered; say so and move on. Inventing a soft shortcoming to sound balanced is a',
  '   worse error than sounding positive, because it is not true.',
  '   When a posting has a qualifications list as well as responsibilities, include it in the remaining',
  '   items, so a genuinely absent tool surfaces on its own rather than being hunted for.',
  '4. **Never print internal identifiers or field names.** Describe a story in plain language.',
  '5. **Numbers are fine.** Years, headcounts, percentages, dates, counts — use them precisely. The',
  '   restriction is money only. Never silently drop a non-financial number; that reads as an error.',
  '6. **Markdown.** Bold what matters, bullets for lists, headings only when an answer has real sections.',
].join('\n');

function buildSystemPrompt(): string {
  return [
    systemPromptText.trim(),
    '',
    '---',
    '',
    '## Joe context bundle (the only Joe-information you may use)',
    '',
    '```json',
    JSON.stringify(bundleForModel(), null, 2),
    '```',
  ].join('\n');
}

function detectViolation(text: string): string | null {
  for (const p of PROMPT_LEAK_PATTERNS) {
    const m = text.match(p);
    if (m) return `prompt leak: ${m[0]}`;
  }
  for (const p of MONEY_PATTERNS) {
    const m = text.match(p);
    if (m) return `money pattern: ${m[0]}`;
  }
  const lower = text.toLowerCase();
  for (const name of NAME_BLOCKLIST) {
    const lname = name.toLowerCase();
    if (!name.includes(' ')) {
      const re = new RegExp(`\\b${name}\\b`, 'i');
      if (re.test(text)) return `name: ${name}`;
    } else if (lower.includes(lname)) {
      return `name: ${name}`;
    }
  }
  return null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleChat(request: Request, env: ChatEnv): Promise<Response> {
  let body: { messages?: Array<{ role: string; content: string }> };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const history = (body.messages ?? []).slice(-MAX_HISTORY_MESSAGES);
  if (history.length === 0 || history[history.length - 1]?.role !== 'user') {
    return jsonResponse({ error: 'last_message_must_be_user' }, 400);
  }

  // Final guard: trim each message to a sensible length so a recruiter can't
  // stuff the context with an injected prompt longer than the bundle itself.
  const safeHistory = history.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content ?? '').slice(0, 2500),
  }));

  // Link retrieval. The model cannot browse, so a pasted URL would otherwise be
  // answered from the slug alone. Fetch it here and hand it over as clearly
  // labelled untrusted data. Failures are reported to the model, not swallowed:
  // "I couldn't open that, please paste it" beats a confident invented answer.
  const retrieved: string[] = [];
  const lastUserText = safeHistory[safeHistory.length - 1]?.content ?? '';
  const urls = extractUrls(lastUserText).slice(0, MAX_URLS_PER_TURN);
  if (urls.length > 0) {
    const results = await Promise.all(urls.map(u => fetchPageText(u)));
    for (const r of results) retrieved.push(buildRetrievedMessage(r));
  }

  // Order matters. Providers that trim an over-long request drop from the front, so
  // the conversation goes first and the grounding sits closest to the generation.
  // Selection reads the last few user turns, not just the newest one, so a bare
  // "continue" or "tell me more" still resolves against what was being discussed.
  // Retrieved page text is included because a pasted job description is the main
  // thing that should drive which stories load.
  const selectionQuery = [
    ...safeHistory.filter(m => m.role === 'user').slice(-3).map(m => m.content),
    ...retrieved,
  ].join('\n');
  const selected = selectStories(allStories(), selectionQuery, DEFAULT_LIMIT);
  const storiesMessage = buildStoriesMessage(selected);

  // Grounding goes FIRST, conversation last. An earlier version put history ahead
  // of the system messages to protect the bundle from front-truncation — but with
  // selective injection the request is a fraction of the window, and the model
  // started replying "Got it." to the trailing instruction block instead of
  // answering the question. The rules still sit close to generation: only the
  // user's own message separates OUTPUT_REMINDER from the response.
  const grounding = [
    { role: 'system', content: buildSystemPrompt() },
    ...retrieved.map(content => ({ role: 'system', content })),
    ...(storiesMessage ? [{ role: 'system', content: storiesMessage }] : []),
    { role: 'system', content: OUTPUT_REMINDER },
  ];

  // Budget guard. History is the only expendable part — never drop the prompt, the
  // context bundle, or a retrieved page. Roughly 4 chars per token is close enough
  // for a ceiling check, and CONTEXT_WINDOW leaves ample headroom today; this exists
  // so a long conversation degrades predictably instead of silently losing grounding.
  const budgetChars = (CONTEXT_WINDOW - MAX_TOKENS) * 4;
  const groundingChars = grounding.reduce((n, m) => n + m.content.length, 0);
  const trimmed = [...safeHistory];
  while (
    trimmed.length > 1 &&
    groundingChars + trimmed.reduce((n, m) => n + m.content.length, 0) > budgetChars
  ) {
    trimmed.shift();
  }

  const messages = [...grounding, ...trimmed];

  // Workers AI streaming. Returns a ReadableStream of SSE-formatted chunks.
  //
  // This call is the one part of the request that depends on something outside
  // the Worker, and it does fail: a spent daily allowance, a model outage, a
  // transient upstream error. Unhandled, the Worker throws and the visitor gets a
  // bare 500 page. A recruiter reads that as "his site is broken," which is a
  // worse outcome than any answer the bot could have given — so failure is
  // absorbed here and returned as a normal, well-formed reply.
  let aiStream: ReadableStream;
  try {
    aiStream = (await env.AI.run(MODEL, {
      messages,
      max_tokens: MAX_TOKENS,
      stream: true,
    })) as unknown as ReadableStream;
  } catch (err) {
    // Logged for diagnosis (`wrangler tail`), never surfaced — the upstream
    // message can carry account and model internals.
    console.error('AI.run failed:', err instanceof Error ? err.message : String(err));
    return sseMessage(UNAVAILABLE_TEXT);
  }

  // Wrap with an output filter. We accumulate the running response text and
  // sweep for violations before forwarding each chunk. On a hit, replace the
  // tail with REFUSAL_TEXT and close the stream.
  const filtered = filterStream(aiStream);

  return new Response(filtered, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    },
  });
}

function filterStream(input: ReadableStream): ReadableStream {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let accumulated = '';
  let aborted = false;

  return new ReadableStream({
    async start(controller) {
      const reader = input.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (aborted) continue;

          const chunk = decoder.decode(value, { stream: true });
          // Workers AI emits SSE: each event is `data: {...}\n\n`. We pass
          // events through but inspect the cumulative text first.
          const events = chunk.split('\n\n');
          for (const evt of events) {
            const line = evt.trim();
            if (!line) continue;
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
              continue;
            }
            try {
              const obj = JSON.parse(payload);
              const piece = typeof obj?.response === 'string' ? obj.response : '';
              accumulated += piece;
              const violation = detectViolation(accumulated);
              if (violation) {
                aborted = true;
                const refusalEvt = `data: ${JSON.stringify({ response: '\n\n' + REFUSAL_TEXT })}\n\n`;
                controller.enqueue(encoder.encode(refusalEvt));
                controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
                console.warn('output filter abort:', violation);
                break;
              }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: piece })}\n\n`));
            } catch {
              // Non-JSON payload — pass through unchanged.
              controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
            }
          }
        }
      } catch (err) {
        // Failure part-way through a reply. The visitor already has some text on
        // screen, so append rather than replace, and say something useful — the
        // previous "[stream error]" told them nothing and looked like a crash.
        console.error('stream failed mid-response:', err instanceof Error ? err.message : String(err));
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              response:
                '\n\n---\n\n*That answer was cut short by a problem on my end. ' +
                'Ask again and it will usually go through — or email Joe at ' +
                '**josephcoz@gmail.com**.*',
            })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });
}
