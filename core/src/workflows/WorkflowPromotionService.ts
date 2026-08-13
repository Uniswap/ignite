import crypto from 'node:crypto';
import type {
  AddressBookEntry,
  BookPointer,
  DeploymentPlan,
  RunRecord,
  WorkflowDocument,
  WorkflowPromoteData,
  WorkflowPromoteRequest,
  WorkflowRequiredPlugin,
  RepoWorkflowSource,
  WorkflowSource,
  WorkflowSummary,
} from '@ignite/api';
import { AddressBookEntryNamePattern, makeWorkflowDocumentSchema, stripGitUrlCredentials, WorkflowNamePattern } from '@ignite/api';
import { normalizeRepoUrl } from '@ignite/plugin-types';
import { RepoService, type PromotionSourceInspection } from '../repos/RepoService.js';
import { VersionStore, type VersionRecord } from '../repos/VersionStore.js';
import { RunStore } from '../deployments/RunStore.js';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { PluginManager } from '../filesystem/PluginManager.js';
import { VerificationQueue } from '../verifications/VerificationQueue.js';
import { renderArtifact } from '../deployments/artifact.js';
import { ArtifactFreezeService } from '../deployments/ArtifactFreezeService.js';
import type { FrozenInputs } from '@ignite/api';
import { AddressBookService, addressBookRelPath, resolveBookEntry, type ContextualBook } from '../addressBook/AddressBookService.js';
import { MAX_ADDRESS_BOOK_BYTES, hashAddressBookRaw, normalizeAddressBookEntries, parseAddressBook } from '../addressBook/AddressBookStore.js';

type PreviewRequest = Extract<WorkflowPromoteRequest, { mode: 'preview' }>;
type ApplyRequest = Extract<WorkflowPromoteRequest, { mode: 'apply' }>;
type PreviewData = Extract<WorkflowPromoteData, { mode: 'preview' }>;
type ApplyData = Extract<WorkflowPromoteData, { mode: 'apply' }>;

interface WorkflowFiles {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, contents: string): Promise<void>;
  restoreFile(path: string, contents: string | null): Promise<void>;
}
interface PreviewSnapshot {
  target: string;
  inputKey: string;
  sources: PreviewData['sources'];
  inspections: Map<string, PromotionSourceInspection>;
  referencedEntries: PreviewData['referencedEntries'];
  targetBookHash: string;
  targetEntries: AddressBookEntry[];
}
export interface WorkflowPromotionServiceDeps {
  inspectSource: (pathOrUrl: string) => Promise<PromotionSourceInspection>;
  readTargetFile: (repo: string, file: string, profileId: string) => Promise<string | null>;
  withWorkflowWriteLock: <T>(repo: string, fn: (files: WorkflowFiles) => Promise<T>, profileId: string) => Promise<T>;
  getRun: (profileId: string, runId: string) => Promise<RunRecord | undefined>;
  getRequiredPlugin: (id: string) => Promise<WorkflowRequiredPlugin>;
  renderRunArtifact: (profileId: string, runId: string) => Promise<unknown>;
  freezeInputs: (profileId: string, plan: DeploymentPlan) => Promise<FrozenInputs>;
  validateTargetRepo: (repo: string) => Promise<boolean>;
  getVersionRecord: (url: string, commit: string) => Promise<VersionRecord | undefined>;
  contextualBook: (profileId: string, workflow?: { repoPathOrUrl: string }) => Promise<ContextualBook>;
}

export class WorkflowPromotionError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 422, readonly code: string, message: string) { super(message); }
}

export class WorkflowPromotionService {
  private readonly deps: WorkflowPromotionServiceDeps;
  private readonly previews = new Map<string, PreviewSnapshot>();

