import { BRIDGE, type BridgeCall, type BridgeResult } from '../ai/bridgeProtocol';
import type { Proposals } from './proposals';

/**
 * Answers AI tool calls forwarded by the dev server (server/bridge.ts), so Claude Code,
 * Codex, and external MCP clients all work on this tab's model. Dev only.
 */
export function connectBridge(proposals: Proposals): void {
  const hot = import.meta.hot;
  if (!hot) return;
  const hello = () => hot.send(BRIDGE.hello, {});
  hello();
  hot.on('vite:ws:connect', hello);
  window.addEventListener('focus', hello);

  hot.on(BRIDGE.call, ({ id, name, input }: BridgeCall) => {
    let result: BridgeResult['result'];
    try {
      const out = proposals.runTool(name, input);
      result = { content: out.content, isError: out.isError };
    } catch (err) {
      result = { content: `tool failed: ${(err as Error).message}`, isError: true };
    }
    hot.send(BRIDGE.result, { id, result } satisfies BridgeResult);
  });
}
