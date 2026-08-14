import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { deleteOrArchiveProject } from '@/modules/projects/services/project-delete.service.js';

const PROJECT_PATH = '/workspace/delete-me';

async function withIsolatedDatabase(
  runTest: (workspace: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-delete-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('deleting a project takes every session in it, archived ones included', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const transcript = path.join(workspace, 'claude-session.jsonl');
    await writeFile(transcript, '{}\n', 'utf8');

    const { project } = projectsDb.createProjectPath(PROJECT_PATH);
    assert.ok(project);

    sessionsDb.createSession('claude-1', 'claude', PROJECT_PATH, 'Active', undefined, undefined, transcript);
    sessionsDb.createSession('claude-2', 'claude', PROJECT_PATH, 'Archived');
    sessionsDb.updateSessionIsArchived('claude-2', true);
    assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(PROJECT_PATH).length, 2);

    await deleteOrArchiveProject(project.project_id, true);

    // An archived session left behind would be re-indexed later and re-create
    // the very project row this call just removed.
    assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(PROJECT_PATH).length, 0);
    assert.equal(projectsDb.getProjectById(project.project_id), null);
    assert.equal(fsSync.existsSync(transcript), false, 'the transcript file should be gone');
  });
});

test('archiving a project leaves its sessions alone', async () => {
  await withIsolatedDatabase(async () => {
    const { project } = projectsDb.createProjectPath(PROJECT_PATH);
    assert.ok(project);
    sessionsDb.createSession('claude-1', 'claude', PROJECT_PATH, 'Active');

    await deleteOrArchiveProject(project.project_id, false);

    assert.equal(projectsDb.getProjectById(project.project_id)?.isArchived, 1);
    assert.equal(sessionsDb.getSessionsByProjectPathIncludingArchived(PROJECT_PATH).length, 1);
  });
});
