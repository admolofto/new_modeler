import type { ViteDevServer } from 'vite';
import { BRIDGE, type BridgeCall, type BridgeResult, type ToolReply } from '../src/ai/bridgeProtocol.ts';
import type { ToolCaller } from './mcp.ts';

/**
 * Forwards MCP tool calls to the open modeler tab over Vite's HMR websocket. The model and
 * the pending proposal live in the page, so that's where tools run. The tab that most
 * recently loaded or gained focus handles calls.
 */

type Client = { send(event: string, payload?: unknown): void };

export function createBridge(server: ViteDevServer, timeoutMs = 30_000): ToolCaller {
  let active: Client | undefined;
  let next = 1;
  const waiting = new Map<number, (r: ToolReply) => void>();

  server.ws.on(BRIDGE.hello, (_data: unknown, client: Client) => {
    active = client;
  });
  server.ws.on(BRIDGE.result, (data: BridgeResult) => {
    waiting.get(data.id)?.(data.result);
    waiting.delete(data.id);
  });

  return (name, input) =>
    new Promise<ToolReply>((resolve, reject) => {
      const url = server.resolvedUrls?.local[0] ?? 'the dev server URL';
      if (!active) return reject(new Error(`The modeler isn't open — open ${url} in a browser, then try again.`));
      const id = next++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`The modeler tab didn't respond — make sure ${url} is open (reload it if needed).`));
      }, timeoutMs);
      waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      active.send(BRIDGE.call, { id, name, input } satisfies BridgeCall);
    });
}
