import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs/promises";
import { resolveVaultPath } from "../security.js";
import { ok, fail, ToolContext } from "./types.js";

/**
 * Edits a range of lines in an existing note without overwriting the whole file.
 *
 * Safety choices:
 * - Path goes through resolveVaultPath() — same traversal guard as every other tool.
 * - File must already exist; this tool is not a creator (use write_note for that).
 * - Setting end_line === start_line - 1 is a pure insert: no lines are removed.
 * - Out-of-range indices are rejected with a descriptive error rather than silently
 *   clamped, so the agent gets clear feedback when it miscounts.
 */
export function registerEditNote(server: McpServer, { config }: ToolContext): void {
  server.tool(
    "edit_note",
    "Replaces a range of lines in an existing note. Read the note first to determine line numbers. " +
    "Setting end_line to start_line - 1 inserts new_content without removing any lines.",
    {
      path: z.string().describe("Path to the note relative to the vault root (e.g., \"Folder/My Note.md\")"),
      start_line: z.number().int().min(1).describe("First line to replace (1-indexed)"),
      end_line: z.number().int().describe(
        "Last line to replace (1-indexed, inclusive). " +
        "Use start_line - 1 to insert new_content without removing any lines."
      ),
      new_content: z.string().describe("Content that replaces the specified line range (may be empty string to delete lines)"),
    },
    async ({ path: notePath, start_line, end_line, new_content }) => {
      try {
        const fullPath = resolveVaultPath(config.vaultResolved, notePath);

        // Ensure the note exists — edit_note is not a creator.
        let original: string;
        try {
          original = await fs.readFile(fullPath, "utf-8");
        } catch {
          return fail(`Note does not exist: ${notePath}`);
        }

        // Split preserving the original line structure.
        const lines = original.split("\n");
        const lineCount = lines.length;

        // end_line === start_line - 1 is a valid insert (removes 0 lines).
        // Anything below that is nonsensical.
        if (end_line < start_line - 1) {
          return fail(
            `end_line (${end_line}) must be >= start_line - 1 (${start_line - 1})`
          );
        }

        if (start_line > lineCount + 1) {
          return fail(
            `start_line (${start_line}) is out of range — note has ${lineCount} line${lineCount === 1 ? "" : "s"}`
          );
        }

        if (end_line > lineCount) {
          return fail(
            `end_line (${end_line}) is out of range — note has ${lineCount} line${lineCount === 1 ? "" : "s"}`
          );
        }

        const removedCount = end_line - start_line + 1; // 0 when inserting
        const insertLines = new_content === "" ? [] : new_content.split("\n");

        // splice is 0-indexed; start_line is 1-indexed.
        lines.splice(start_line - 1, Math.max(0, removedCount), ...insertLines);

        await fs.writeFile(fullPath, lines.join("\n"), "utf-8");

        const action =
          removedCount <= 0
            ? `Inserted ${insertLines.length} line${insertLines.length === 1 ? "" : "s"} before line ${start_line} in ${notePath}`
            : `Replaced lines ${start_line}–${end_line} in ${notePath} (${removedCount} → ${insertLines.length} line${insertLines.length === 1 ? "" : "s"})`;

        return ok(action);
      } catch (err: any) {
        return fail(`Error editing note: ${err.message}`);
      }
    }
  );
}
