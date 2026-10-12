import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostedAi } from './hosted.ts';

describe('hosted AI endpoints', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const handle = hostedAi({ APP_ACCESS_CODE: 'Oak-1234', ANTHROPIC_API_KEY: 'test' });
    server = createServer((req, res) => void handle(req, res, new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/api\/ai\//, '')));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai/`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  const get = (path: string, code?: string) => fetch(base + path, { headers: code ? { 'x-access-code': code } : {} });

  it('reports only the API engine, and whether the access code is right', async () => {
    const without = await (await get('config')).json();
    expect(without).toMatchObject({ hosted: true, access: 'needed', api: { hasKey: true }, claudeCode: { available: false }, codex: { available: false } });
    expect((await (await get('config', ' oak-1234 ')).json()).access).toBe('ok');
    expect((await (await get('config', 'oak-123')).json()).access).toBe('needed');
  });

  it('refuses AI calls without the access code', async () => {
    const res = await fetch(base + 'messages', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect((await get('models')).status).toBe(401);
  });

  it('checks the request once the code is right', async () => {
    expect((await get('models', 'oak-1234')).status).toBe(200);
    const res = await fetch(base + 'messages', { method: 'POST', headers: { 'x-access-code': 'oak-1234' }, body: '{}' });
    expect(res.status).toBe(400);
    expect((await get('codex', 'oak-1234')).status).toBe(404);
  });

  it('is closed when no access code is configured', async () => {
    const handle = hostedAi({ ANTHROPIC_API_KEY: 'test' });
    const closed = createServer((req, res) => void handle(req, res, 'models'));
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
    const res = await fetch(`http://127.0.0.1:${(closed.address() as AddressInfo).port}/`, { headers: { 'x-access-code': '' } });
    expect(res.status).toBe(401);
    await new Promise<void>((done) => closed.close(() => done()));
  });
});
