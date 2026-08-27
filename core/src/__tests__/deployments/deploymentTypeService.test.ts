import { describe, expect, it, vi } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import type { ComposeDeploymentRequest, ContractSource, FrozenInputs } from '@ignite/api';
import type { PluginConfig } from '../../assets/PluginRegistryLoader.js';
import { DeploymentTypeService } from '../../deployments/DeploymentTypeService.js';

const config: PluginConfig = {
  origin: 'installed',
  repoRead: false,
  metadata: {
    id: 'hook', types: [PluginType.DEPLOYMENT_TYPE], name: 'Hook', version: '1',
    baseImage: 'ignite/hook', operations: ['describeDeploymentType', 'prepareDeployment', 'validateDeployment'],
  },
};
const spawnerConfig: PluginConfig = {
  origin: 'installed',
  repoRead: false,
  metadata: {
    id: 'spawner', types: [PluginType.DEPLOYMENT_TYPE], name: 'Spawner', version: '2.1.0',
    baseImage: 'ignite/spawner', operations: ['describeDeploymentType', 'composeDeployment'],
  },
};
// Written before manifests declared operations: effective operations fall
// back to the CREATE2 baseline.
const legacyConfig: PluginConfig = {
  origin: 'installed',
  repoRead: false,
  metadata: {
    id: 'legacy', types: [PluginType.DEPLOYMENT_TYPE], name: 'Legacy', version: '0.9.0',
    baseImage: 'ignite/legacy',
  },
};
const hex32 = `0x${'11'.repeat(32)}` as `0x${string}`;
const TARGET = '0x2179a60856E37dfeAacA0ab043B931fE224b27B6';
const HOOK_DESCRIBE = { label: 'Hook', description: 'A hook', params: [] };
const SPAWNER_DESCRIBE = { label: 'Spawner', description: 'Spawns contracts', execution: 'call-products', params: [] };

const SPAWN_FN = {
  type: 'function', name: 'spawn', stateMutability: 'nonpayable',
  inputs: [{ name: 'owner', type: 'address' }],
  outputs: [{ name: 'child', type: 'address' }, { name: 'fee', type: 'uint256' }],
};
const PRODUCER_ABI = [SPAWN_FN];
const FIELDS = [
  { type: 'artifact', key: 'producer', label: 'Producer contract', required: true, origins: ['repo'] },
  { type: 'address', key: 'target', label: 'Producer address', required: true },
  { type: 'select', key: 'fn', label: 'Spawn function', required: true, options: [{ value: 'spawn(address)', label: 'spawn(address)' }] },
  { type: 'artifact', key: 'child', label: 'Spawned contract', required: true },
];
const COMPOSITION = {
  producer: { abiArtifactField: 'producer', targetField: 'target', functionField: 'fn' },
  products: [{ key: 'child', artifactField: 'child', outputIndex: 0 }],
};
const source = (id: string): ContractSource => ({
  id, repoPathOrUrl: '/repo', frameworkId: 'foundry',
  artifactPath: `out/${id}.json`, contractName: id, sourcePath: `src/${id}.sol`,
});
const REQUEST: ComposeDeploymentRequest = {
  pluginId: 'spawner', compositionId: 'comp-1', revision: 3,
  values: { target: TARGET, fn: 'spawn(address)' },
  artifacts: { producer: source('p'), child: source('c') },
};

function fakeFreeze(abi: unknown = PRODUCER_ABI) {
  return vi.fn(async (_profileId: string, contracts: ContractSource[]): Promise<FrozenInputs> =>
    Object.fromEntries(contracts.map((contract) => [contract.id, {
      abi, creationBytecode: '0x6000',
      compiler: { pluginId: 'f', version: '1', settingsHash: 'a'.repeat(64) },
      artifactHash: 'a'.repeat(64), repoDirty: false,
    }])));
}
function composeService(opts: { response?: unknown; describe?: unknown; abi?: unknown } = {}) {
  const warn = vi.fn();
  const freezeInputs = fakeFreeze(opts.abi);
  const execute = vi.fn(async (_id: string, operation: string) => operation === 'describeDeploymentType'
    ? { success: true as const, data: opts.describe ?? SPAWNER_DESCRIBE }
    : { success: true as const, data: opts.response ?? { fields: FIELDS, composition: COMPOSITION } });
  const service = new DeploymentTypeService({ getProviders: async () => [spawnerConfig], execute, freezeInputs, warn });
  return { service, execute, freezeInputs, warn };
}