  constructor(deps?: Partial<WorkflowPromotionServiceDeps>) {
    const repos = RepoService.getInstance();
    this.deps = {
      inspectSource: deps?.inspectSource ?? ((value) => repos.inspectPromotionSource(value)),
      readTargetFile: deps?.readTargetFile ?? (async (repo, file, profileId) => {
        const result = await repos.getFile(repo, file, profileId);
        if (result.success) return result.data.content;
        if (result.error.code === 'FILE_NOT_FOUND') return null;
        throw Object.assign(new Error(result.error.message), { code: result.error.code });
      }),
      withWorkflowWriteLock: deps?.withWorkflowWriteLock ?? ((repo, fn, profileId) => repos.withWorkflowWriteLock(repo, fn, profileId)),
      getRun: deps?.getRun ?? ((profileId, runId) => new RunStore().get(profileId, runId)),
      getRequiredPlugin: deps?.getRequiredPlugin ?? requiredPlugin,
      renderRunArtifact: deps?.renderRunArtifact ?? (async (profileId, runId) => {
        const run = await new RunStore().get(profileId, runId);
        if (!run) throw new WorkflowPromotionError(404, 'DEPLOYMENT_RUN_NOT_FOUND', `Deployment run not found: ${runId}`);
        const tasks = await VerificationQueue.getInstance().store.list(profileId, { runId });
        return renderArtifact(run, tasks);
      }),
      freezeInputs: deps?.freezeInputs ?? ((profileId, plan) => new ArtifactFreezeService().freezeInputs(profileId, plan.contracts)),
      validateTargetRepo: deps?.validateTargetRepo ?? ((repo) => repos.isExistingGitRepository(repo)),
      getVersionRecord: deps?.getVersionRecord ?? ((url, commit) => new VersionStore().get(url, commit)),
      contextualBook: deps?.contextualBook ?? ((profileId, workflow) => new AddressBookService().contextual(profileId, workflow)),
    };
  }

  async promote(request: PreviewRequest, profileId: string): Promise<PreviewData>;
  async promote(request: ApplyRequest, profileId: string): Promise<ApplyData>;
  async promote(request: WorkflowPromoteRequest, profileId: string): Promise<WorkflowPromoteData> {
    this.validateTarget(request.target);
    return request.mode === 'preview' ? this.preview(request, profileId) : this.apply(request, profileId);
  }

