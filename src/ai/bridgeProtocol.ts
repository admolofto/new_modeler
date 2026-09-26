/** Custom HMR events between the dev server's MCP endpoint and the open modeler tab. */
export const BRIDGE = { hello: 'modeler:hello', call: 'modeler:call', result: 'modeler:result' } as const;

export interface ToolReply {
  content: string;
  isError: boolean;
}
export interface BridgeCall {
  id: number;
  name: string;
  input: unknown;
}
export interface BridgeResult {
  id: number;
  result: ToolReply;
}
