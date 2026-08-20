import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { resolveVaultPath } from "../security.js";

// ---------------------------------------------------------------------------
// Minimal stub of ToolContext / McpServer so we can call registerEditNote
// without spinning up a real MCP server.
// ---------------------------------------------------------------------------
type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

function makeStubServer() {
  const handlers: Map<string, Handler> = new Map();
  return {
    tool(name: string, _desc: string, _schema: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
    call(name: string, args: Record<string, unknown>) {
      const h = handlers.get(name);
      if (!h) throw new Error(`No handler for tool: ${name}`);
      return h(args);
    },
  };
}

// ---------------------------------------------------------------------------
// Setup: create a tmp vault dir and register the tool against it.
// ---------------------------------------------------------------------------
let vaultDir: string;
let server: ReturnType<typeof makeStubServer>;

async function setup() {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "obs-edit-test-"));
  server = makeStubServer();

  // Dynamically import so the module resolves relative to dist/.
  const { registerEditNote } = await import("../tools/editNote.js");
  registerEditNote(server as any, { config: { vaultResolved: vaultDir } as any });
}

async function call(args: Record<string, unknown>) {
  return server.call("edit_note", args);
}

async function writeNote(rel: string, content: string) {
  const full = path.join(vaultDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

async function readNote(rel: string) {
  return fs.readFile(path.join(vaultDir, rel), "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
await setup();

test("replaces a middle range of lines", async () => {
  await writeNote("mid.md", "line1\nline2\nline3\nline4\nline5");
  const res = await call({ path: "mid.md", start_line: 2, end_line: 3, new_content: "NEW" });
  assert.equal(res.isError, undefined);
  assert.equal(await readNote("mid.md"), "line1\nNEW\nline4\nline5");
});

test("replaces the first line", async () => {
  await writeNote("first.md", "line1\nline2\nline3");
  await call({ path: "first.md", start_line: 1, end_line: 1, new_content: "REPLACED" });
  assert.equal(await readNote("first.md"), "REPLACED\nline2\nline3");
});

test("replaces the last line", async () => {
  await writeNote("last.md", "line1\nline2\nline3");
  await call({ path: "last.md", start_line: 3, end_line: 3, new_content: "REPLACED" });
  assert.equal(await readNote("last.md"), "line1\nline2\nREPLACED");
});

test("inserts when end_line === start_line - 1", async () => {
  await writeNote("insert.md", "line1\nline2\nline3");
  await call({ path: "insert.md", start_line: 2, end_line: 1, new_content: "INSERTED" });
  assert.equal(await readNote("insert.md"), "line1\nINSERTED\nline2\nline3");
});

test("deletes lines when new_content is empty string", async () => {
  await writeNote("delete.md", "line1\nline2\nline3");
  await call({ path: "delete.md", start_line: 2, end_line: 2, new_content: "" });
  assert.equal(await readNote("delete.md"), "line1\nline3");
});

test("fails when start_line is out of range", async () => {
  await writeNote("oor.md", "line1\nline2");
  const res = await call({ path: "oor.md", start_line: 10, end_line: 10, new_content: "x" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /out of range/);
});

test("fails when end_line is out of range", async () => {
  await writeNote("oor2.md", "line1\nline2");
  const res = await call({ path: "oor2.md", start_line: 1, end_line: 10, new_content: "x" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /out of range/);
});

test("fails when end_line < start_line - 1", async () => {
  await writeNote("bad.md", "line1\nline2\nline3");
  const res = await call({ path: "bad.md", start_line: 3, end_line: 1, new_content: "x" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /must be/);
});

test("fails when note does not exist", async () => {
  const res = await call({ path: "nonexistent.md", start_line: 1, end_line: 1, new_content: "x" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /does not exist/);
});

test("blocks path traversal", async () => {
  try {
    const res = await call({ path: "../../etc/passwd", start_line: 1, end_line: 1, new_content: "x" });
    // If resolveVaultPath didn't throw, the tool should still fail
    assert.equal(res.isError, true);
  } catch (err: any) {
    // resolveVaultPath threw PathTraversalError — that's also correct
    assert.match(err.message ?? err.toString(), /traversal|outside|vault/i);
  }
});
