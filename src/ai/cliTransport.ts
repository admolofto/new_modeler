export type CliEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; sessionId?: string; text?: string; isError: boolean; hint?: string; outputTokens?: number };

/** Shared Claude Code / Codex stream. Network chunks need not align with NDJSON lines. */
export async function readCliStream(body: ReadableStream<Uint8Array>, onEvent: (event: CliEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let completed = false;
  const line = (raw: string) => {
    if (!raw.trim()) return;
    const event = JSON.parse(raw) as CliEvent;
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'done') completed = true;
    onEvent(event);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { buf += decoder.decode(); break; }
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    line(buf);
    if (!completed) throw new Error('The AI connection closed before the reply finished. Try again.');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