describe('DeploymentTypeService', () => {
  it('describes deployment types with none scope, injects the registry version, and caches', async () => {
    const execute = vi.fn(async () => ({ success: true as const, data: {
      label: 'Hook\u0000', description: 'A hook\n', params: [{ key: 'flags', label: 'Flags', type: 'string' }],
    } }));
    const service = new DeploymentTypeService({ getProviders: vi.fn(async () => [config]), execute });
    await expect(service.list()).resolves.toEqual([{
      pluginId: 'hook', pluginVersion: '1', label: 'Hook', description: 'A hook\n',
      // Omitted execution normalizes to create2; validateSupported and
      // composeSupported are host-derived from the effective operations.
      execution: 'create2',
      params: [{ key: 'flags', label: 'Flags', type: 'string' }], validateSupported: true, composeSupported: false,
    }]);
    await service.list();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('hook', 'describeDeploymentType', {}, { chainScope: 'none' });
  });

  it('passes the canonical proxy and rejects unknown parameter keys before dispatch', async () => {
    const execute = vi.fn(async (_id: string, operation: string) => {
      if (operation === 'describeDeploymentType') return { success: true as const, data: { label: 'Hook', description: 'Desc', params: [{ key: 'flags', label: 'Flags', type: 'string' }] } };
      return { success: true as const, data: { salt: hex32, predictedAddress: '0x1111111111111111111111111111111111111111', notes: [] } };
    });
    const service = new DeploymentTypeService({ getProviders: async () => [config], execute });
    await service.prepare('hook', { chainId: 1, initcode: '0x00', params: { flags: '1' } });
    expect(execute).toHaveBeenLastCalledWith('hook', 'prepareDeployment', expect.objectContaining({ proxyAddress: '0x4e59b44847b379578588920cA78FbF26c0B4956C' }), { chainScope: 1 });
    await expect(service.prepare('hook', { chainId: 1, initcode: '0x00', params: { no: '1' } })).rejects.toMatchObject({ code: 'UNKNOWN_PARAM_KEY' });
  });

  it('passes runtime bytecode through prepare and validate, and validates it', async () => {
    const execute = vi.fn(async (_id: string, operation: string) => {
      if (operation === 'describeDeploymentType') return { success: true as const, data: { label: 'Hook', description: 'Desc', params: [] } };
      if (operation === 'prepareDeployment') return { success: true as const, data: { salt: hex32, predictedAddress: '0x1111111111111111111111111111111111111111', notes: [] } };
      return { success: true as const, data: { ok: true } };
    });
    const service = new DeploymentTypeService({ getProviders: async () => [config], execute });
    await service.prepare('hook', { chainId: 1, initcode: '0x00', runtimeBytecode: '0x6000' });
    await service.validate('hook', { chainId: 1, initcode: '0x00', runtimeBytecode: '0x6000', salt: hex32, predictedAddress: '0x1111111111111111111111111111111111111111' });
    expect(execute).toHaveBeenCalledWith('hook', 'prepareDeployment', expect.objectContaining({ runtimeBytecode: '0x6000' }), { chainScope: 1 });
    expect(execute).toHaveBeenCalledWith('hook', 'validateDeployment', expect.objectContaining({ runtimeBytecode: '0x6000' }), { chainScope: 1 });
    await expect(service.prepare('hook', { chainId: 1, initcode: '0x00', runtimeBytecode: '0x0' })).rejects.toMatchObject({ code: 'DEPLOYMENT_TYPE_OP_FAILED' });
  });

  it('surfaces valid plugin error codes only', async () => {
    const failing = (code: string) => new DeploymentTypeService({
      getProviders: async () => [config],
      execute: async (id, operation) => operation === 'describeDeploymentType'
        ? { success: true, data: { label: 'Hook', description: 'Desc', params: [] } }
        : { success: false, error: { code, message: 'derivation failed' } },
    });
    await expect(failing('PLUGIN_CODE').prepare('hook', { chainId: 1, initcode: '0x00' })).rejects.toThrow('prepareDeployment failed [PLUGIN_CODE]: derivation failed');
    await expect(failing('not safe').prepare('hook', { chainId: 1, initcode: '0x00' })).rejects.toThrow('prepareDeployment failed: derivation failed');
  });
});

