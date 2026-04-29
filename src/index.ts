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
      return handleChat(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