  private async preview(request: PreviewRequest, profileId: string): Promise<PreviewData> {
    if (!(await this.deps.validateTargetRepo(request.target.repoPathOrUrl)))
      throw new WorkflowPromotionError(422, 'PROMOTION_TARGET_INVALID', 'Promotion target must be an existing git repository');
    const { plan, run } = await this.resolveInput(request, profileId);
    const sources: PreviewData['sources'] = [];
    const inspections = new Map<string, PromotionSourceInspection>();
    for (const source of plan.contracts) {
      if (source.origin === 'contract-type') {
        sources.push({ sourceId: source.id, origin: 'contract-type', commit: source.contentHash, tagChoices: [], dirty: false });
        continue;
      }
      if (source.pin) {
        sources.push({ sourceId: source.id, origin: source.pin.url, commit: source.pin.commit, tagChoices: source.pin.refKind === 'tag' && source.pin.ref ? [source.pin.ref] : [], dirty: false });
        continue;
      }
      try {
        const inspected = await this.deps.inspectSource(source.repoPathOrUrl);
        const normalized = { ...inspected, origin: promotionOrigin(inspected.origin), tags: [...inspected.tags].sort() };
        inspections.set(source.id, normalized);
        sources.push({ sourceId: source.id, origin: normalized.origin, commit: normalized.commit, tagChoices: normalized.tags, dirty: normalized.dirty });
      } catch (error) {
        sources.push({ sourceId: source.id, origin: '', commit: '', tagChoices: [], dirty: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const file = workflowPath(request.target.name);
    const nameCollision = (await this.deps.readTargetFile(request.target.repoPathOrUrl, file, profileId)) !== null;
    const targetBookRaw = (await this.deps.readTargetFile(request.target.repoPathOrUrl, addressBookRelPath, profileId)) ?? '';
    let targetEntries: AddressBookEntry[] = [];
    try {
      targetEntries = targetBookRaw ? parseAddressBook(targetBookRaw).entries : [];
    } catch (error) {
      throw new WorkflowPromotionError(422, 'PROMOTION_TARGET_BOOK_INVALID', `Target address book is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const referencedEntries = await this.referencedEntries(plan, run, profileId, targetEntries);
    const previewId = crypto.randomUUID();
    this.previews.set(previewId, { target: targetKey(request.target), inputKey: inputKey(request), sources, inspections, referencedEntries, targetBookHash: hashAddressBookRaw(targetBookRaw), targetEntries });
    while (this.previews.size > 128) this.previews.delete(this.previews.keys().next().value!);
    return { mode: 'preview', previewId, sources, referencedEntries, nameCollision };
  }

  private async apply(request: ApplyRequest, profileId: string): Promise<ApplyData> {
    const snapshot = this.previews.get(request.previewId);
    if (!snapshot || snapshot.target !== targetKey(request.target) || snapshot.inputKey !== inputKey(request))
      throw new WorkflowPromotionError(409, 'PROMOTION_PREVIEW_STALE', 'Promotion preview is missing or no longer matches this request');
    const { plan, run } = await this.resolveInput(request, profileId);
    const previewErrors = snapshot.sources.filter((source) => source.error);
    if (previewErrors.length) throw new WorkflowPromotionError(422, 'PROMOTION_SOURCE_INVALID', previewErrors.map((source) => `${source.sourceId}: ${source.error}`).join('; '));

    const pins = new Map<string, RepoWorkflowSource['repo']>();
    for (const source of plan.contracts) {
      if (source.origin === 'contract-type') continue;
      if (source.pin) { pins.set(source.id, globalThis.structuredClone(source.pin)); continue; }
      const before = snapshot.inspections.get(source.id);
      if (!before) throw new WorkflowPromotionError(409, 'PROMOTION_PREVIEW_STALE', `Source ${source.id} was not resolved by the preview`);
      let current: PromotionSourceInspection;
      try { current = await this.deps.inspectSource(source.repoPathOrUrl); }
      catch { throw new WorkflowPromotionError(409, 'PROMOTION_PREVIEW_STALE', `Source ${source.id} can no longer be inspected`); }
      const currentOrigin = promotionOrigin(current.origin);
      if (currentOrigin !== before.origin || current.commit !== before.commit)
        throw new WorkflowPromotionError(409, 'PROMOTION_PREVIEW_STALE', `Source ${source.id} HEAD or origin changed since preview`);
      const tags = [...current.tags].sort();
      let ref: string | undefined;
      let refKind: 'tag' | 'branch' | undefined;
      if (tags.length === 1) { ref = tags[0]; refKind = 'tag'; }
      else if (tags.length > 1) {
        ref = request.tagChoiceBySourceId?.[source.id];
        if (!ref || !tags.includes(ref)) throw new WorkflowPromotionError(422, 'PROMOTION_TAG_CHOICE_REQUIRED', `Choose one tag for source ${source.id}`);
        refKind = 'tag';
      } else if (current.branch) { ref = current.branch; refKind = 'branch'; }
      pins.set(source.id, { url: currentOrigin, commit: current.commit, ...(ref ? { ref, refKind } : {}) });
    }

    let document: WorkflowDocument;
    try { document = await this.buildDocument(plan, run, pins, request.hooks, profileId); }
    catch (error) {
      if (error instanceof WorkflowPromotionError) throw error;
      throw new WorkflowPromotionError(422, 'PROMOTION_DOCUMENT_INVALID', error instanceof Error ? error.message : String(error));
    }
    const addressBook = this.applyBookChoices(snapshot.referencedEntries, request.bookChoices ?? {}, snapshot.targetEntries);
    if (addressBook.renames.size) rewriteBookPointers(document, addressBook.renames);
    try {
      document = makeWorkflowDocumentSchema({ allowFileUrls: process.env.NODE_ENV === 'development' }).parse(document);
    } catch (error) {
      throw new WorkflowPromotionError(422, 'PROMOTION_DOCUMENT_INVALID', error instanceof Error ? error.message : String(error));
    }
    const warnings = await this.localFallbackWarnings(plan, pins);
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    const docHash = crypto.createHash('sha256').update(raw).digest('hex');
    const uniqueAdoptions = [...new Set(request.adoptRunIds ?? [])];
    // Resolve every adopted run against the current profile and render every
    // artifact before entering the write transaction. A bad adoption can
    // therefore never leave the workflow file applied on its own.
    const adoptedArtifacts = new Map<string, string>();
    for (const runId of uniqueAdoptions) {
      if (!(await this.deps.getRun(profileId, runId)))
        throw new WorkflowPromotionError(404, 'DEPLOYMENT_RUN_NOT_FOUND', `Deployment run not found: ${runId}`);
      const artifact = await this.deps.renderRunArtifact(profileId, runId);
      adoptedArtifacts.set(runId, `${JSON.stringify(artifact, null, 2)}\n`);
    }
    await this.deps.withWorkflowWriteLock(request.target.repoPathOrUrl, async (files) => {
      const existing = await files.readFile(workflowPath(request.target.name));
      if (existing !== null && !request.overwrite)
        throw new WorkflowPromotionError(409, 'WORKFLOW_NAME_CONFLICT', `Workflow ${request.target.name} already exists`);
      let priorBook: string | null = null;
      let wroteBook = false;
      let wroteWorkflow = false;
      const priorArtifacts = new Map<string, string | null>();
      const writtenArtifacts: string[] = [];
      try {
      if (snapshot.referencedEntries.length) {
        priorBook = await files.readFile(addressBookRelPath);
        const currentBook = priorBook ?? '';
        if (hashAddressBookRaw(currentBook) !== snapshot.targetBookHash) throw new WorkflowPromotionError(409, 'PROMOTION_BOOK_CONFLICT', 'Target address book changed since preview');
        let currentEntries: AddressBookEntry[];
        try {
          currentEntries = currentBook ? parseAddressBook(currentBook).entries : [];
        } catch (error) {
          throw new WorkflowPromotionError(422, 'PROMOTION_TARGET_BOOK_INVALID', `Target address book is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
        const entries = normalizeAddressBookEntries(mergePromotionEntries(currentEntries, addressBook.copies));
        const bookRaw = `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`;
        if (Buffer.byteLength(bookRaw) > MAX_ADDRESS_BOOK_BYTES) throw new WorkflowPromotionError(422, 'PROMOTION_TARGET_BOOK_TOO_LARGE', 'Target address book would exceed 256 KiB');
        await files.writeFile(addressBookRelPath, bookRaw);
        wroteBook = true;
      }
      await files.writeFile(workflowPath(request.target.name), raw);
      wroteWorkflow = true;
      for (const runId of uniqueAdoptions) {
        const artifactPath = `ignite/deployments/${request.target.name}/${runId}.json`;
        priorArtifacts.set(artifactPath, await files.readFile(artifactPath));
        await files.writeFile(artifactPath, adoptedArtifacts.get(runId)!);
        writtenArtifacts.push(artifactPath);
      }
      } catch (error) {
        for (const artifactPath of writtenArtifacts.reverse()) await files.restoreFile(artifactPath, priorArtifacts.get(artifactPath) ?? null);
        if (wroteWorkflow) await files.restoreFile(workflowPath(request.target.name), existing);
        if (wroteBook) await files.restoreFile(addressBookRelPath, priorBook);
        throw error;
      }
    }, profileId);
    this.previews.delete(request.previewId);
    return { mode: 'apply', workflow: summary(request.target.name, document), docHash, ...(warnings.length ? { warnings } : {}) };
  }

  private async referencedEntries(plan: DeploymentPlan, run: RunRecord | undefined, profileId: string, targetEntries: AddressBookEntry[]): Promise<PreviewData['referencedEntries']> {
    if (run?.bookResolutions) return referencesFromRun(run, targetEntries);
    const needed = bookPointerChains(plan);
    if (!needed.size) return [];
    const book = await this.deps.contextualBook(profileId);
    return [...needed.entries()].map(([name, chainIds]) => {
      const entry = book.file.entries.find((candidate) => candidate.name === name);
      if (!entry) throw new WorkflowPromotionError(422, 'PROMOTION_BOOK_ENTRY_MISSING', `Address book entry ${name} no longer exists`);
      const resolutions = Object.fromEntries([...chainIds].map((chainId) => {
        const address = resolveBookEntry(entry, chainId);
        if (!address) throw new WorkflowPromotionError(422, 'PROMOTION_BOOK_ENTRY_UNRESOLVED', `Address book entry ${name} is unresolved on chain ${chainId}`);
        return [String(chainId), address];
      }));
      return promotionBookPreview(entry, resolutions, book.source, book.bookHash, targetEntries);
    });
  }

  private applyBookChoices(referenced: PreviewData['referencedEntries'], choices: NonNullable<ApplyRequest['bookChoices']>, targetEntries: AddressBookEntry[]): { copies: AddressBookEntry[]; renames: Map<string, string> } {
    const copies: AddressBookEntry[] = [];
    const renames = new Map<string, string>();
    const used = new Set<string>();
    for (const item of referenced) {
      if (!item.targetEntry) {
        copies.push(item.entry);
        used.add(item.name);
        continue;
      }
      if (!item.conflict) {
        used.add(item.name);
        continue;
      }
      const choice = choices[item.name];
      if (!choice) throw new WorkflowPromotionError(422, 'PROMOTION_BOOK_CHOICE_REQUIRED', `Choose how to resolve address book entry ${item.name}`);
      if (choice.action === 'keep-repo') {
        used.add(item.name);
        continue;
      }
      if (!AddressBookEntryNamePattern.test(choice.name)) throw new WorkflowPromotionError(422, 'PROMOTION_BOOK_NAME_INVALID', `Address book entry name is invalid: ${choice.name}`);
      if (used.has(choice.name) || targetEntries.some((candidate) => candidate.name === choice.name)) throw new WorkflowPromotionError(422, 'PROMOTION_BOOK_NAME_CONFLICT', `Address book entry already exists: ${choice.name}`);
      used.add(choice.name);
      copies.push({ ...item.entry, name: choice.name });
      renames.set(item.name, choice.name);
    }
    return { copies, renames };
  }

  private async buildDocument(plan: DeploymentPlan, run: RunRecord | undefined, pins: Map<string, RepoWorkflowSource['repo']>, hooks: string[], profileId: string): Promise<WorkflowDocument> {
    const frozen = run?.inputs ?? await this.deps.freezeInputs(profileId, plan).catch(() => undefined);
    const sourceIdMap = new Map<string, string>();
    const sourceIds = new Set<string>();
    const sources: WorkflowSource[] = plan.contracts.map((source) => {
      const id = mintWorkflowSourceId(source.contractName, sourceIds);
      sourceIdMap.set(source.id, id);
      if (source.origin === 'contract-type') return {
        id, origin: 'contract-type', contractName: source.contractName,
        pluginId: source.pluginId, artifactKey: source.artifactKey,
        versionLabel: source.versionLabel, contentHash: source.contentHash,
      };
      return {
        id, repo: pins.get(source.id)!, frameworkId: source.frameworkId, sourcePath: source.sourcePath,
        contractName: source.contractName, artifactPath: source.artifactPath,
        ...(frozen?.[source.id]?.artifactHash ? { artifactHash: frozen[source.id].artifactHash } : {}),
      };
    });
    const pluginIds = new Set<string>([...sources.map((source) => source.origin === 'contract-type' ? source.pluginId : source.frameworkId), ...hooks]);
    for (const step of plan.steps)
      if (step.kind === 'deploy' && step.strategy?.kind === 'plugin') pluginIds.add(step.strategy.pluginId);
    const requiredPlugins = await Promise.all([...pluginIds].sort().map((id) => this.deps.getRequiredPlugin(id)));
    const steps = plan.steps.map((step) => {
      const copy = globalThis.structuredClone(step) as typeof step & { signerOverride?: unknown };
      delete copy.signerOverride;
      remapStepContractIds(copy, sourceIdMap);
      return copy;
    });
    const candidate = { schemaVersion: 1 as const, sources, steps, requiredPlugins, outputs: { hooks: [...hooks] } };
    return makeWorkflowDocumentSchema({ allowFileUrls: process.env.NODE_ENV === 'development' }).parse(candidate);
  }

  private async localFallbackWarnings(plan: DeploymentPlan, pins: Map<string, RepoWorkflowSource['repo']>): Promise<string[]> {
    const warnings: string[] = [];
    for (const source of plan.contracts) {
      if (source.origin === 'contract-type') continue;
      const pin = pins.get(source.id);
      if (!pin || !(await this.deps.getVersionRecord(pin.url, pin.commit))?.localFallback) continue;
      warnings.push(`The commit for ${source.contractName} is not on the remote and teammates cannot install it.`);
    }
    return warnings;
  }

  private async resolveInput(request: Pick<WorkflowPromoteRequest, 'plan' | 'runId'>, profileId: string): Promise<{ plan: DeploymentPlan; run?: RunRecord }> {
    if (request.plan) return { plan: globalThis.structuredClone(request.plan) };
    if (!request.runId) throw new WorkflowPromotionError(400, 'PROMOTION_INPUT_REQUIRED', 'Exactly one of plan or runId is required');
    const run = await this.deps.getRun(profileId, request.runId);
    if (!run) throw new WorkflowPromotionError(404, 'DEPLOYMENT_RUN_NOT_FOUND', `Deployment run not found: ${request.runId}`);
    return { plan: hydrateRunBookPointers(run), run };
  }

  private validateTarget(target: { repoPathOrUrl: string; name: string }): void {
    if (!WorkflowNamePattern.test(target.name)) throw new WorkflowPromotionError(400, 'WORKFLOW_NAME_INVALID', 'Workflow name is invalid');
  }
}

async function requiredPlugin(id: string): Promise<WorkflowRequiredPlugin> {
  const config = await PluginRegistryLoader.getInstance().getPluginConfig(id).catch(() => undefined);
  if (!config) throw new WorkflowPromotionError(422, 'PROMOTION_PLUGIN_MISSING', `Required plugin is not installed: ${id}`);
  const source = config.origin === 'installed' ? await PluginManager.getInstance().getInstallSource(id) : undefined;
  return {
    id, version: config.metadata.version,
    ...(source?.kind === 'git' ? { source: { kind: 'git' as const, url: stripGitUrlCredentials(source.url), ...(source.ref ? { ref: source.ref } : {}), ...(source.track ? { track: source.track } : {}), ...(source.commit ? { commit: source.commit } : {}) } } : {}),
  };
}
function workflowPath(name: string): string { return `ignite/workflows/${name}.json`; }
function targetKey(target: { repoPathOrUrl: string; name: string }): string { return `${target.repoPathOrUrl}\0${target.name}`; }
function inputKey(request: Pick<WorkflowPromoteRequest, 'plan' | 'runId'>): string {
  return request.runId ? `run:${request.runId}` : `plan:${crypto.createHash('sha256').update(JSON.stringify(request.plan)).digest('hex')}`;
}
function summary(name: string, document: WorkflowDocument): WorkflowSummary {
  return { name, valid: true, sourceCount: document.sources.length, stepCount: document.steps.length, hooks: document.outputs.hooks };
}
function promotionOrigin(origin: string): string {
  const normalized = normalizeRepoUrl(origin);
  try {
    const url = new URL(normalized);
    if (url.username || url.password) throw new Error('credentials are not allowed');
    if (url.protocol === 'https:' || (process.env.NODE_ENV === 'development' && url.protocol === 'file:')) return normalized;
  } catch (error) {
    if (error instanceof WorkflowPromotionError) throw error;
  }
  throw new WorkflowPromotionError(422, 'PROMOTION_ORIGIN_UNSUPPORTED', 'origin must be a credential-free HTTPS URL (or file:// in development)');
}

function mintWorkflowSourceId(contractName: string, used: Set<string>): string {
  const name = contractName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'contract';
  let counter = 1;
  while (used.has(`${name}-${counter}`)) counter += 1;
  const id = `${name}-${counter}`;
  used.add(id);
  return id;
}

function remapStepContractIds(step: unknown, sourceIds: Map<string, string>): void {
  if (!step || typeof step !== 'object') return;
  const record = step as Record<string, unknown>;
  if (record.kind === 'deploy' && typeof record.contractId === 'string')
    record.contractId = sourceIds.get(record.contractId) ?? record.contractId;
  remapEncodeContractIds(record, sourceIds);
}

function remapEncodeContractIds(value: unknown, sourceIds: Map<string, string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry) => remapEncodeContractIds(entry, sourceIds));
    return;
  }
  const record = value as Record<string, unknown>;
  const encoded = record.$encode;
  if (encoded && typeof encoded === 'object' && !Array.isArray(encoded)) {
    const encode = encoded as Record<string, unknown>;
    if (typeof encode.contractId === 'string')
      encode.contractId = sourceIds.get(encode.contractId) ?? encode.contractId;
  }
  Object.values(record).forEach((entry) => remapEncodeContractIds(entry, sourceIds));
}

