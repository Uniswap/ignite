import crypto from 'node:crypto';
import type {
  ComposeDeploymentData,
  ComposeDeploymentRequest,
  ComposedCallProducts,
  ContractSource,
  DeploymentComposerField,
  DeploymentTypeBinding,
  DeploymentTypeExecution,
  DeploymentTypeInfo,
  FrozenInputs,
} from '@ignite/api';
import { canonicalJson, CREATE2_PROXY_ADDRESS } from '@ignite/api';
import { PluginType, type PluginResponse } from '@ignite/plugin-types/types';
import type { AbiFunction } from 'viem';
import { toFunctionSignature } from 'viem';
import { PluginRegistryLoader, type PluginConfig } from '../assets/PluginRegistryLoader.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { effectiveOperations } from '../plugins/operationBaselines.js';
import { IgniteError } from '../types/errors.js';
import { sanitizePluginString } from '../verifications/sanitize.js';
import { ArtifactFreezeService } from './ArtifactFreezeService.js';
import { matchAbiFunctions } from './produced.js';
import { clearProvisionalPredictionCache } from './schedule.js';

const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KEY = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
// Field/param keys a plugin may never declare because their VALUE can never
// round-trip: 'config' is the reserved plugin-invocation key and
// ComposeDeploymentRequestSchema rejects values.config outright, and every
// Object.prototype name resolves on the parsed values/params records, so an
// unfilled optional field would read as supplied and fail its type check.
// Either way the composer would render a field the user cannot get accepted,
// so the declaration is rejected here instead of stranding them.
const RESERVED_KEYS = new Set(['config', 'constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf']);
// eslint-disable-next-line no-control-regex -- boundary sanitization needs the literal control range
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

type Provider = PluginConfig;
type Execute = (id: string, operation: string, options: Record<string, unknown>, opts: { chainScope: number | 'none' }) => Promise<PluginResponse<unknown>>;
export interface DeploymentTypeServiceDeps {
  getProviders: () => Promise<Provider[]>;
  execute: Execute;
  // Compose resolves selected sources server-authoritatively: the client's
  // ContractSource identities go through the same freeze pipeline as launch,
  // so a plugin only ever sees an ABI the artifact service vouches for.
  freezeInputs: (profileId: string, contracts: ContractSource[]) => Promise<FrozenInputs>;
  warn: (message: string) => void;
}

interface NormalizedDescriptor { info: DeploymentTypeInfo; binding: DeploymentTypeBinding; }

const text = (value: unknown, cap: number): string | undefined => {
  const output = sanitizePluginString(value, cap + 1);
  return output === undefined || output.length > cap ? undefined : output;
};
const serializedBytes = (value: unknown): number | undefined => { try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return undefined; } };

export class DeploymentTypeService {
  private static instance: DeploymentTypeService;
  private cache?: Promise<DeploymentTypeInfo[]>;
  // One normalized descriptor per installed id@version. Compose responses
  // carry its binding; launch re-describes and rejects drift against it, the
  // enforcement point for one-mode-per-identity and for a plugin that answers
  // differently between authoring and launch.
  private readonly descriptors = new Map<string, NormalizedDescriptor>();
  // The descriptorHash each id@version was AUTHORED against, which is what
  // launch must find unchanged. Kept OUT of `descriptors` deliberately: that
  // map is a read-through cache the launch-time re-describe overwrites and
  // invalidate() clears on every install/trust/config mutation, so comparing
  // against it made the drift rejection one-shot — the second launch attempt
  // compared the drifted descriptor with itself and passed. Only composing
  // rebinds an entry (the recomposition the rejection demands); every other
  // read merely seeds one that is absent, and launch never writes here.
  private readonly authoredHashes = new Map<string, string>();
  private readonly deps: DeploymentTypeServiceDeps;