describe('descriptor parsing and identity', () => {
  const describeService = (data: unknown, provider: PluginConfig = config) => new DeploymentTypeService({
    getProviders: async () => [provider],
    execute: async () => ({ success: true, data }),
    warn: vi.fn(),
  });

  it.each([
    ['unknown top-level keys', { ...HOOK_DESCRIBE, extra: 1 }, /unexpected fields/],
    // A plugin cannot spoof the version core injects from registry metadata.
    ['a plugin-authored pluginVersion', { ...HOOK_DESCRIBE, pluginVersion: '9.9.9' }, /unexpected fields/],
    ['an invalid execution mode', { ...HOOK_DESCRIBE, execution: 'teleport' }, /invalid execution mode/],
    ['duplicate param keys', { ...HOOK_DESCRIBE, params: [{ key: 'a', label: 'A', type: 'string' }, { key: 'a', label: 'B', type: 'string' }] }, /duplicate param keys/],
    ['an oversized label', { ...HOOK_DESCRIBE, label: 'x'.repeat(65) }, /invalid fields/],
    // A param whose VALUE can never round-trip: 'config' is the reserved
    // plugin-invocation key, and Object.prototype names resolve on the parsed
    // params record so an unfilled optional one reads as supplied.
    ['a reserved param key', { ...HOOK_DESCRIBE, params: [{ key: 'config', label: 'Config', type: 'string' }] }, /reserved param key 'config'/],
    ['a prototype-shadowing param key', { ...HOOK_DESCRIBE, params: [{ key: 'toString', label: 'Name', type: 'string' }] }, /reserved param key 'toString'/],
  ])('rejects a descriptor with %s', async (_label, data, message) => {
    // The broken provider vanishes from the list; the direct path surfaces
    // its specific bounded error.
    const service = describeService(data);
    await expect(service.list()).resolves.toEqual([]);
    await expect(service.prepare('hook', { chainId: 1, initcode: '0x00' })).rejects.toThrow(message);
  });

  it('fails a call-products descriptor whose manifest does not declare composeDeployment', async () => {
    const service = describeService({ ...HOOK_DESCRIBE, execution: 'call-products' });
    await expect(service.prepare('hook', { chainId: 1, initcode: '0x00' })).rejects.toThrow(/does not declare describeDeploymentType and composeDeployment/);
  });

  it('fails a create2 descriptor whose manifest declares composeDeployment', async () => {
    const sneaky: PluginConfig = { ...config, metadata: { ...config.metadata, operations: [...config.metadata.operations!, 'composeDeployment'] } };
    const service = describeService(HOOK_DESCRIBE, sneaky);
    await expect(service.prepare('hook', { chainId: 1, initcode: '0x00' })).rejects.toThrow(/declared create2 execution but the manifest declares composeDeployment/);
  });

  it('keeps a legacy manifest on the CREATE2 baseline and never grants composeDeployment', async () => {
    const service = describeService(HOOK_DESCRIBE, legacyConfig);
    await expect(service.list()).resolves.toEqual([expect.objectContaining({
      pluginId: 'legacy', pluginVersion: '0.9.0', execution: 'create2', validateSupported: true, composeSupported: false,
    })]);
    // The baseline never implicitly contains composeDeployment, so a legacy
    // manifest cannot become call-products by descriptor alone.
    const callProducts = describeService({ ...HOOK_DESCRIBE, execution: 'call-products' }, legacyConfig);
    await expect(callProducts.compose('p1', { ...REQUEST, pluginId: 'legacy' })).rejects.toThrow(/does not declare describeDeploymentType and composeDeployment/);
  });

  it('derives validateSupported from the effective validateDeployment operation', async () => {
    const prepared: PluginConfig = { ...config, metadata: { ...config.metadata, operations: ['describeDeploymentType', 'prepareDeployment'] } };
    const service = describeService(HOOK_DESCRIBE, prepared);
    await expect(service.list()).resolves.toEqual([expect.objectContaining({ validateSupported: false, composeSupported: false })]);
  });

  it('drops one broken provider from the list without hiding healthy providers', async () => {
    const warn = vi.fn();
    const execute = vi.fn(async (id: string, operation: string) => {
      if (operation !== 'describeDeploymentType') return { success: true as const, data: {} };
      return id === 'hook'
        ? { success: true as const, data: HOOK_DESCRIBE }
        : { success: true as const, data: { label: 'x'.repeat(65), description: 'd', params: [] } };
    });
    const service = new DeploymentTypeService({ getProviders: async () => [config, spawnerConfig], execute, warn });
    await expect(service.list()).resolves.toEqual([expect.objectContaining({ pluginId: 'hook' })]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawner was skipped'));
    // Direct dispatch against the broken provider gets its specific error,
    // not a generic not-found.
    await expect(service.prepare('spawner', { chainId: 1, initcode: '0x00' })).rejects.toThrow(/invalid fields/);
  });

  it('rejects CREATE2 operations for a call-products deployment type', async () => {
    const { service } = composeService();
    await expect(service.prepare('spawner', { chainId: 1, initcode: '0x00' })).rejects.toThrow(/prepareDeployment is not available for a call-products deployment type/);
    await expect(service.validate('spawner', { chainId: 1, initcode: '0x00', salt: hex32, predictedAddress: '0x1111111111111111111111111111111111111111' })).rejects.toThrow(/validateDeployment is not available for a call-products deployment type/);
  });

  it('freezes the same launch binding as authoring while the descriptor is stable', async () => {
    const { service } = composeService();
    const authored = await service.compose('profile-1', REQUEST);
    const binding = await service.launchBinding('spawner');
    expect(binding).toEqual(authored.binding);
    expect(binding).toMatchObject({ pluginId: 'spawner', pluginVersion: '2.1.0', execution: 'call-products', descriptorHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('rejects a descriptor that changed between authoring and launch', async () => {
    let describes = 0;
    const execute = vi.fn(async (_id: string, operation: string) => operation === 'describeDeploymentType'
      ? { success: true as const, data: { ...SPAWNER_DESCRIBE, description: (describes += 1) === 1 ? 'Spawns contracts' : 'Spawns something else now' } }
      : { success: true as const, data: { fields: FIELDS } });
    const service = new DeploymentTypeService({ getProviders: async () => [spawnerConfig], execute, freezeInputs: fakeFreeze(), warn: vi.fn() });
    // Authoring caches the reviewed descriptor; launch re-describes and must
    // reject the drifted identity rather than silently rebinding.
    await service.list();
    await expect(service.launchBinding('spawner')).rejects.toThrow(/changed its descriptor/);
  });

  // The authored identity is held apart from the descriptor cache: launch
  // re-describes into that cache, and invalidate() empties it on every
  // install/trust/config mutation, so a cache comparison made the
  // spec-mandated rejection one-shot — the next attempt compared the drifted
  // descriptor with itself and passed.
  function driftService() {
    const state = { description: 'Spawns contracts', response: { fields: FIELDS, composition: COMPOSITION } as unknown };
    const execute = vi.fn(async (_id: string, operation: string) => operation === 'describeDeploymentType'
      ? { success: true as const, data: { ...SPAWNER_DESCRIBE, description: state.description } }
      : { success: true as const, data: state.response });
    return { state, service: new DeploymentTypeService({ getProviders: async () => [spawnerConfig], execute, freezeInputs: fakeFreeze(), warn: vi.fn() }) };
  }

  it('keeps rejecting a drifted descriptor on repeat launches and after invalidate, until a recomposition rebinds it', async () => {
    const { state, service } = driftService();
    const authored = await service.compose('profile-1', REQUEST);
    state.description = 'Spawns something else now';
    await expect(service.launchBinding('spawner')).rejects.toThrow(/changed its descriptor/);
    // Same rejection without recomposing: the launch re-describe must never
    // become the authored identity.
    await expect(service.launchBinding('spawner')).rejects.toThrow(/changed its descriptor/);
    // Installing, trusting, or reconfiguring a plugin is not the user
    // re-authoring their plan against the new descriptor.
    service.invalidate();
    await expect(service.launchBinding('spawner')).rejects.toThrow(/changed its descriptor/);
    // Recomposing is: the returned binding is what the caller materializes
    // its plan against, so it is the recovery the rejection asks for.
    const recomposed = await service.compose('profile-1', REQUEST);
    expect(recomposed.binding.descriptorHash).not.toBe(authored.binding.descriptorHash);
    await expect(service.launchBinding('spawner')).resolves.toEqual(recomposed.binding);
  });

  it('does not lock a CREATE2 deployment type out when its descriptor drifts', async () => {
    // Recomposition is the ONLY thing that rebinds an authored hash, and a
    // CREATE2 plugin has no composer — so gating it on descriptor drift would
    // reject its launches forever (invalidate deliberately keeps the authored
    // hash, so even a reinstall would not clear it), telling the operator to
    // recompose something that cannot be composed. A config-driven description
    // is enough to trigger it. CREATE2 keeps its substantive protections: the
    // prepared salt/address commitment check and the host's own re-derivation.
    let describes = 0;
    const execute = vi.fn(async (_id: string, operation: string) => operation === 'describeDeploymentType'
      ? { success: true as const, data: { ...HOOK_DESCRIBE, description: (describes += 1) === 1 ? 'A hook' : 'A reconfigured hook' } }
      : { success: true as const, data: {} });
    const service = new DeploymentTypeService({ getProviders: async () => [config], execute, freezeInputs: fakeFreeze(), warn: vi.fn() });
    await service.list();
    await expect(service.launchBinding('hook')).resolves.toMatchObject({ pluginId: 'hook', execution: 'create2' });
  });

  it('does not rebind the authored descriptor when the recomposition fails', async () => {
    const { state, service } = driftService();
    await service.compose('profile-1', REQUEST);
    state.description = 'Spawns something else now';
    state.response = { fields: [], extra: 1 };
    // Only a composition the caller actually received counts as authoring.
    await expect(service.compose('profile-1', REQUEST)).rejects.toThrow(/unexpected fields/);
    await expect(service.launchBinding('spawner')).rejects.toThrow(/changed its descriptor/);
  });
});

describe('composeDeployment through the service boundary', () => {
  it('echoes the revision, freezes artifacts server-side, and returns a cross-checked composition', async () => {
    const { service, execute, freezeInputs } = composeService();
    const data = await service.compose('profile-1', REQUEST);
    expect(data.revision).toBe(3);
    expect(data.binding).toMatchObject({ pluginId: 'spawner', pluginVersion: '2.1.0', execution: 'call-products' });
    expect(data.fields).toEqual(FIELDS);
    // The executable signature and payability are CORE-derived from the
    // authoritative frozen ABI — never taken from the plugin response.
    expect(data.composition).toEqual({
      producer: { abiArtifactField: 'producer', targetField: 'target', functionField: 'fn', signature: 'spawn(address)', payable: false },
      products: [{ key: 'child', artifactField: 'child', outputIndex: 0 }],
    });
    expect(freezeInputs).toHaveBeenCalledWith('profile-1', [source('p'), source('c')]);
    // The plugin sees only the bounded view of explicitly selected artifacts.
    expect(execute).toHaveBeenCalledWith('spawner', 'composeDeployment', {
      compositionId: 'comp-1',
      values: REQUEST.values,
      artifacts: {
        producer: { selectionId: 'p', contractName: 'p', abi: PRODUCER_ABI },
        child: { selectionId: 'c', contractName: 'c', abi: PRODUCER_ABI },
      },
    }, { chainScope: 'none' });
  });

  it('derives payability from the selected ABI entry', async () => {
    const { service } = composeService({ abi: [{ ...SPAWN_FN, stateMutability: 'payable' }] });
    const data = await service.compose('profile-1', REQUEST);
    expect(data.composition?.producer.payable).toBe(true);
  });

  it('returns fields and blocker without a composition while the form is incomplete', async () => {
    const { service } = composeService({ response: { fields: FIELDS, blocker: 'Select a spawn function first' } });
    const data = await service.compose('profile-1', REQUEST);
    expect(data.blocker).toBe('Select a spawn function first');
    expect(data.composition).toBeUndefined();
  });

  it('rejects composition on a create2 deployment type', async () => {
    const service = new DeploymentTypeService({
      getProviders: async () => [config],
      execute: async () => ({ success: true, data: HOOK_DESCRIBE }),
      freezeInputs: fakeFreeze(),
      warn: vi.fn(),
    });
    await expect(service.compose('p1', { ...REQUEST, pluginId: 'hook' })).rejects.toThrow(/does not support composition/);
  });

  const field = (overrides: Record<string, unknown>) => ({ type: 'address', key: 'x', label: 'X', ...overrides });
  it.each([
    ['unknown response keys', { fields: [], extra: 1 }, /unexpected fields/],
    ['more than 32 fields', { fields: Array.from({ length: 33 }, (_, index) => field({ key: `k${index}` })) }, /invalid fields/],
    ['duplicate field keys', { fields: [field({}), field({})] }, /duplicate field keys/],
    ['an invalid field kind', { fields: [field({ type: 'text' })] }, /invalid field type/],
    // Declaring these would render a field whose value the compose request
    // schema rejects ('config') or that reads as supplied when left empty
    // (Object.prototype names) — a dead end for the user either way.
    ['the reserved config field key', { fields: [field({ key: 'config' })] }, /reserved field key 'config'/],
    ['a prototype-shadowing field key', { fields: [field({ key: 'valueOf' })] }, /reserved field key 'valueOf'/],
    ['duplicate artifact origins', { fields: [field({ type: 'artifact', origins: ['repo', 'repo'] })] }, /invalid field origins/],
    ['an unknown artifact origin', { fields: [field({ type: 'artifact', origins: ['everywhere'] })] }, /invalid field origins/],
    ['an empty select', { fields: [field({ type: 'select', options: [] })] }, /invalid select options/],
    ['duplicate select values', { fields: [field({ type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] })] }, /duplicate select options/],
    ['a blocker alongside a composition', { fields: FIELDS, blocker: 'wait', composition: COMPOSITION }, /composition alongside a blocker/],
    ['unknown composition keys', { fields: FIELDS, composition: { ...COMPOSITION, extra: 1 } }, /unexpected composition fields/],
    ['more than 16 products', { fields: FIELDS, composition: { ...COMPOSITION, products: Array.from({ length: 17 }, (_, index) => ({ key: `p${index}`, artifactField: 'child', outputIndex: index })) } }, /invalid product list/],
    ['duplicate product keys', { fields: FIELDS, composition: { ...COMPOSITION, products: [{ key: 'child', artifactField: 'child', outputIndex: 0 }, { key: 'child', artifactField: 'child', outputIndex: 1 }] } }, /duplicate product keys/],
    ['duplicate product output indexes', { fields: FIELDS, composition: { ...COMPOSITION, products: [{ key: 'a', artifactField: 'child', outputIndex: 0 }, { key: 'b', artifactField: 'child', outputIndex: 0 }] } }, /duplicate product output indexes/],
    ['unknown product keys', { fields: FIELDS, composition: { ...COMPOSITION, products: [{ key: 'child', artifactField: 'child', outputIndex: 0, extra: 1 }] } }, /unexpected product fields/],
  ])('rejects a compose response with %s', async (_label, response, message) => {
    const { service } = composeService({ response });
    await expect(service.compose('profile-1', REQUEST)).rejects.toThrow(message);
  });

  it.each([
    ['an undeclared composer value', { values: { ...REQUEST.values, mystery: 'x' } }, /does not match a declared field/],
    ['an undeclared artifact selection', { artifacts: { ...REQUEST.artifacts, mystery: source('m') } }, /does not match a declared artifact field/],
    ['a missing required field', { values: { fn: 'spawn(address)' } }, /Composer field target is required/],
    ['an invalid address value', { values: { ...REQUEST.values, target: 'nope' } }, /must be a valid address/],
    ['a select value outside the declared options', { values: { ...REQUEST.values, fn: 'other()' } }, /must be one of the declared options/],
  ])('rejects a composition whose inputs carry %s', async (_label, override, message) => {
    const { service } = composeService();
    await expect(service.compose('profile-1', { ...REQUEST, ...override } as ComposeDeploymentRequest)).rejects.toThrow(message);
  });

  it('rejects an artifact selection that violates the declared origins', async () => {
    const restricted = FIELDS.map((entry) => entry.key === 'producer' ? { ...entry, origins: ['contract-type'] } : entry);
    const { service } = composeService({ response: { fields: restricted, composition: COMPOSITION } });
    await expect(service.compose('profile-1', REQUEST)).rejects.toThrow(/does not accept repo sources/);
  });

  it.each([
    ['abiArtifactField naming a non-artifact field', { producer: { ...COMPOSITION.producer, abiArtifactField: 'target' } }, /producer.abiArtifactField must reference a declared artifact field/],
    ['targetField naming a non-address field', { producer: { ...COMPOSITION.producer, targetField: 'fn' } }, /producer.targetField must reference a declared address field/],
    ['functionField naming a non-select field', { producer: { ...COMPOSITION.producer, functionField: 'producer' } }, /producer.functionField must reference a declared select field/],
    ['a non-address product output', { products: [{ key: 'child', artifactField: 'child', outputIndex: 1 }] }, /is not an address output/],
    ['an out-of-range product output', { products: [{ key: 'child', artifactField: 'child', outputIndex: 9 }] }, /is not an address output/],
    ['product params with unknown keys', { products: [{ key: 'child', artifactField: 'child', outputIndex: 0, params: { nope: 1 } }] }, /Unknown deployment-type parameter/],
  ])('rejects a composition with %s', async (_label, override, message) => {
    const { service } = composeService({ response: { fields: FIELDS, composition: { ...COMPOSITION, ...override } } });
    await expect(service.compose('profile-1', REQUEST)).rejects.toThrow(message);
  });

  it('rejects a product that references an unselected artifact', async () => {
    const optional = FIELDS.map((entry) => entry.key === 'child' ? { ...entry, required: false } : entry);
    const { service } = composeService({ response: { fields: optional, composition: COMPOSITION } });
    await expect(
      service.compose('profile-1', { ...REQUEST, artifacts: { producer: source('p') } })
    ).rejects.toThrow(/references an unselected artifact/);
  });

  it('resolves the selector against exactly one state-changing ABI function', async () => {
    // Zero matches: the declared select value is not in the authoritative ABI.
    const declared = FIELDS.map((entry) => entry.key === 'fn' ? { ...entry, options: [{ value: 'missing()', label: 'missing()' }] } : entry);
    const zero = composeService({ response: { fields: declared, composition: COMPOSITION } });
    await expect(
      zero.service.compose('profile-1', { ...REQUEST, values: { ...REQUEST.values, fn: 'missing()' } })
    ).rejects.toThrow(/does not match the selected ABI/);

    // Two matches: duplicate ABI entries make the selector ambiguous.
    const two = composeService({ abi: [SPAWN_FN, { ...SPAWN_FN }] });
    await expect(two.service.compose('profile-1', REQUEST)).rejects.toThrow(/ambiguous in the selected ABI/);

    // View functions produce nothing.
    const view = composeService({ abi: [{ ...SPAWN_FN, stateMutability: 'view' }] });
    await expect(view.service.compose('profile-1', REQUEST)).rejects.toThrow(/must be state-changing/);
  });

  it('bounds composer values and supplied ABIs', async () => {
    const { service } = composeService();
    await expect(
      service.compose('profile-1', { ...REQUEST, values: { ...REQUEST.values, blob: 'x'.repeat(64 * 1024) } })
    ).rejects.toThrow(/exceed 64 KiB/);

    // Per-value cap, independent of the route schema: a plugin echoing a value
    // into its 1..500-char blocker or a 1..280-char label must not be able to
    // overflow that cap with what the host handed it.
    await expect(
      service.compose('profile-1', { ...REQUEST, values: { ...REQUEST.values, blob: 'x'.repeat(513) } })
    ).rejects.toThrow(/Composer value blob exceeds 512 characters/);
    await expect(
      service.compose('profile-1', { ...REQUEST, values: { ...REQUEST.values, blob: Array.from({ length: 200 }, (_, index) => index) } })
    ).rejects.toThrow(/exceeds 512 characters/);

    const oversized = composeService({ abi: [{ padding: 'x'.repeat(512 * 1024) }] });
    await expect(oversized.service.compose('profile-1', REQUEST)).rejects.toThrow(/oversized ABI/);
  });

  it('accepts a full composer form of maximum-length values', async () => {
    // The per-value cap must bound only the individual value: a composition
    // carrying every field it may declare, each at the largest value the
    // vocabulary allows, still has to compose.
    const option = 'x'.repeat(280);
    const extra = Array.from({ length: 28 }, (_, index) => ({ type: 'select', key: `field${index}`, label: `F${index}`, options: [{ value: option, label: 'Big' }] }));
    const { service } = composeService({ response: { fields: [...FIELDS, ...extra], composition: COMPOSITION } });
    const values = { ...REQUEST.values, ...Object.fromEntries(extra.map((entry) => [entry.key, option])) };
    await expect(service.compose('profile-1', { ...REQUEST, values })).resolves.toMatchObject({ revision: 3, composition: expect.objectContaining({ products: COMPOSITION.products }) });
  });
});
