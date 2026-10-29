// Registry smoke check (not behaviour testing): spawn the built server over stdio, list tools, assert shape.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const home = mkdtempSync(join(tmpdir(), 'instagram-mcp-smoke-'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/cli.js', 'serve'],
  env: { ...process.env, INSTAGRAM_MCP_HOME: home, INSTAGRAM_MCP_CONFIG: '', INSTAGRAM_MCP_TEST_MODE: '1' },
  stderr: 'inherit'
});
const client = new Client({ name: 'smoke', version: '0.0.0' });

let failed = false;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; };

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  if (new Set(names).size !== names.length) fail('duplicate tool names');
  for (const t of tools) {
    if (!/^instagram_[a-z0-9_]+$/.test(t.name)) fail(`bad tool name ${t.name}`);
    if (!t.description) fail(`${t.name}: missing description`);
    if (!t.annotations || typeof t.annotations.readOnlyHint !== 'boolean') fail(`${t.name}: missing annotations`);
    if (t.inputSchema?.type !== 'object') fail(`${t.name}: inputSchema is not an object schema`);
  }
  console.log(`${tools.length} tools:`);
  for (const t of tools) console.log(`  ${t.name}  [readOnly=${t.annotations?.readOnlyHint} destructive=${t.annotations?.destructiveHint} openWorld=${t.annotations?.openWorldHint}]`);
} catch (error) {
  fail(String(error));
} finally {
  await client.close().catch(() => {});
}
process.exit(failed ? 1 : 0);
