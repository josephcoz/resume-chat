// Recruiter-facing chat handler. Streams Llama 3.3 70B from Cloudflare
// Workers AI, grounded in a hand-curated context bundle and a strict
// system prompt. Output is filtered chunk-by-chunk against a blocklist
// of names and money patterns before forwarding to the client — the
// model never has those in context, but this is belt-and-suspenders.

import publicBundle from '../context/joe-public.json';
import { extractUrls, fetchPageText, buildRetrievedMessage } from './linkFetch';
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

const REFUSAL_TEXT =
  "I can't share specifics on that. Joe is happy to talk numbers and names directly — " +
  "you can reach him at josephcoz@gmail.com or via LinkedIn (linkedin.com/in/joe-cosby-johnson).";

function buildSystemPrompt(): string {
  return [
    systemPromptText.trim(),
    '',
    '---',
    '',
    '## Joe context bundle (the only Joe-information you may use)',
    '',
    '```json',
    JSON.stringify(publicBundle, null, 2),
    '```',
  ].join('\n');
}

function detectViolation(text: string): string | null {
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
  const grounding = [
    { role: 'system', content: buildSystemPrompt() },
    ...retrieved.map(content => ({ role: 'system', content })),
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

  const messages = [...trimmed, ...grounding];

  // Workers AI streaming. Returns a ReadableStream of SSE-formatted chunks.
  const aiStream = (await env.AI.run(MODEL, {
    messages,
    max_tokens: MAX_TOKENS,
    stream: true,
  })) as unknown as ReadableStream;

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
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ response: '\n\n[stream error]' })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });
}
