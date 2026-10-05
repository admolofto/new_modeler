import { describe, expect, it } from 'vitest';
import { readCliStream, type CliEvent } from './cliTransport';

function stream(text: string, size = 3) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
    controller.close();
  } });
}

describe('CLI reply streams', () => {
  it('reads split JSON and UTF-8, including the final line without a newline', async () => {
    const events: CliEvent[] = [];
    await readCliStream(stream('\n{"type":"session","id":"codex-1"}\n{"type":"text","text":"36″ shelf ✓"}\n{"type":"done","isError":false}'), (event) => events.push(event));
    expect(events).toEqual([{ type: 'session', id: 'codex-1' }, { type: 'text', text: '36″ shelf ✓' }, { type: 'done', isError: false }]);
  });

  it('surfaces provider errors and incomplete connections', async () => {
    await expect(readCliStream(stream('{"type":"error","message":"Sign in to Codex"}'), () => undefined)).rejects.toThrow('Sign in to Codex');
    await expect(readCliStream(stream('{"type":"text","text":"partial"}\n'), () => undefined)).rejects.toThrow('closed before');
  });
});