  constructor(deps?: Partial<DeploymentTypeServiceDeps>) {
    this.deps = {
      getProviders: deps?.getProviders ?? (async () => PluginRegistryLoader.getInstance().getPluginsByType(PluginType.DEPLOYMENT_TYPE)),
      execute: deps?.execute ?? ((id, operation, options, opts) => PluginExecutor.getInstance().execute(id, operation, options, opts)),
      freezeInputs: deps?.freezeInputs ?? ((profileId, contracts) => new ArtifactFreezeService().freezeInputs(profileId, contracts)),
      warn: deps?.warn ?? ((message) => { void import('../utils/logger.js').then(({ getLogger }) => getLogger().warn(message)); }),
    };
  }
  static getInstance(): DeploymentTypeService { return this.instance ??= new DeploymentTypeService(); }
  static resetInstance(): void { this.instance = undefined as unknown as DeploymentTypeService; }
  // authoredHashes deliberately survives: an install/trust/config mutation is
  // not the user re-authoring a plan against the new descriptor.
  invalidate(): void { this.cache = undefined; this.descriptors.clear(); clearProvisionalPredictionCache(); }

  async list(refresh = false): Promise<DeploymentTypeInfo[]> {
    if (refresh || !this.cache) this.cache = this.describeAll(refresh);
    return this.cache;
  }

  async prepare(pluginId: string, input: { chainId: number; initcode: `0x${string}`; runtimeBytecode?: `0x${string}`; params?: Record<string, unknown> }): Promise<{ salt: `0x${string}`; predictedAddress: `0x${string}`; notes: string[] }> {
    this.validateInput(input);
    const info = await this.getInfo(pluginId);
    this.assertCreate2Mode(info, 'prepareDeployment');
    this.assertParamKeys(info.params, input.params, 'Deployment-type');
    const result = await this.execute(pluginId, 'prepareDeployment', { ...input, proxyAddress: CREATE2_PROXY_ADDRESS }, input.chainId);
    const parsed = this.parsePrepare(result);
    return parsed;
  }

  async validate(pluginId: string, input: { chainId: number; initcode: `0x${string}`; runtimeBytecode?: `0x${string}`; salt: `0x${string}`; predictedAddress: `0x${string}`; params?: Record<string, unknown> }): Promise<{ ok: boolean; reason?: string }> {
    this.validateInput(input);
    if (!HEX32.test(input.salt) || !ADDRESS.test(input.predictedAddress)) this.failed('validateDeployment returned or received invalid address data');
    const info = await this.getInfo(pluginId);
    this.assertCreate2Mode(info, 'validateDeployment');
    this.assertParamKeys(info.params, input.params, 'Deployment-type');
    const result = await this.execute(pluginId, 'validateDeployment', input, input.chainId);
    if (!result || typeof result !== 'object') this.failed('validateDeployment returned an invalid result');
    if (Object.keys(result as object).some((key) => !['ok', 'reason'].includes(key))) this.failed('validateDeployment returned unexpected fields');
    const value = result as Record<string, unknown>;
    if (typeof value.ok !== 'boolean') this.failed('validateDeployment returned an invalid result');
    const reason = value.reason === undefined ? undefined : text(value.reason, 500);
    if (value.reason !== undefined && reason === undefined) this.failed('validateDeployment returned an invalid reason');
    return reason === undefined ? { ok: value.ok } : { ok: value.ok, reason };
  }

  /** The reviewed identity a run freezes for every plugin strategy it uses. */
  async launchBinding(pluginId: string): Promise<DeploymentTypeBinding> {
    const provider = await this.requireProvider(pluginId);
    // Compared against the AUTHORED hash, never against the descriptor cache:
    // launch itself re-describes into that cache, so a cache comparison held
    // only for the first attempt. `authoring: 'none'` keeps this refresh from
    // laundering the drift it exists to detect; on drift the fresh descriptor
    // stays cached, which is what the required recomposition binds against.
    const authored = this.authoredHashes.get(this.descriptorKey(provider));
    const fresh = await this.describeProvider(provider, { bypassCache: true, authoring: 'none' });
    // Scoped to call-products, because recomposition is the only thing that
    // rebinds an authored hash: gating CREATE2 mode too would reject its
    // launches permanently — with a message telling the operator to recompose
    // something that has no composer — whenever a descriptor drifted for any
    // reason, config-driven descriptions included. CREATE2 keeps its own
    // substantive commitment checks (DEPLOYMENT_TYPE_COMMITMENT_STALE plus the
    // host's salt/address re-derivation), and a changed EXECUTION mode is
    // caught for both modes against the materialized strategy shape.
    if (fresh.binding.execution === 'call-products' && authored !== undefined && authored !== fresh.binding.descriptorHash)
      this.failed(`Deployment type ${pluginId} changed its descriptor since it was reviewed — recompose or re-validate the deployment`);
    return fresh.binding;
  }

