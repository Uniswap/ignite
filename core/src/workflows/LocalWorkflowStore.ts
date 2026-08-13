import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowDocument, WorkflowSummary } from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { KeyedMutex } from '../utils/KeyedMutex.js';
import { WorkflowHttpError, hashWorkflowRaw, parseWorkflowDocument, validateWorkflowName } from './WorkflowDocumentReader.js';

const MAX_LIST_ENTRIES = 256;

export interface LocalWorkflowStoreDeps {
  fileSystem: Pick<FileSystem, 'getProfileLocalWorkflowsPath'>;
  devMode: () => boolean;
}

export class LocalWorkflowStore {
  private static readonly mutex = new KeyedMutex();
  private readonly deps: LocalWorkflowStoreDeps;

  constructor(deps?: Partial<LocalWorkflowStoreDeps>) {
    this.deps = {
      fileSystem: deps?.fileSystem ?? FileSystem.getInstance(),
      devMode: deps?.devMode ?? (() => process.env.NODE_ENV === 'development'),
    };
  }

  async list(profileId: string): Promise<{ workflows: WorkflowSummary[]; truncated: boolean }> {
    const directory = this.directory(profileId);
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { workflows: [], truncated: false };
      throw error;
    }
    const candidates = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
    const workflows: WorkflowSummary[] = [];
    for (const entry of candidates.slice(0, MAX_LIST_ENTRIES)) {
      const name = entry.name.slice(0, -5);
      try {
        const { document } = await this.read(profileId, name);
        workflows.push(summary(name, document));
      } catch (error) {
        workflows.push({ name, valid: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { workflows, truncated: candidates.length > MAX_LIST_ENTRIES };
  }

  async read(profileId: string, name: string): Promise<{ document: WorkflowDocument; raw: string; docHash: string }> {
    validateWorkflowName(name);
    let raw: string;
    try { raw = await fs.readFile(this.file(profileId, name), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkflowHttpError(404, 'WORKFLOW_NOT_FOUND', `Workflow ${name} was not found`);
      throw error;
    }
    return { document: parseWorkflowDocument(raw, this.deps.devMode()), raw, docHash: hashWorkflowRaw(raw) };
  }

  async write(profileId: string, name: string, document: WorkflowDocument, baseDocHash?: string): Promise<string> {
    validateWorkflowName(name);
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    return LocalWorkflowStore.mutex.run(`${profileId}\0${name}`, async () => {
      const file = this.file(profileId, name);
      let current: string | null;
      try { current = await fs.readFile(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') current = null;
        else throw error;
      }
      if (current !== null) {
        if (!baseDocHash) throw new WorkflowHttpError(409, 'WORKFLOW_BASE_HASH_REQUIRED', 'baseDocHash is required when updating an existing workflow');
        if (hashWorkflowRaw(current) !== baseDocHash) throw new WorkflowHttpError(409, 'WORKFLOW_DOC_CONFLICT', 'Workflow changed since it was loaded');
      } else if (baseDocHash) throw new WorkflowHttpError(409, 'WORKFLOW_DELETED', 'Workflow was deleted since it was loaded');
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
      try {
        await fs.writeFile(temporary, raw, 'utf8');
        await fs.rename(temporary, file);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      return hashWorkflowRaw(raw);
    });
  }

  private directory(profileId: string): string { return this.deps.fileSystem.getProfileLocalWorkflowsPath(profileId); }
  private file(profileId: string, name: string): string { return path.join(this.directory(profileId), `${name}.json`); }
}

function summary(name: string, document: WorkflowDocument): WorkflowSummary {
  return { name, valid: true, ...(document.description ? { description: document.description } : {}), sourceCount: document.sources.length, stepCount: document.steps.length, hooks: document.outputs.hooks };
}