function bookPointerChains(plan: DeploymentPlan): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  visitBookPointers(plan.steps, (pointer) => { if (!result.has(pointer.$book.name)) result.set(pointer.$book.name, new Set()); });
  for (const chainId of plan.chains) {
    for (const step of plan.steps) {
      const values = { ...(step.args ?? {}), ...(step.argsPerChain?.[String(chainId)] ?? {}) };
      visitBookPointers(values, (pointer) => {
        const chains = result.get(pointer.$book.name) ?? new Set<number>();
        chains.add(chainId);
        result.set(pointer.$book.name, chains);
      });
    }
  }
  return result;
}

function visitBookPointers(value: unknown, visit: (pointer: BookPointer) => void): void {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value) && '$book' in value) {
    const pointer = value as BookPointer;
    if (pointer.$book && typeof pointer.$book.name === 'string') visit(pointer);
    return;
  }
  if (Array.isArray(value)) value.forEach((entry) => visitBookPointers(entry, visit));
  else Object.values(value as Record<string, unknown>).forEach((entry) => visitBookPointers(entry, visit));
}

function promotionBookPreview(entry: AddressBookEntry, resolutions: Record<string, `0x${string}`>, source: 'local' | 'repo', bookHash: string, targetEntries: AddressBookEntry[], promotedUses?: NonNullable<PreviewData['referencedEntries'][number]['promotedUses']>): PreviewData['referencedEntries'][number] {
  const targetEntry = targetEntries.find((candidate) => candidate.name === entry.name);
  return {
    name: entry.name,
    entry: globalThis.structuredClone(entry),
    resolutions,
    source,
    bookHash,
    ...(targetEntry ? { targetEntry: globalThis.structuredClone(targetEntry) } : {}),
    conflict: Boolean(targetEntry && !sameEntryAddresses(entry, targetEntry)),
    ...(promotedUses?.length ? { promotedUses } : {}),
  };
}

