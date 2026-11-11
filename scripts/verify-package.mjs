/** Smoke-test a separately installed release package over real stdio MCP, with temporary saves. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = process.argv[2];
assert.ok(entry, 'pass the installed package mcp/server.mjs path');
const dataDir = await mkdtemp(path.join(tmpdir(), 'math-board-release-'));
const client = new Client({ name: 'release-smoke-test', version: '1' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(entry)],
    env: { ...process.env, MATH_BOARD_DATA_DIR: dataDir, MATH_BOARD_NO_BROWSER: '1' },
    stderr: 'inherit',
  }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), [
    'board_docs', 'board_library', 'board_open', 'board_read', 'board_save', 'board_snapshot', 'board_update',
  ]);
  for (const name of ['board_open', 'board_read']) {
    const result = await client.callTool({ name, arguments: {} });
    assert.ok(!result.isError, `${name} returned an error`);
    assert.ok(result.content.length, `${name} returned no content`);
  }
  console.log('Installed release package: MCP handshake, seven tools, board_open and board_read passed.');
} finally {
  await client.close();
  await rm(dataDir, { recursive: true, force: true });
}
