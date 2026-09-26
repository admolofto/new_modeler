import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolReply } from '../src/ai/bridgeProtocol.ts';
import { MCP_INSTRUCTIONS } from '../src/ai/prompt.ts';
import { mcpToolDefs } from '../src/ai/tools.ts';

/**
 * The modeler as an MCP server (streamable HTTP, stateless). Tool schemas are the same
 * registry-generated ones the API engine uses; `call` decides where a tool runs (the open
 * browser tab for the dev server, an in-memory draft for evals).
 */

export type ToolCaller = (name: string, input: unknown) => Promise<ToolReply>;

export function createMcpHandler(call: ToolCaller) {
  const tools = mcpToolDefs().map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.input_schema }));

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // A fresh server per request: stateless, and nothing leaks between clients.
    const server = new Server({ name: 'modeler', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        const out = await call(name, args ?? {});
        return { content: [{ type: 'text', text: out.content }], isError: out.isError };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}