function referencesFromRun(run: RunRecord, targetEntries: AddressBookEntry[]): PreviewData['referencedEntries'] {
  const grouped = new Map<string, { source: 'local' | 'repo'; bookHash: string; resolutions: Record<string, `0x${string}`>; promotedUses: NonNullable<PreviewData['referencedEntries'][number]['promotedUses']> }>();
  for (const item of runPointerGroups(run)) {
    const first = [...item.resolutions.values()][0]!;
    const current = grouped.get(item.entry) ?? { source: first.source, bookHash: first.bookHash, resolutions: {}, promotedUses: [] };
    const chains: NonNullable<PreviewData['referencedEntries'][number]['promotedUses']>[number]['chains'] = {};
    for (const chainId of run.plan.chains.map(String)) {
      const resolution = item.resolutions.get(chainId);
      if (resolution) {
        current.resolutions[chainId] = resolution.address;
        chains[chainId] = { behavior: 'pointer', address: resolution.address };
        continue;
      }
      const step = run.plan.steps.find((candidate) => candidate.id === item.stepId);
      const literal = step ? getArgumentPath(step.argsPerChain?.[chainId] ?? step.args ?? {}, item.argPath) : undefined;
      if (isAddress(literal)) chains[chainId] = { behavior: 'kept-literal', address: literal };
    }
    current.promotedUses.push({ stepId: item.stepId, argPath: item.argPath, chains });
    grouped.set(item.entry, current);
  }
  return [...grouped.entries()].map(([name, item]) => {
    const addresses = Object.values(item.resolutions);
    const entry: AddressBookEntry = addresses.every((address) => address.toLowerCase() === addresses[0]?.toLowerCase()) ? { name, address: addresses[0]! } : { name, perChain: { ...item.resolutions } };
    return promotionBookPreview(entry, item.resolutions, item.source, item.bookHash, targetEntries, item.promotedUses);
  });
}

