import {
  CallProductsDeploymentTypePlugin,
  PluginType,
  type CallProductsDeploymentTypeOperations,
  type ComposeDeploymentParams,
  type ComposeDeploymentResult,
  type DeploymentComposerField,
  type DescribeDeploymentTypeResult,
  type PluginMetadata,
  type PluginResponse,
} from '../../shared/index.ts';
import { runPluginCLI } from '../../shared/plugin-runner.js';
import { toFunctionSignature, type AbiFunction } from 'viem';

declare const PLUGIN_VERSION: string;

// The host supplies the selected artifact's ABI as `unknown`; this is the
// bounded structural view the plugin trusts after shape-checking. Anything
// that fails these checks becomes a blocker, never a thrown error.
interface AbiParameter {
  type: string;
  name?: string;
  components?: AbiParameter[];
}

interface FactoryFunction {
  name: string;
  inputs: AbiParameter[];
  outputs: AbiParameter[];
}

interface CandidateProduct {
  key: string;
  // Positional across ALL outputs so it matches core's positional decode of
  // the producer's return data.
  outputIndex: number;
  // Set when the ABI's own output name could not serve as a host key and the
  // positional fallback was used instead; surfaced on the product field.
  renamedFrom?: string;
}

interface CandidateFunction {
  // Canonical input-only signature (viem toFunctionSignature): the select
  // value and the overload discriminator core resolves against the ABI.
  signature: string;
  label: string;
  // Address outputs only.
  products: CandidateProduct[];
  // Why this function cannot be offered as a select option, if it cannot. An
  // unusable candidate is kept rather than dropped so a stale selection of it
  // gets the real reason instead of a misleading "no longer declares".
  unusable?: string;
}

interface OmittedFunction {
  signature: string;
  reason: string;
}

// The host's bounded-input contract, enforced here because core's
// DeploymentTypeService rejects a violating compose response WHOLE: one
// unrepresentable function or output name would otherwise discard the entire
// field list — including the usable candidates — as a generic 400.
const MAX_SELECT_VALUE = 280;
const MAX_LABEL = 280;
const MAX_DESCRIPTION = 280;
const MAX_OPTIONS = 64;
const MAX_PRODUCTS = 16;
const MAX_BLOCKER = 500;
const MAX_FIELD_KEY = 64;
// Core's field-key contract. A product key is used twice — bare in
// `composition.products[].key` and prefixed in the product artifact field key
// — so it must satisfy the regex on its own and leave room for the prefix.
const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const PRODUCT_KEY_PREFIX = 'product.';
const MAX_PRODUCT_KEY = MAX_FIELD_KEY - PRODUCT_KEY_PREFIX.length;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const MALFORMED_ABI_BLOCKER =
  'The selected factory artifact does not contain a readable ABI.';
const NO_CANDIDATES_BLOCKER =
  'The selected factory ABI has no state-changing function that returns an address.';
const FUNCTION_SELECT_DESCRIPTION =
  'State-changing functions that return at least one address.';