  async compose(profileId: string, request: ComposeDeploymentRequest): Promise<ComposeDeploymentData> {
    const provider = await this.requireProvider(request.pluginId);
    const { info, binding } = await this.describeProvider(provider);
    if (!info.composeSupported) this.failed(`Deployment type ${request.pluginId} does not support composition`);
    if ((serializedBytes(request.values) ?? Infinity) > 64 * 1024) this.failed('Composer values exceed 64 KiB');
    const artifactEntries = Object.entries(request.artifacts);
    if (artifactEntries.length > 32) this.failed('At most 32 artifact selections are allowed');
    for (const [key] of artifactEntries) if (!KEY.test(key) || key.length > 64) this.failed('Composer artifact keys are invalid');
    for (const [key, value] of Object.entries(request.values)) {
      if (!KEY.test(key) || key.length > 64) this.failed('Composer value keys are invalid');
      // Mirrors the wire cap (this validation is independent of the route
      // schema): a plugin echoing a value into its 1..500-char blocker or a
      // 1..280-char label would otherwise have its whole response rejected,
      // so no plugin author has to defensively truncate host-supplied input.
      if ((typeof value === 'string' ? value.length : serializedBytes(value) ?? Infinity) > 512) this.failed(`Composer value ${key} exceeds 512 characters`);
    }
    // Server-authoritative artifact resolution: the same freeze pipeline as
    // launch verifies each source is still selectable and pins its identity.
    const byId = new Map(artifactEntries.map(([, source]) => [source.id, source]));
    const frozen = byId.size ? await this.deps.freezeInputs(profileId, [...byId.values()]) : {};
    const artifacts: Record<string, { selectionId: string; contractName: string; abi: unknown }> = {};
    for (const [key, source] of artifactEntries) {
      const input = frozen[source.id];
      if (!input) this.failed(`Artifact selection ${key} could not be resolved`);
      if ((serializedBytes(input!.abi) ?? Infinity) > 512 * 1024) this.failed(`Artifact selection ${key} has an oversized ABI`);
      artifacts[key] = { selectionId: source.id, contractName: source.contractName, abi: input!.abi };
    }
    const raw = await this.execute(request.pluginId, 'composeDeployment', { compositionId: request.compositionId, values: request.values, artifacts }, 'none');
    const parsed = this.parseCompose(raw);
    const composition = parsed.composition === undefined
      ? undefined
      : this.crossCheckComposition(info, parsed, request, frozen);
    // Composing IS authoring, and only a composition the caller actually
    // received counts: the returned binding is what its plan is materialized
    // against, so rebinding here is the one path that lets a legitimately
    // changed descriptor launch again after a drift rejection.
    this.noteAuthored(this.descriptorKey(provider), binding.descriptorHash, 'rebind');
    return {
      revision: request.revision,
      binding,
      fields: parsed.fields,
      ...(parsed.blocker === undefined ? {} : { blocker: parsed.blocker }),
      ...(composition === undefined ? {} : { composition }),
    };
  }

