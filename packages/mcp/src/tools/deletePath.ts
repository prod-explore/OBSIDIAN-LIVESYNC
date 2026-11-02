import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  ARCHIVE_PREFIX,
  CALENDAR_FOLDER,
  SYSTEMS_FOLDER,
  TASKS_FOLDER,
  syncFolderKind,
  type SyncFolderKind,
} from 'obsidian-livesync-shared';
import type { Config } from '../config.js';
import { isTrashPath, resolveVaultPath } from '../security.js';
import { moveToTrash } from '../trash.js';
import { errorCode, errorMessage, isFileMissing } from '../errors.js';
import { ok, fail, tooManyWrites, ToolContext, ToolTextResult } from './types.js';

/**
 * `delete_path`: deletes a note or an empty folder, whichever the path turns out to be (the counterpart of `get_path`).
 *
 * - A note is moved into the vault's trash folder, never unlinked: an AI client, or a batch of calls that goes wrong,
 *   must not be able to destroy a note beyond recovery. Trashed names carry a timestamp, so deleting the same path
 *   twice keeps both copies.
 * - A folder is removed only while it is empty, with a plain (non-recursive) rmdir. The trash is not reachable through
 *   this server, so a folder with anything in it could not be restored; and rmdir checks emptiness and removes in one
 *   step, so a note written into the folder after any check of ours makes it fail rather than vanish with the folder.
 *   The folder's contents are listed only after it was refused, for the message.
 * - The vault root, links to folders and the folders the Google sync is built on are refused even when empty: a task
 *   list's folder stands for a list in Google (see refusal()).
 *
 * One call removes at most one note or one empty folder.
 */
export function registerDeletePath(server: McpServer, ctx: ToolContext): void {
  const { config } = ctx;
  server.tool(
    'delete_path',
    'Deletes a note or an empty folder — auto-detected from the path. A note is moved to the vault trash folder ' +
      '(soft delete — it can be restored). A folder is removed only if it is completely empty; a folder with anything ' +
      'in it is refused, never deleted recursively. The vault root and the folders the Google sync manages cannot be deleted.',
    {
      path: z.string().describe('Path to a note or an empty folder, relative to the vault root'),
    },
    async ({ path: target }) => {
      const limited = tooManyWrites(ctx);
      if (limited) return limited;
      try {
        const fullPath = resolveVaultPath(config.vaultResolved, target, { trashDir: config.trashDir });

        const stat = await fs.stat(fullPath).catch((err: unknown) => {
          throw isFileMissing(err) ? new Error(`Nothing to delete: ${target} does not exist`) : err;
        });
        if (stat.isFile()) {
          const trashedPath = await moveToTrash(config.vaultResolved, config.trashDir, target);
          return ok(`Moved to trash: ${target} → ${trashedPath}`);
        }
        if (stat.isDirectory()) return await deleteEmptyFolder(config, target, fullPath);
        return fail(`Not a note or a folder: ${target}`);
      } catch (err) {
        return fail(`Error deleting path: ${errorMessage(err)}`);
      }
    },
  );
}

async function deleteEmptyFolder(config: Config, target: string, fullPath: string): Promise<ToolTextResult> {
  const refused = await refusal(config.vaultResolved, target, fullPath);
  if (refused) return fail(refused);

  try {
    await fs.rmdir(fullPath);
  } catch (err) {
    // Linux reports a folder that is not empty as ENOTEMPTY; POSIX also allows EEXIST.
    if (errorCode(err) === 'ENOTEMPTY' || errorCode(err) === 'EEXIST') {
      return fail(await notEmpty(config, target, fullPath));
    }
    if (isFileMissing(err)) return fail(`Nothing to delete: ${target} does not exist`);
    throw err;
  }
  return ok(`Deleted empty folder: ${target}`);
}

/**
 * Why a folder must stay even when empty, or undefined when it may go. Checked on the path as given and on the path
 * after following links, so a link to `{Tasks}` is no way round it.
 */
async function refusal(vaultRoot: string, target: string, fullPath: string): Promise<string | undefined> {
  // rmdir would refuse a link anyway; this says why in words.
  if ((await fs.lstat(fullPath)).isSymbolicLink()) {
    return `Not deleted: ${target} is a link to a folder; only a real, empty folder can be deleted`;
  }
  const given = path.relative(vaultRoot, fullPath);
  const real = path.relative(await fs.realpath(vaultRoot), await fs.realpath(fullPath));
  if (given === '' || real === '') return 'Not deleted: the vault root cannot be deleted';
  const kind = syncFolderKind(given) ?? syncFolderKind(real);
  return kind && `Not deleted: ${target} ${WHY[kind]}`;
}

const WHY: Record<SyncFolderKind, string> = {
  layout:
    `is part of the layout the Google sync relies on (${TASKS_FOLDER}, ${CALENDAR_FOLDER}, ${ARCHIVE_PREFIX} and its ` +
    `two mirrors, ${SYSTEMS_FOLDER}) and cannot be deleted, even when empty`,
  'task-list':
    'is the folder of a Google Tasks list (or its archive mirror), which the sync keeps in step with the list. ' +
    'Deleting the folder would delete the list in Google with all its tasks, including any the vault does not hold ' +
    '(added in Google since the last sync, or completed and archived), and Google Tasks has no undo. To remove the ' +
    'list, delete it in Google Tasks; the sync then moves its folders to the trash',
  'calendar-month':
    'is a month folder of the Google sync, which writes event notes into it as they arrive, and cannot be deleted, ' +
    'even when empty',
};

/** The refusal of a folder rmdir found not empty, saying what is in it. Listed only now, and only for the message. */
async function notEmpty(config: Config, target: string, fullPath: string): Promise<string> {
  const names = await fs.readdir(fullPath).catch(() => undefined);
  if (names === undefined) return `Folder ${target} is not empty: delete or move its notes and subfolders first`;
  if (names.length === 0) {
    return `Folder ${target} is not empty: its contents changed while it was being deleted; check it with get_path and try again`;
  }

  // What get_path does not show: hidden entries (.DS_Store, .obsidian) and the trash folder.
  const hidden = names
    .filter(
      (name) => name.startsWith('.') || isTrashPath(config.vaultResolved, path.join(fullPath, name), config.trashDir),
    )
    .sort();
  const items = plural(names.length, 'item');
  if (hidden.length === 0) {
    return `Folder ${target} is not empty (${items}): delete or move its notes and subfolders first`;
  }

  const shown =
    hidden.length > 5 ? `${hidden.slice(0, 5).join(', ')} and ${hidden.length - 5} more` : hidden.join(', ');
  if (hidden.length === names.length) {
    return (
      `Folder ${target} is not empty: it holds only ${plural(hidden.length, 'hidden item')} (${shown}), which this ` +
      'server cannot reach or delete; they have to be removed from the vault folder on the server itself'
    );
  }
  return (
    `Folder ${target} is not empty (${items}, ${hidden.length} of them hidden: ${shown}): delete or move its notes ` +
    'and subfolders first; the hidden ones cannot be reached or deleted through this server and have to be removed ' +
    'from the vault folder on the server itself'
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