function sameEntryAddresses(left: AddressBookEntry, right: AddressBookEntry): boolean {
  const address = (value: string | undefined) => value?.toLowerCase();
  if (address(left.address) !== address(right.address)) return false;
  const keys = new Set([...Object.keys(left.perChain ?? {}), ...Object.keys(right.perChain ?? {})]);
  return [...keys].every((key) => address(left.perChain?.[key]) === address(right.perChain?.[key]));
}

function mergePromotionEntries(current: AddressBookEntry[], copies: AddressBookEntry[]): AddressBookEntry[] {
  const next = current.map((entry) => globalThis.structuredClone(entry));
  for (const copy of copies) {
    if (next.some((entry) => entry.name === copy.name)) throw new WorkflowPromotionError(422, 'PROMOTION_BOOK_NAME_CONFLICT', `Address book entry already exists: ${copy.name}`);
    next.push(globalThis.structuredClone(copy));
  }
  return next;
}

function rewriteBookPointers(value: unknown, renames: Map<string, string>): void {
  visitBookPointers(value, (pointer) => {
    const renamed = renames.get(pointer.$book.name);
    if (renamed) pointer.$book.name = renamed;
  });
}

function hydrateRunBookPointers(run: RunRecord): DeploymentPlan {
  const plan = globalThis.structuredClone(run.plan);
  for (const item of runPointerGroups(run)) {
    const step = plan.steps.find((candidate) => candidate.id === item.stepId);
    if (!step) continue;
    const pointer: BookPointer = { $book: { name: item.entry } };
    const segments = argumentSegments(item.argPath);
    const encoded = segments.includes('$encode');
    const globalPointer = encoded || (segments.length === 1 && item.resolutions.size > 1);
    if (globalPointer) {
      setArgumentPath((step.args ??= {}), item.argPath, pointer);
      for (const chainId of item.resolutions.keys()) {
        const values = step.argsPerChain?.[chainId];
        if (!values) continue;
        if (encoded && segments[0] !== undefined) delete values[String(segments[0])];
        else deleteArgumentPath(values, item.argPath);
      }
    } else {
      for (const chainId of item.resolutions.keys()) {
        const values = ((step.argsPerChain ??= {})[chainId] ??= {});
        setArgumentPath(values, item.argPath, pointer);
      }
    }
  }
  return plan;
}

