# resume-chat

A small chatbot that lets recruiters ask questions about my background.
The model is grounded in a hand-curated summary I prepared — no live access
to my work data, no naming of customers or coworkers, no compensation
discussion. Anything the bot doesn't cover, the recruiter is invited to
reach out to me directly.

— Joe Cosby-Johnson

## How it's built

- **Frontend:** static HTML/CSS/JS in `public/`. No framework.
- **Backend:** a Cloudflare Worker (`src/index.ts` → `src/chat.ts`) serving the
  static assets via the `ASSETS` binding. Calls Cloudflare Workers AI
  (Llama 3.3 70B Instruct) via the `AI` binding — no API key in the repo.
- **Hosting:** Cloudflare Workers (`resume-chat.josephcoz.workers.dev`).

## Safety story

Three layers of defense, in order of importance:

1. **Data minimization.** The model only ever sees `context/joe-public.json` —
   a hand-curated bundle that contains no customer names, no coworker names,
   no dollar amounts, no internal metrics. The original second-brain stays
   on my machine; only this sanitized summary ships.
2. **Build-time linter.** `scripts/sanitize-check.js` scans the bundle on
   every build for blocklisted names, currency patterns, and proprietary
   keywords. CI fails the deploy if anything trips. Try it:
   ```bash
   npm run lint
   ```
3. **Runtime output filter.** `src/chat.ts` regex-sweeps the
   streamed response chunk-by-chunk. If a blocklisted token slips through
   the model anyway, the function aborts the stream and emits a generic
   refusal message.

The system prompt (`context/system-prompt.md`) adds a fourth layer of
behavioral guardrails, but the bundle is the primary defense — the model
literally cannot leak what isn't there.

### Link retrieval

The model has no browsing ability. Without help it answers a pasted job-posting
URL from the slug alone — inventing plausible requirements and matching against
them. That failure is silent, so `src/linkFetch.ts` fetches the page server-side
and hands it over as explicitly-labelled untrusted data. Guards:

- **https only**, public hostnames only; loopback, RFC1918, link-local and
  `.internal` / `.local` are rejected (`isSafeUrl`).
- **Bounded work** — 8s timeout, 512KB read ceiling, 10k characters to the
  model, at most 2 URLs per turn, newest user message only.
- **Currency stripped on the way in.** Partly Joe's no-compensation rule, partly
  mechanical: the runtime output filter aborts the stream on a money pattern, so
  a posting's salary band echoed back mid-answer would look like a crash.
  Redacting on ingest means the model never sees it.
- **Injection containment** — retrieved text is wrapped in an untrusted-data
  envelope; the system prompt instructs the model to treat it as data, ignore
  embedded instructions, and tell the user when it finds them.

Failures are reported to the model rather than swallowed, so it says "I couldn't
open that, please paste the text" instead of guessing.

Run `npm test` to exercise URL validation, HTML extraction, and redaction
locally — no network, no Workers runtime.

## Layout

```
resume-chat/
├── public/
│   ├── index.html              # chat UI
│   ├── styles.css
│   ├── app.js                  # SSE client
│   └── joe-cj-resume.pdf       # canonical B&W resume
├── functions/
│   └── api/
│       ├── chat.ts             # Pages Function (Workers AI proxy + filter)
│       └── _systemPrompt.ts    # AUTO-GENERATED from /context/system-prompt.md
├── context/
│   ├── joe-public.json         # the only Joe-context the LLM sees
│   └── system-prompt.md        # behavioral guardrails (canonical source)
├── scripts/
│   └── sanitize-check.js       # pre-deploy linter + prompt regenerator
├── wrangler.toml
├── package.json
└── tsconfig.json
```

## Local development

```bash
npm install
npm run dev          # runs lint + wrangler pages dev
```

The first run will prompt for Cloudflare auth.

## Deploy

```bash
npm run deploy       # runs lint + wrangler pages deploy
```

Or push to `main` if you've connected the repo to a Cloudflare Pages
project — CF will run the build, lint, and publish automatically.

## Editing the bundle

If I want to change what the bot knows about me, I edit:

- `context/joe-public.json` — the structured facts
- `context/system-prompt.md` — the behavioral guardrails

Then run `npm run lint`. The lint step regenerates `_systemPrompt.ts` from
the markdown and verifies the bundle is clean. Deploy after it passes.

## Cost

Cloudflare Pages and the Workers AI free tier (10k Neurons/day) cover
expected recruiter traffic with room to spare.