// Bounds every string built from ABI content or client input. The host strips
// control characters from labels, descriptions and blockers but rejects them
// outright inside a select value, so both hazards are handled up front.
function bounded(value: string, max: number): string {
  const clean = value.replace(CONTROL, '');
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function describeOmissions(omitted: OmittedFunction[]): string {
  const first = omitted[0]!;
  const subject = `${bounded(first.signature, 80)} cannot be offered because ${first.reason}`;
  return omitted.length === 1
    ? `${subject}.`
    : `${omitted.length} functions cannot be offered, starting with ${subject}.`;
}

// `output<index>` is the stable key unnamed outputs already use, and it is also
// the fallback for a name the host cannot accept as a key: `$` is legal in a
// Solidity identifier but not in a field key, a leading `_` fails the key
// regex, and a long name overflows the 64-char cap. Falling back can never
// mis-map a product — the authoritative mapping is outputIndex, which the
// fallback is derived from and which never changes.
function productAt(name: string | undefined, index: number): CandidateProduct {
  const positional = `output${index}`;
  if (name === undefined || name === '') return { key: positional, outputIndex: index };
  if (!FIELD_KEY.test(name) || name.length > MAX_PRODUCT_KEY)
    return { key: positional, outputIndex: index, renamedFrom: name };
  return { key: name, outputIndex: index };
}

function unusableReason(signature: string, products: CandidateProduct[]): string | undefined {
  if (products.length > MAX_PRODUCTS)
    return `it returns ${products.length} addresses and at most ${MAX_PRODUCTS} products can be tracked`;
  // Two outputs whose names collapse to the same key would produce colliding
  // `product.<key>` fields and colliding composition product keys.
  if (new Set(products.map((product) => product.key)).size !== products.length)
    return 'its address outputs collapse to duplicate product keys';
  if (signature.replace(CONTROL, '') !== signature)
    return 'its signature contains characters that cannot be carried in a selection';
  if (signature.length > MAX_SELECT_VALUE)
    return `its signature is ${signature.length} characters and at most ${MAX_SELECT_VALUE} can be carried in a selection`;
  return undefined;
}

function parseParameters(value: unknown): AbiParameter[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parameters: AbiParameter[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    if (typeof record.type !== 'string' || record.type === '') return undefined;
    if (record.name !== undefined && typeof record.name !== 'string') return undefined;
    let components: AbiParameter[] | undefined;
    if (record.components !== undefined) {
      components = parseParameters(record.components);
      if (!components) return undefined;
    }
    // A tuple without components cannot expand to a canonical signature —
    // viem would format it as the non-canonical literal `tuple`.
    if (record.type.startsWith('tuple') && components === undefined) return undefined;
    parameters.push({
      type: record.type,
      name: typeof record.name === 'string' ? record.name : undefined,
      components,
    });
  }
  return parameters;
}

function parseFunctionEntry(record: Record<string, unknown>): FactoryFunction | undefined {
  if (typeof record.name !== 'string' || record.name === '') return undefined;
  const inputs = parseParameters(record.inputs ?? []);
  const outputs = parseParameters(record.outputs ?? []);
  if (!inputs || !outputs) return undefined;
  return { name: record.name, inputs, outputs };
}

function isStateChanging(record: Record<string, unknown>): boolean {
  const mutability = record.stateMutability;
  if (typeof mutability === 'string') return mutability !== 'view' && mutability !== 'pure';
  // Pre-0.5.0 compilers emitted `constant` instead of stateMutability.
  return record.constant !== true;
}

// Human-readable parameter rendering for select labels: tuples expand to
// their named components so overloads read the way the source declares them.
function formatParameter(parameter: AbiParameter): string {
  const type = parameter.type.startsWith('tuple')
    ? `(${(parameter.components ?? []).map(formatParameter).join(', ')})${parameter.type.slice('tuple'.length)}`
    : parameter.type;
  return parameter.name ? `${type} ${parameter.name}` : type;
}

function collectCandidates(abi: unknown): { candidates: CandidateFunction[] } | { blocker: string } {
  if (!Array.isArray(abi)) return { blocker: MALFORMED_ABI_BLOCKER };
  const candidates: CandidateFunction[] = [];
  for (const entry of abi) {
    if (typeof entry !== 'object' || entry === null) return { blocker: MALFORMED_ABI_BLOCKER };
    const record = entry as Record<string, unknown>;
    // Constructors, events, errors, fallback and receive are not callable
    // producers; only function entries participate in discovery.
    if (record.type !== 'function') continue;
    const fn = parseFunctionEntry(record);
    if (!fn) return { blocker: MALFORMED_ABI_BLOCKER };
    if (!isStateChanging(record)) continue;
    const products = fn.outputs.flatMap((output, index) =>
      output.type === 'address' ? [productAt(output.name, index)] : [],
    );
    if (products.length === 0) continue;
    let signature: string;
    try {
      // Shape-checked entries are expected to format cleanly; the catch is
      // belt-and-braces so an ABI can only ever blocker, never crash.
      signature = toFunctionSignature({
        type: 'function',
        name: fn.name,
        stateMutability: 'nonpayable',
        inputs: fn.inputs,
        outputs: [],
      } as unknown as AbiFunction);
    } catch {
      return { blocker: MALFORMED_ABI_BLOCKER };
    }
    const unusable = unusableReason(signature, products);
    candidates.push({
      signature,
      // A label is cosmetic — the option value identifies the function — so an
      // over-long one is shortened with a visible ellipsis rather than costing
      // the user a reachable candidate. Its prefix survives, which is where
      // overloads differ first.
      label: bounded(
        `${fn.name}(${fn.inputs.map(formatParameter).join(', ')}) → deploys ${products
          .map((product) => product.key)
          .join(', ')}`,
        MAX_LABEL,
      ),
      products,
      ...(unusable === undefined ? {} : { unusable }),
    });
  }
  // A signature the ABI declares twice cannot be offered at all: duplicate
  // option values are rejected wholesale by the host, and the selection would
  // be ambiguous against the authoritative ABI anyway.
  const occurrences = new Map<string, number>();
  for (const candidate of candidates)
    occurrences.set(candidate.signature, (occurrences.get(candidate.signature) ?? 0) + 1);
  for (const candidate of candidates)
    if (candidate.unusable === undefined && (occurrences.get(candidate.signature) ?? 0) > 1)
      candidate.unusable = 'the selected ABI declares it more than once';
  return { candidates };
}

export class FactoryDeploymentTypePlugin extends CallProductsDeploymentTypePlugin {
  protected static getMetadata(): PluginMetadata {
    return {
      id: 'factory',
      types: [PluginType.DEPLOYMENT_TYPE],
      name: 'Factory',
      version: PLUGIN_VERSION,
      baseImage: 'ignite/deployment-type_factory:latest',
      permissions: [],
      operations: ['describeDeploymentType', 'composeDeployment'],
      configFields: [],
    };
  }

  async describeDeploymentType(): Promise<PluginResponse<DescribeDeploymentTypeResult>> {
    return {
      success: true,
      data: {
        label: 'Factory',
        description:
          'Compose a call to an existing factory contract and track the contracts it deploys as products.',
        execution: 'call-products',
        params: [],
      },
    };
  }

  async composeDeployment(
    options: ComposeDeploymentParams,
  ): Promise<PluginResponse<ComposeDeploymentResult>> {
    const fields: DeploymentComposerField[] = [
      { type: 'artifact', key: 'factory', label: 'Factory contract', required: true, origins: ['repo'] },
      { type: 'address', key: 'address', label: 'Factory address', required: true },
    ];
    const done = (extra?: Pick<ComposeDeploymentResult, 'blocker' | 'composition'>): PluginResponse<ComposeDeploymentResult> => ({
      success: true,
      data: { fields, ...extra },
    });

    const factory = options.artifacts['factory'];
    if (!factory) return done();

    const scan = collectCandidates(factory.abi);
    if ('blocker' in scan) return done({ blocker: scan.blocker });
    if (scan.candidates.length === 0) return done({ blocker: NO_CANDIDATES_BLOCKER });

    // Offer only what the host can carry, and only as many options as it
    // accepts. Everything left over is named honestly rather than dropped
    // silently, and stays unselectable so no mapping can dead-end at the host.
    const offered: CandidateFunction[] = [];
    const omitted: OmittedFunction[] = [];
    for (const candidate of scan.candidates) {
      const reason =
        candidate.unusable ??
        (offered.length >= MAX_OPTIONS
          ? `only the first ${MAX_OPTIONS} functions of an ABI can be offered`
          : undefined);
      if (reason === undefined) offered.push(candidate);
      else omitted.push({ signature: candidate.signature, reason });
    }

    if (offered.length === 0) {
      return done({
        blocker: bounded(
          `The selected factory ABI has no usable factory function: ${describeOmissions(omitted)}`,
          MAX_BLOCKER,
        ),
      });
    }

    fields.push({
      type: 'select',
      key: 'function',
      label: 'Factory function',
      description:
        omitted.length === 0
          ? FUNCTION_SELECT_DESCRIPTION
          : bounded(`${FUNCTION_SELECT_DESCRIPTION} ${describeOmissions(omitted)}`, MAX_DESCRIPTION),
      required: true,
      options: offered.map((candidate) => ({
        value: candidate.signature,
        label: candidate.label,
      })),
    });

    const selectedSignature = options.values['function'];
    if (typeof selectedSignature !== 'string' || selectedSignature === '') return done();

    // Signatures are unique across `offered` — a duplicated one is omitted —
    // so an exact match is unambiguous.
    const selected = offered.find((candidate) => candidate.signature === selectedSignature);
    if (!selected) {
      const skipped = omitted.find((entry) => entry.signature === selectedSignature);
      return done({
        blocker: bounded(
          skipped
            ? `${bounded(skipped.signature, 120)} cannot be offered because ${skipped.reason}; pick another function.`
            : `The selected factory ABI no longer declares ${bounded(selectedSignature, 120)}; pick a function again.`,
          MAX_BLOCKER,
        ),
      });
    }

    for (const product of selected.products) {
      fields.push({
        type: 'artifact',
        key: `${PRODUCT_KEY_PREFIX}${product.key}`,
        label: `Product contract '${product.key}'`,
        required: true,
        ...(product.renamedFrom === undefined
          ? {}
          : {
              description: bounded(
                `The ABI names this output '${bounded(product.renamedFrom, 80)}', which cannot be used as a field key, so it is keyed by its output position instead.`,
                MAX_DESCRIPTION,
              ),
            }),
      });
    }

    // A composition is all-or-nothing: the host must never see a producer
    // whose products are only partially mapped. Address validity beyond shape
    // is the host's job.
    const address = options.values['address'];
    const addressShaped = typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address);
    const fullyMapped = selected.products.every(
      (product) => options.artifacts[`${PRODUCT_KEY_PREFIX}${product.key}`] !== undefined,
    );
    if (!addressShaped || !fullyMapped) return done();

    return done({
      composition: {
        producer: { abiArtifactField: 'factory', targetField: 'address', functionField: 'function' },
        products: selected.products.map((product) => ({
          key: product.key,
          artifactField: `${PRODUCT_KEY_PREFIX}${product.key}`,
          outputIndex: product.outputIndex,
        })),
      },
    });
  }
}

const plugin = new FactoryDeploymentTypePlugin();
export default plugin;
runPluginCLI<keyof CallProductsDeploymentTypeOperations>(plugin);