type ArgumentSegment = string | number;
function argumentSegments(argPath: string): ArgumentSegment[] {
  const raw = argPath.split('.');
  const result: ArgumentSegment[] = [];
  for (const segment of raw) {
    if (segment === 'args' && result.length === 0) continue;
    if (segment === '$encode') result.push('$encode', 'args');
    else for (const match of segment.matchAll(/([^\[\]]+)|\[([0-9]+)\]/g)) result.push(match[2] === undefined ? match[1]! : Number(match[2]));
  }
  return result;
}

function setArgumentPath(root: Record<string, unknown>, argPath: string, value: unknown): void {
  const segments = argumentSegments(argPath);
  let current: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const nextIsArray = typeof segments[index + 1] === 'number';
    const child = current[segment as keyof typeof current] as unknown;
    const usable = child && typeof child === 'object' && (nextIsArray ? Array.isArray(child) : !Array.isArray(child));
    if (!usable) current[segment as keyof typeof current] = (nextIsArray ? [] : {}) as never;
    current = current[segment as keyof typeof current] as Record<string, unknown> | unknown[];
  }
  if (segments.length) current[segments.at(-1)! as keyof typeof current] = value as never;
}

function deleteArgumentPath(root: Record<string, unknown>, argPath: string): void {
  const segments = argumentSegments(argPath);
  let current: Record<string, unknown> | unknown[] | undefined = root;
  for (const segment of segments.slice(0, -1)) {
    const child: unknown = current?.[segment as keyof typeof current];
    current = child && typeof child === 'object' ? child as Record<string, unknown> | unknown[] : undefined;
  }
  if (!current || !segments.length) return;
  const last = segments.at(-1)!;
  if (Array.isArray(current) && typeof last === 'number') current.splice(last, 1);
  else delete current[last as keyof typeof current];
}

function getArgumentPath(root: Record<string, unknown>, argPath: string): unknown {
  let current: unknown = root;
  for (const segment of argumentSegments(argPath)) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}
function isAddress(value: unknown): value is `0x${string}` { return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value); }
function runPointerGroups(run: RunRecord): Array<{ stepId: string; argPath: string; entry: string; resolutions: Map<string, NonNullable<RunRecord['bookResolutions']>[string][number]> }> {
  const grouped = new Map<string, ReturnType<typeof runPointerGroups>[number]>();
  for (const [chainId, resolutions] of Object.entries(run.bookResolutions ?? {})) for (const resolution of resolutions) {
    const key = `${resolution.stepId}\0${resolution.argPath}\0${resolution.entry}`;
    const current = grouped.get(key) ?? { stepId: resolution.stepId, argPath: resolution.argPath, entry: resolution.entry, resolutions: new Map() };
    current.resolutions.set(chainId, resolution);
    grouped.set(key, current);
  }
  return [...grouped.values()];
}
