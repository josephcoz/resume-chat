// Worker entry. Routes:
//   POST /api/chat  → chat handler (Workers AI proxy + output filter)
//   anything else   → static assets from /public via the ASSETS binding

import { handleChat } from './chat';

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      // Last line of defence. handleChat absorbs the failures it can name; this
      // catches anything it cannot, so an unexpected throw still reaches the
      // visitor as a readable reply rather than a Cloudflare error page.
      try {
        return await handleChat(request, env);
      } catch (err) {
        console.error('unhandled error in handleChat:', err instanceof Error ? err.stack : String(err));
        const text =
          "Sorry — something went wrong on my end and I can't answer right now. " +
          'Joe is reachable directly at **josephcoz@gmail.com**, and his resume is ' +
          '[here](/joe-cj-resume.pdf).';
        return new Response(
          `data: ${JSON.stringify({ response: text })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } },
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};
