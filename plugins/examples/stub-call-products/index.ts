// Throwaway call-products deployment-type plugin used only to verify the
// installed plugin path for the call-products execution mode in core
// integration tests. Not shipped in the builtin catalog. Deliberately
// non-factory — different labels and field keys, a single tracked product —
// while speaking the exact same public producer/products contract.
import {
  CallProductsDeploymentTypePlugin,
  PluginType,
  runPluginCLI,
  type CallProductsDeploymentTypeOperations,
  type ComposeDeploymentParams,
  type ComposeDeploymentResult,
  type DeploymentComposerField,
  type DescribeDeploymentTypeResult,
  type PluginMetadata,
  type PluginResponse,
} from '../../src/shared/index.ts';
import { toFunctionSignature, type AbiFunction } from 'viem';

declare const PLUGIN_VERSION: string;

interface SpawnCandidate {
  // Canonical input-only signature: the select value core resolves against
  // the authoritative selected ABI.
  signature: string;
  // First address output only — this fixture tracks a single product, which
  // is all the installed-plugin integration proof needs.
  outputIndex: number;
}

// The host caps a select at 64 options and each option value at 280
// characters, and rejects duplicate values — and it rejects a violating
// compose response WHOLE, so even a fixture must respect the caps itself
// rather than rely on core to trim.
const MAX_OPTIONS = 64;
const MAX_SELECT_VALUE = 280;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Lenient by design: core's service boundary revalidates every response, so
// this fixture only needs the happy path plus an honest blocker for an ABI
// it cannot use. Entries it cannot read are skipped, not fatal.
function spawnCandidates(abi: unknown): SpawnCandidate[] | undefined {
  if (!Array.isArray(abi)) return undefined;
  const candidates: SpawnCandidate[] = [];
  for (const entry of abi) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'function' || typeof record.name !== 'string') continue;
    if (record.stateMutability === 'view' || record.stateMutability === 'pure') continue;
    const outputs = Array.isArray(record.outputs) ? record.outputs : [];
    const outputIndex = outputs.findIndex(
      (output) => typeof output === 'object' && output !== null && (output as { type?: unknown }).type === 'address',
    );
    if (outputIndex === -1) continue;
    let signature: string;
    try {
      signature = toFunctionSignature({
        type: 'function',
        name: record.name,
        stateMutability: 'nonpayable',
        inputs: Array.isArray(record.inputs) ? record.inputs : [],
        outputs: [],
      } as unknown as AbiFunction);
    } catch {
      continue;
    }
    // A signature the host cannot carry in a select value is not offerable at
    // all, so the function is skipped rather than poisoning the response.
    if (signature.length > MAX_SELECT_VALUE || signature.replace(CONTROL, '') !== signature) continue;
    candidates.push({ signature, outputIndex });
  }
  // A signature the ABI declares twice would emit duplicate option values, and
  // the selection would be ambiguous against the authoritative ABI anyway.
  const occurrences = new Map<string, number>();
  for (const candidate of candidates)
    occurrences.set(candidate.signature, (occurrences.get(candidate.signature) ?? 0) + 1);
  return candidates
    .filter((candidate) => occurrences.get(candidate.signature) === 1)
    .slice(0, MAX_OPTIONS);
}

export class StubCallProductsPlugin extends CallProductsDeploymentTypePlugin {
  protected static getMetadata(): PluginMetadata {
    return {
      id: 'stub-call-products',
      types: [PluginType.DEPLOYMENT_TYPE],
      name: 'Stub Call Products',
      version: typeof PLUGIN_VERSION === 'string' ? PLUGIN_VERSION : '0.0.1',
      baseImage: 'ignite/installed_stub-call-products:0.0.1',
      permissions: [],
      operations: ['describeDeploymentType', 'composeDeployment'],
      configFields: [],
    };
  }

  async describeDeploymentType(): Promise<PluginResponse<DescribeDeploymentTypeResult>> {
    return {
      success: true,
      data: {
        label: 'Stub Call Products',
        description: 'Composes one producer call that spawns a single tracked contract.',
        execution: 'call-products',
        params: [],
      },
    };
  }

  async composeDeployment(
    options: ComposeDeploymentParams,
  ): Promise<PluginResponse<ComposeDeploymentResult>> {
    const fields: DeploymentComposerField[] = [
      { type: 'artifact', key: 'producer', label: 'Producer contract', required: true },
      { type: 'address', key: 'target', label: 'Producer address', required: true },
    ];
    const done = (
      extra?: Pick<ComposeDeploymentResult, 'blocker' | 'composition'>,
    ): PluginResponse<ComposeDeploymentResult> => ({ success: true, data: { fields, ...extra } });

    const producer = options.artifacts['producer'];
    if (!producer) return done();

    const candidates = spawnCandidates(producer.abi);
    if (!candidates) {
      return done({ blocker: 'The selected producer artifact does not contain a readable ABI.' });
    }
    if (candidates.length === 0) {
      return done({ blocker: 'The producer ABI has no state-changing function that returns an address.' });
    }

    fields.push({
      type: 'select',
      key: 'spawnFunction',
      label: 'Spawn function',
      required: true,
      options: candidates.map((candidate) => ({ value: candidate.signature, label: candidate.signature })),
    });

    const selectedSignature = options.values['spawnFunction'];
    const selected = candidates.find((candidate) => candidate.signature === selectedSignature);
    if (!selected) return done();

    fields.push({ type: 'artifact', key: 'spawned', label: 'Spawned contract', required: true });

    const target = options.values['target'];
    const targetShaped = typeof target === 'string' && /^0x[0-9a-fA-F]{40}$/.test(target);
    if (!targetShaped || options.artifacts['spawned'] === undefined) return done();

    return done({
      composition: {
        producer: { abiArtifactField: 'producer', targetField: 'target', functionField: 'spawnFunction' },
        products: [{ key: 'spawned', artifactField: 'spawned', outputIndex: selected.outputIndex }],
      },
    });
  }
}

const plugin = new StubCallProductsPlugin();
export default plugin;

runPluginCLI<keyof CallProductsDeploymentTypeOperations>(plugin);