  private async describeAll(refresh: boolean): Promise<DeploymentTypeInfo[]> {
    const providers = await this.deps.getProviders();
    const settled = await Promise.allSettled(providers.map((provider) => this.describeProvider(provider, { bypassCache: refresh })));
    // One hostile or broken provider must not poison the whole list; direct
    // lookup (getInfo) still surfaces its specific bounded error.
    return settled.flatMap((result, index) => {
      if (result.status === 'fulfilled') return [result.value.info];
      this.deps.warn(`deployment type ${providers[index]!.metadata.id} was skipped: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      return [];
    });
  }
  private async getInfo(pluginId: string): Promise<DeploymentTypeInfo> {
    const info = (await this.list()).find((entry) => entry.pluginId === pluginId);
    if (info) return info;
    // Absent from the healthy list: re-describe the one provider so callers
    // get its specific parse error rather than a generic not-found.
    const provider = (await this.deps.getProviders()).find((entry) => entry.metadata.id === pluginId);
    if (!provider) throw new IgniteError(`Deployment-type plugin ${pluginId} is not installed`, 'PLUGIN_NOT_FOUND');
    return (await this.describeProvider(provider)).info;
  }
  private async requireProvider(pluginId: string): Promise<Provider> {
    const provider = (await this.deps.getProviders()).find((entry) => entry.metadata.id === pluginId);
    if (!provider) throw new IgniteError(`Deployment-type plugin ${pluginId} is not installed`, 'PLUGIN_NOT_FOUND');
    return provider;
  }
  private descriptorKey(provider: Provider): string { return `${provider.metadata.id}@${provider.metadata.version}`; }
  private noteAuthored(key: string, descriptorHash: string, authoring: 'seed' | 'rebind' | 'none'): void {
    if (authoring === 'none') return;
    if (authoring === 'rebind' || !this.authoredHashes.has(key)) this.authoredHashes.set(key, descriptorHash);
  }
  private async describeProvider(provider: Provider, opts: { bypassCache?: boolean; authoring?: 'seed' | 'rebind' | 'none' } = {}): Promise<NormalizedDescriptor> {
    const key = this.descriptorKey(provider);
    const authoring = opts.authoring ?? 'seed';
    if (!opts.bypassCache) {
      const cached = this.descriptors.get(key);
      if (cached) { this.noteAuthored(key, cached.binding.descriptorHash, authoring); return cached; }
    }
    const raw = await this.execute(provider.metadata.id, 'describeDeploymentType', {}, 'none');
    const described = this.parseDescribe(raw);
    const operations = [...effectiveOperations(provider.metadata)].sort();
    // Host-derived, never trusted descriptor input: composition requires the
    // manifest to explicitly declare the operation AND the descriptor to say
    // call-products; either alone is a mismatch that fails this provider.
    if (described.execution === 'call-products') {
      if (!operations.includes('describeDeploymentType') || !operations.includes('composeDeployment'))
        this.failed(`describeDeploymentType declared call-products execution but the manifest does not declare describeDeploymentType and composeDeployment`);
    } else if (operations.includes('composeDeployment')) {
      this.failed('describeDeploymentType declared create2 execution but the manifest declares composeDeployment');
    }
    const composeSupported = described.execution === 'call-products';
    const validateSupported = described.execution === 'create2' && operations.includes('validateDeployment');
    const descriptorHash = crypto.createHash('sha256').update(canonicalJson({ describe: described, operations })).digest('hex');
    const binding: DeploymentTypeBinding = { pluginId: provider.metadata.id, pluginVersion: provider.metadata.version, execution: described.execution, descriptorHash };
    const normalized: NormalizedDescriptor = {
      info: { pluginId: provider.metadata.id, pluginVersion: provider.metadata.version, ...described, validateSupported, composeSupported },
      binding,
    };
    this.descriptors.set(key, normalized);
    this.noteAuthored(key, descriptorHash, authoring);
    return normalized;
  }
  private async execute(pluginId: string, operation: string, options: Record<string, unknown>, chainScope: number | 'none'): Promise<unknown> {
    let response: PluginResponse<unknown>;
    try { response = await this.deps.execute(pluginId, operation, options, { chainScope }); }
    catch (error) { this.failed(`${operation} failed: ${text(error instanceof Error ? error.message : String(error), 300) ?? 'plugin error'}`); }
    // Plugin-authored messages are untrusted and this error may persist into
    // validation items/artifacts — cap + control-strip (final-review F5).
    if (!response!.success) {
      const code = typeof response!.error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(response!.error.code) ? ` [${response!.error.code}]` : '';
      this.failed(`${operation} failed${code}: ${text(response!.error.message, 300) ?? 'plugin error'}`);
    }
    return response!.data;
  }
  private parseDescribe(raw: unknown): { label: string; description: string; execution: DeploymentTypeExecution; params: DeploymentTypeInfo['params'] } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) this.failed('describeDeploymentType returned an invalid result');
    // Exact keys: a plugin-authored version/composeSupported/validateSupported
    // field is rejected rather than trusted.
    if (Object.keys(raw as object).some((key) => !['label', 'description', 'execution', 'params'].includes(key))) this.failed('describeDeploymentType returned unexpected fields');
    const value = raw as Record<string, unknown>;
    const label = text(value.label, 64); const description = text(value.description, 512);
    if (!label || !description || !Array.isArray(value.params) || value.params.length > 16) this.failed('describeDeploymentType returned invalid fields');
    // Omitted execution normalizes to create2 so already-published descriptors
    // stay valid; one plugin id/version has exactly one execution mode.
    if (value.execution !== undefined && value.execution !== 'create2' && value.execution !== 'call-products') this.failed('describeDeploymentType returned an invalid execution mode');
    const execution = (value.execution ?? 'create2') as DeploymentTypeExecution;
    const params = (value.params as unknown[]).map((field) => this.parseParam(field));
    if (new Set(params.map((field) => field.key)).size !== params.length) this.failed('describeDeploymentType returned duplicate param keys');
    return { label: label!, description: description!, execution, params };
  }
  private parseParam(raw: unknown): DeploymentTypeInfo['params'][number] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) this.failed('describeDeploymentType returned an invalid param');
    const field = raw as Record<string, unknown>;
    const key = field.key; const label = text(field.label, 280); const description = field.description === undefined ? undefined : text(field.description, 280);
    if (typeof key !== 'string' || !KEY.test(key) || key.length > 64 || !label || !['string', 'number', 'boolean', 'select'].includes(field.type as string) || (field.required !== undefined && typeof field.required !== 'boolean') || (field.description !== undefined && !description)) this.failed('describeDeploymentType returned an invalid param');
    if (RESERVED_KEYS.has(key)) this.failed(`describeDeploymentType declared the reserved param key '${key}'`);
    let options: Array<{value:string;label:string}> | undefined;
    if (field.type === 'select') {
      if (!Array.isArray(field.options) || field.options.length === 0 || field.options.length > 64) this.failed('describeDeploymentType returned invalid select options');
      options = field.options.map((option) => {
        if (!option || typeof option !== 'object') this.failed('describeDeploymentType returned invalid select options');
        const value = (option as Record<string, unknown>).value; const optionLabel = text((option as Record<string, unknown>).label, 280);
        if (typeof value !== 'string' || value.length === 0 || value.length > 280 || CONTROL.test(value) || !optionLabel) this.failed('describeDeploymentType returned invalid select options');
        return { value, label: optionLabel! };
      });
    } else if (field.options !== undefined) this.failed('describeDeploymentType returned unexpected options');
    return { key, label: label!, type: field.type as 'string' | 'number' | 'boolean' | 'select', ...(options ? { options } : {}), ...(field.required === undefined ? {} : { required: field.required as boolean }), ...(description === undefined ? {} : { description }) };
  }
  private parsePrepare(raw: unknown): { salt: `0x${string}`; predictedAddress: `0x${string}`; notes: string[] } {
    if (!raw || typeof raw !== 'object') this.failed('prepareDeployment returned an invalid result');
    if (Object.keys(raw as object).some((key) => !['salt', 'predictedAddress', 'notes'].includes(key))) this.failed('prepareDeployment returned unexpected fields');
    const value = raw as Record<string, unknown>;
    if (typeof value.salt !== 'string' || !HEX32.test(value.salt) || typeof value.predictedAddress !== 'string' || !ADDRESS.test(value.predictedAddress) || (value.notes !== undefined && (!Array.isArray(value.notes) || value.notes.length > 8))) this.failed('prepareDeployment returned invalid fields');
    const notes = (value.notes ?? []).map((note) => { const result = text(note, 256); if (result === undefined) this.failed('prepareDeployment returned an invalid note'); return result!; });
    return { salt: value.salt as `0x${string}`, predictedAddress: value.predictedAddress as `0x${string}`, notes };
  }
  private parseCompose(raw: unknown): { fields: DeploymentComposerField[]; blocker?: string; composition?: { producer: { abiArtifactField: string; targetField: string; functionField: string }; products: Array<{ key: string; artifactField: string; outputIndex: number; params?: Record<string, unknown> }> } } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) this.failed('composeDeployment returned an invalid result');
    if (Object.keys(raw as object).some((key) => !['fields', 'blocker', 'composition'].includes(key))) this.failed('composeDeployment returned unexpected fields');
    const value = raw as Record<string, unknown>;
    if (!Array.isArray(value.fields) || value.fields.length > 32) this.failed('composeDeployment returned invalid fields');
    const fields = (value.fields as unknown[]).map((field) => this.parseComposerField(field));
    if (new Set(fields.map((field) => field.key)).size !== fields.length) this.failed('composeDeployment returned duplicate field keys');
    const blocker = value.blocker === undefined ? undefined : text(value.blocker, 500);
    if (value.blocker !== undefined && blocker === undefined) this.failed('composeDeployment returned an invalid blocker');
    if (value.composition === undefined) return { fields, ...(blocker === undefined ? {} : { blocker }) };
    // A result may include a composition only when nothing blocks it.
    if (blocker !== undefined) this.failed('composeDeployment returned a composition alongside a blocker');
    const composition = value.composition;
    if (!composition || typeof composition !== 'object' || Array.isArray(composition)) this.failed('composeDeployment returned an invalid composition');
    if (Object.keys(composition as object).some((key) => !['producer', 'products'].includes(key))) this.failed('composeDeployment returned unexpected composition fields');
    const producerRaw = (composition as Record<string, unknown>).producer;
    if (!producerRaw || typeof producerRaw !== 'object' || Array.isArray(producerRaw)) this.failed('composeDeployment returned an invalid producer');
    if (Object.keys(producerRaw as object).some((key) => !['abiArtifactField', 'targetField', 'functionField'].includes(key))) this.failed('composeDeployment returned unexpected producer fields');
    const producer = producerRaw as Record<string, unknown>;
    const fieldRef = (candidate: unknown): string => {
      if (typeof candidate !== 'string' || !KEY.test(candidate) || candidate.length > 64) this.failed('composeDeployment returned an invalid field reference');
      return candidate as string;
    };
    const productsRaw = (composition as Record<string, unknown>).products;
    if (!Array.isArray(productsRaw) || productsRaw.length === 0 || productsRaw.length > 16) this.failed('composeDeployment returned an invalid product list');
    const products = (productsRaw as unknown[]).map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) this.failed('composeDeployment returned an invalid product');
      if (Object.keys(entry as object).some((key) => !['key', 'artifactField', 'outputIndex', 'params'].includes(key))) this.failed('composeDeployment returned unexpected product fields');
      const product = entry as Record<string, unknown>;
      const outputIndex = product.outputIndex;
      if (typeof outputIndex !== 'number' || !Number.isInteger(outputIndex) || outputIndex < 0) this.failed('composeDeployment returned an invalid product output index');
      if (product.params !== undefined && (typeof product.params !== 'object' || product.params === null || Array.isArray(product.params) || (serializedBytes(product.params) ?? Infinity) > 64 * 1024)) this.failed('composeDeployment returned invalid product params');
      return { key: fieldRef(product.key), artifactField: fieldRef(product.artifactField), outputIndex: outputIndex as number, ...(product.params === undefined ? {} : { params: product.params as Record<string, unknown> }) };
    });
    if (new Set(products.map((product) => product.key)).size !== products.length) this.failed('composeDeployment returned duplicate product keys');
    if (new Set(products.map((product) => product.outputIndex)).size !== products.length) this.failed('composeDeployment returned duplicate product output indexes');
    return {
      fields,
      composition: { producer: { abiArtifactField: fieldRef(producer.abiArtifactField), targetField: fieldRef(producer.targetField), functionField: fieldRef(producer.functionField) }, products },
    };
  }
  private parseComposerField(raw: unknown): DeploymentComposerField {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) this.failed('composeDeployment returned an invalid field');
    const field = raw as Record<string, unknown>;
    const type = field.type;
    if (type !== 'artifact' && type !== 'address' && type !== 'select') this.failed('composeDeployment returned an invalid field type');
    const allowed = ['type', 'key', 'label', 'description', 'required', ...(type === 'artifact' ? ['origins'] : []), ...(type === 'select' ? ['options'] : [])];
    if (Object.keys(field).some((key) => !allowed.includes(key))) this.failed('composeDeployment returned unexpected field keys');
    const key = field.key; const label = text(field.label, 280); const description = field.description === undefined ? undefined : text(field.description, 280);
    if (typeof key !== 'string' || !KEY.test(key) || key.length > 64 || !label || (field.required !== undefined && typeof field.required !== 'boolean') || (field.description !== undefined && !description)) this.failed('composeDeployment returned an invalid field');
    if (RESERVED_KEYS.has(key)) this.failed(`composeDeployment declared the reserved field key '${key}'`);
    const base = { key, label: label!, ...(description === undefined ? {} : { description }), ...(field.required === undefined ? {} : { required: field.required as boolean }) };
    if (type === 'address') return { type, ...base };
    if (type === 'artifact') {
      if (field.origins === undefined) return { type, ...base };
      if (!Array.isArray(field.origins) || field.origins.length === 0 || field.origins.length > 2 || field.origins.some((origin) => origin !== 'repo' && origin !== 'contract-type') || new Set(field.origins).size !== field.origins.length) this.failed('composeDeployment returned invalid field origins');
      return { type, ...base, origins: field.origins as Array<'repo' | 'contract-type'> };
    }
    if (!Array.isArray(field.options) || field.options.length === 0 || field.options.length > 64) this.failed('composeDeployment returned invalid select options');
    const options = (field.options as unknown[]).map((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) this.failed('composeDeployment returned invalid select options');
      if (Object.keys(option as object).some((entry) => !['value', 'label'].includes(entry))) this.failed('composeDeployment returned invalid select options');
      const value = (option as Record<string, unknown>).value; const optionLabel = text((option as Record<string, unknown>).label, 280);
      if (typeof value !== 'string' || value.length === 0 || value.length > 280 || CONTROL.test(value) || !optionLabel) this.failed('composeDeployment returned invalid select options');
      return { value, label: optionLabel! };
    });
    if (new Set(options.map((option) => option.value)).size !== options.length) this.failed('composeDeployment returned duplicate select options');
    return { type, ...base, options };
  }
  /**
   * A composition is accepted whole or not at all: every declared input must
   * be valid, every reference must resolve, and the executable function and
   * output indexes come from the authoritative frozen ABI — never from the
   * plugin's response.
   */
  private crossCheckComposition(
    info: DeploymentTypeInfo,
    parsed: { fields: DeploymentComposerField[]; composition?: { producer: { abiArtifactField: string; targetField: string; functionField: string }; products: Array<{ key: string; artifactField: string; outputIndex: number; params?: Record<string, unknown> }> } },
    request: ComposeDeploymentRequest,
    frozen: FrozenInputs
  ): ComposedCallProducts {
    const composition = parsed.composition!;
    const byKey = new Map(parsed.fields.map((field) => [field.key, field]));
    // Exact composer input keys: unknown values or selections reject the
    // whole composition rather than being silently ignored.
    for (const key of Object.keys(request.values)) {
      const field = byKey.get(key);
      if (!field || field.type === 'artifact') this.failed(`Composer value ${key} does not match a declared field`);
    }
    for (const key of Object.keys(request.artifacts)) {
      const field = byKey.get(key);
      if (!field || field.type !== 'artifact') this.failed(`Composer artifact selection ${key} does not match a declared artifact field`);
    }
    for (const field of parsed.fields) {
      const value = field.type === 'artifact' ? request.artifacts[field.key] : request.values[field.key];
      if (value === undefined || value === '') {
        if (field.required) this.failed(`Composer field ${field.key} is required`);
        continue;
      }
      if (field.type === 'address' && (typeof value !== 'string' || !ADDRESS.test(value))) this.failed(`Composer field ${field.key} must be a valid address`);
      if (field.type === 'select' && !field.options.some((option) => option.value === value)) this.failed(`Composer field ${field.key} must be one of the declared options`);
      if (field.type === 'artifact' && field.origins) {
        const source = value as ContractSource;
        const origin = source.origin ?? 'repo';
        if (!field.origins.includes(origin)) this.failed(`Composer field ${field.key} does not accept ${origin} sources`);
      }
    }
    const requireField = (key: string, type: DeploymentComposerField['type'], what: string) => {
      const field = byKey.get(key);
      if (!field || field.type !== type) this.failed(`composeDeployment ${what} must reference a declared ${type} field`);
      return field!;
    };
    requireField(composition.producer.abiArtifactField, 'artifact', 'producer.abiArtifactField');
    requireField(composition.producer.targetField, 'address', 'producer.targetField');
    requireField(composition.producer.functionField, 'select', 'producer.functionField');
    const target = request.values[composition.producer.targetField];
    if (typeof target !== 'string' || !ADDRESS.test(target)) this.failed('The producer target address is missing or invalid');
    const abiSource = request.artifacts[composition.producer.abiArtifactField];
    if (!abiSource) this.failed('The producer ABI artifact is not selected');
    const abi = frozen[abiSource!.id]?.abi;
    const selector = request.values[composition.producer.functionField];
    if (typeof selector !== 'string') this.failed('The producer function selection is missing');
    // The select value is a canonical input-only signature; it must match
    // exactly one state-changing function in the authoritative ABI. Core
    // derives the executable signature and payability from that entry.
    const matches = matchAbiFunctions(abi, selector as string);
    if (matches.length !== 1) this.failed(matches.length ? 'The producer function selection is ambiguous in the selected ABI' : 'The producer function selection does not match the selected ABI');
    const fn = matches[0]! as AbiFunction;
    if (fn.stateMutability === 'view' || fn.stateMutability === 'pure') this.failed('The producer function must be state-changing');
    for (const product of composition.products) {
      requireField(product.artifactField, 'artifact', `product ${product.key} artifactField`);
      if (!request.artifacts[product.artifactField]) this.failed(`Product ${product.key} references an unselected artifact`);
      const output = fn.outputs[product.outputIndex];
      if (!output || output.type !== 'address') this.failed(`Product ${product.key} output ${product.outputIndex} is not an address output`);
      if (product.params !== undefined) this.assertParamKeys(info.params, product.params, 'Product');
    }
    return {
      producer: {
        abiArtifactField: composition.producer.abiArtifactField,
        targetField: composition.producer.targetField,
        functionField: composition.producer.functionField,
        signature: toFunctionSignature(fn),
        payable: fn.stateMutability === 'payable',
      },
      products: composition.products,
    };
  }
  private assertCreate2Mode(info: DeploymentTypeInfo, operation: string): void {
    if (info.execution !== 'create2') this.failed(`${operation} is not available for a call-products deployment type`);
  }
  private validateInput(input: { chainId: number; initcode: string; runtimeBytecode?: string; params?: Record<string, unknown> }): void {
    if (!Number.isInteger(input.chainId) || input.chainId <= 0 || !HEX.test(input.initcode) || (input.initcode.length - 2) / 2 > 1024 * 1024 || (input.runtimeBytecode !== undefined && (!HEX.test(input.runtimeBytecode) || (input.runtimeBytecode.length - 2) / 2 > 1024 * 1024)) || (input.params !== undefined && (typeof input.params !== 'object' || input.params === null || Array.isArray(input.params) || (serializedBytes(input.params) ?? Infinity) > 64 * 1024))) this.failed('Deployment-type input is invalid');
  }
  private assertParamKeys(fields: DeploymentTypeInfo['params'], params: Record<string, unknown> | undefined, what: string): void {
    for (const key of Object.keys(params ?? {})) if (!fields.some((field) => field.key === key)) throw new IgniteError(`Unknown deployment-type parameter '${key}'`, 'UNKNOWN_PARAM_KEY');
    // Strict contract validation (final-review F4): required fields present,
    // primitive types exact, select values from the declared option set.
    for (const field of fields) {
      const value = params?.[field.key];
      if (value === undefined || value === '') {
        if (field.required) throw new IgniteError(`${what} parameter '${field.key}' is required`, 'INVALID_PARAM_VALUE', { key: field.key });
        continue;
      }
      const bad = (reason: string): never => { throw new IgniteError(`${what} parameter '${field.key}' ${reason}`, 'INVALID_PARAM_VALUE', { key: field.key }); };
      if (field.type === 'string' && typeof value !== 'string') bad('must be a string');
      if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) bad('must be a finite number');
      if (field.type === 'boolean' && typeof value !== 'boolean') bad('must be a boolean');
      if (field.type === 'select' && !(field.options ?? []).some((option) => option.value === value)) bad('must be one of the declared options');
    }
  }
  private failed(message: string): never { throw new IgniteError(message, 'DEPLOYMENT_TYPE_OP_FAILED'); }
}
