import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostedAi } from './hosted.ts';

/**
 * The Vercel function behind /api/ai/* (bundled by scripts/build-vercel.mjs). Vercel rewrites
 * /api/ai/<path> to this function with ?path=<path>.
 */
const handle = hostedAi(process.env);

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return handle(req, res, url.searchParams.get('path') ?? url.pathname.replace(/^\/api\/ai\/?/, ''));
}
