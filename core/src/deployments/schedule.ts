import {
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  parseAbiItem,
  type Abi,
  type AbiFunction,
  type AbiParameter,
} from 'viem';
import {
  CREATE2_PROXY_ADDRESS,
  type DeploymentPlan,
  type DeployStep,
  type FrozenInputs,
  type Hex,
  type Hex32,
} from '@ignite/api';
import {
  effectiveSalt,
  initcodeHashOf,
  predictCreate2Address,
  create2Calldata,
} from './create2.js';
import {
  buildFactoryCalldata,
  decodeFactoryProducts,
  isFactoryStrategy,
  mergeFactoryArgs,
  mergeFactoryTarget,
  productAddress,
  productInitcodeHash,
  resolveFactoryAddress,
} from './factory.js';
import {
  callAbiItem,
  callTargetAbi,
  dynamicDeterministicStepIds,
  effectiveValue,
  mergeArgs,
  mergeCallTarget,
  resolveSigner,
  resolveStepValues,
  toConstructorArgs,
  validateDependencies,
} from './resolver.js';
import { flattenLinkReferences, linkBytecode } from './linking.js';
import type { DeploymentTypeService } from './DeploymentTypeService.js';

export interface ScheduleEntry {
  stepId: string;
  kind: 'tx' | 'existing';
  from?: Hex;
  to?: Hex | null;
  data?: Hex;
  value?: bigint;
  address?: Hex;
  predictedAddress?: Hex;
}
export type Predictions = Record<
  string,
  { predictedAddress: Hex; initcodeHash: Hex32; salt: Hex32 }
>;
export type ProvisionalPrediction =
  | {
      predictedAddress: Hex;
      initcodeHash: Hex32;
      salt: Hex32;
      provisional?: true;
      notes?: string[];
    }
  | { absent: true; reason: string; provisional: true };
export type ChainPredictions = {
  predictions: Predictions;
  entries: Record<string, ProvisionalPrediction>;
  createAddresses: Map<string, Hex>;
  baseNonces: Map<Hex, number>;
  nonceError?: string;
  confirmedExisting: Set<string>;
  dynamic: Set<string>;
};
type SnapshotClient = {
  getTransactionCount?(args: {
    address: Hex;
    blockTag?: 'latest';
  }): Promise<number | bigint>;
  getCode?(args: { address: Hex }): Promise<Hex | undefined>;
  call?(args: {
    to: Hex;
    data: Hex;
  }): Promise<{ data?: Hex } | Hex | undefined>;
};
export function hasPredicted(
  entry: ProvisionalPrediction | undefined
): entry is Exclude<ProvisionalPrediction, { absent: true }> {
  return Boolean(entry && 'predictedAddress' in entry);
}
const provisionalCache = new Map<
  string,
  {
    expires: number;
    value: Promise<{ salt: Hex32; predictedAddress: Hex; notes: string[] }>;
  }
>();
export function clearProvisionalPredictionCache(): void {
  provisionalCache.clear();
}

function constructorInputs(abi: unknown): AbiParameter[] {
  return Array.isArray(abi)
    ? ((
        abi.find(
          (entry) =>
            entry &&
            typeof entry === 'object' &&
            (entry as { type?: string }).type === 'constructor'
        ) as { inputs?: AbiParameter[] } | undefined
      )?.inputs ?? [])
    : [];
}
function linkedCode(
  step: DeployStep,
  input: FrozenInputs[string],
  libraries: Record<string, Hex> | undefined
): Hex {
  return input.creationCodeLinkReferences
    ? linkBytecode(
        input.creationBytecode,
        input.creationCodeLinkReferences,
        libraries ?? {}
      )
    : (input.creationBytecode as Hex);
}
export function buildInitcode(
  step: DeployStep,
  input: FrozenInputs[string],
  chainId: number,
  resolveRef: (stepId: string) => Hex,
  context: {
    frozen?: FrozenInputs;
    contracts?: DeploymentPlan['contracts'];
  } = {}
): Hex {
  const ctor = constructorInputs(input.abi);
  const values = resolveStepValues(step, chainId, resolveRef, ctor, context);
  return encodeDeployData({
    abi: input.abi as Abi,
    bytecode: linkedCode(step, input, values.libraries),
    args: toConstructorArgs(ctor, values.args),
  });
}

export function buildRuntimeCode(
  step: DeployStep,
  input: FrozenInputs[string],
  chainId: number,
  resolveRef: (stepId: string) => Hex,
  context: {
    frozen?: FrozenInputs;
    contracts?: DeploymentPlan['contracts'];
  } = {}
): Hex | undefined {
  if (input.runtimeBytecode === undefined) return undefined;
  if (!input.runtimeBytecodeLinkReferences) return input.runtimeBytecode as Hex;
  try {
    const libraries =
      resolveStepValues(step, chainId, resolveRef, [], context).libraries ?? {};
    const keys = new Set(
      flattenLinkReferences(input.runtimeBytecodeLinkReferences).map(
        (ref) => ref.key
      )
    );
    return linkBytecode(
      input.runtimeBytecode,
      input.runtimeBytecodeLinkReferences,
      Object.fromEntries(
        Object.entries(libraries).filter(([key]) => keys.has(key))
      )
    );
  } catch {
    return undefined;
  }
}

export function predictPlanAddresses(
  plan: DeploymentPlan,
  frozen: FrozenInputs,
  chainId: number
): Predictions {
  validateDependencies(plan);
  const predicted: Predictions = {};
  const dynamic = dynamicDeterministicStepIds(plan, chainId);
  const remaining = plan.steps.filter(
    (step): step is DeployStep =>
      step.kind === 'deploy' &&
      !dynamic.has(step.id) &&
      (step.strategy?.kind === 'create2' || step.strategy?.kind === 'plugin')
  );
  while (remaining.length) {
    let firstRealError: unknown;
    const next = remaining.find((step) => {
      try {
        buildInitcode(
          step,
          frozen[step.contractId]!,
          chainId,
          (id) =>
            predicted[id]?.predictedAddress ??
            (() => {
              throw new Error('unresolved');
            })(),
          { frozen, contracts: plan.contracts }
        );
        return true;
      } catch (error) {
        // A pointer at a not-yet-predicted create2 step means "try later";
        // anything else (missing library binding, arg mismatch) is real.
        if ((error as { code?: string }).code !== 'POINTER_UNRESOLVED')
          firstRealError ??= error;
        return false;
      }
    });
    if (!next && firstRealError) throw firstRealError;
    if (!next)
      throw new Error(
        'Unable to resolve create2 predictions after dependency validation'
      );
    const strategy = next.strategy!;
    const salt = effectiveSalt(
      strategy as Extract<typeof strategy, { kind: 'create2' | 'plugin' }>,
      chainId
    );
    if (!salt) throw new Error(`No salt is available for ${next.id}`);
    const code = buildInitcode(
      next,
      frozen[next.contractId]!,
      chainId,
      (id) => predicted[id]!.predictedAddress,
      { frozen, contracts: plan.contracts }
    );
    const hash = initcodeHashOf(code);
    predicted[next.id] = {
      salt,
      initcodeHash: hash,
      predictedAddress: predictCreate2Address(salt, hash),
    };
    remaining.splice(remaining.indexOf(next), 1);
  }
  return predicted;
}

/** One review-time view: static commitments plus disposable dynamic estimates. */
export async function buildChainPredictions(
  plan: DeploymentPlan,
  frozen: FrozenInputs,
  chainId: number,
  deps: {
    client?: SnapshotClient;
    signers?: Map<string, Hex>;
    deploymentTypes?: Pick<DeploymentTypeService, 'prepare'>;
  }
): Promise<ChainPredictions> {
  validateDependencies(plan);
  const dynamic = dynamicDeterministicStepIds(plan, chainId);
  const predictions = predictPlanAddresses(plan, frozen, chainId);
  const entries: Record<string, ProvisionalPrediction> = { ...predictions };
  const signers = new Map<string, Hex>();
  for (const step of plan.steps) {
    const signer =
      deps.signers?.get(step.id) ??
      (resolveSigner(plan, step, chainId)?.address as Hex | undefined);
    if (signer) signers.set(step.id, signer);
  }
  const baseNonces = new Map<Hex, number>();
  let nonceError: string | undefined;
  const addresses = [
    ...new Set(
      [...signers.values()].map((address) => address.toLowerCase() as Hex)
    ),
  ];
  if (!deps.client?.getTransactionCount && addresses.length)
    nonceError = 'nonce read is unavailable';
  else
    await Promise.all(
      addresses.map(async (address) => {
        try {
          baseNonces.set(
            address,
            Number(
              await deps.client!.getTransactionCount!({
                address,
                blockTag: 'latest',
              })
            )
          );
        } catch (error) {
          nonceError ??= error instanceof Error ? error.message : String(error);
        }
      })
    );
  // One eth_call of the deploy function yields every address that call would
  // create, so all products of a call are predicted together. Steps that name
  // a fulfilling step share its result rather than calling again.
  const factorySteps = plan.steps.filter(
    (step): step is DeployStep =>
      step.kind === 'deploy' && isFactoryStrategy(step.strategy)
  );
  const decodedByCall = new Map<string, Record<string, Hex>>();
  for (const step of factorySteps) {
    const strategy = step.strategy as Extract<
      NonNullable<DeployStep['strategy']>,
      { kind: 'factory' }
    >;
    const absent = (reason: string) => {
      entries[step.id] = { absent: true, provisional: true, reason };
    };
    const callerId = strategy.fulfilledBy ?? step.id;
    if (!decodedByCall.has(callerId)) {
      const caller =
        callerId === step.id
          ? step
          : plan.steps.find((candidate) => candidate.id === callerId);
      // The call that deploys is ordinarily a plain call step — the honest
      // model, since no product should have to carry the transaction. A
      // factory step may also carry its own call when it is the only product.
      const call =
        caller?.kind === 'call'
          ? {
              signature: caller.signature,
              target: mergeCallTarget(caller, chainId),
              args: mergeArgs(caller, chainId),
            }
          : isFactoryStrategy(
                caller?.kind === 'deploy' ? caller.strategy : undefined
              )
            ? (() => {
                const factoryStrategy = (caller as DeployStep)
                  .strategy as Extract<
                  NonNullable<DeployStep['strategy']>,
                  { kind: 'factory' }
                >;
                return {
                  signature: factoryStrategy.signature,
                  target: mergeFactoryTarget(factoryStrategy, chainId),
                  args: mergeFactoryArgs(factoryStrategy, chainId),
                };
              })()
            : undefined;
      if (!call?.signature || !call.target) {
        absent(`step ${callerId} does not make a factory call`);
        continue;
      }
      if (!deps.client?.call) {
        absent('product addresses need an RPC to simulate the factory call');
        continue;
      }
      try {
        const resolvePointer = (id: string) => {
          const entry = entries[id];
          if (hasPredicted(entry)) return entry.predictedAddress;
          throw new Error(`Missing pointer ${id}`);
        };
        const factoryAddress =
          call.target.kind === 'address'
            ? call.target.address
            : resolvePointer(call.target.stepId);
        const fn = parseAbiItem(`function ${call.signature}`) as AbiFunction;
        const data = encodeFunctionData({
          abi: [fn],
          functionName: fn.name,
          args: toConstructorArgs(
            fn.inputs,
            resolveStepValues(
              {
                kind: 'deploy',
                id: callerId,
                contractId: '',
                args: call.args,
              } as never,
              chainId,
              resolvePointer,
              fn.inputs,
              { frozen, contracts: plan.contracts }
            ).args,
            'call'
          ) as never,
        });
        const raw = await deps.client.call({
          to: factoryAddress,
          data,
          ...(signers.get(callerId) ? { account: signers.get(callerId)! } : {}),
        });
        const result = typeof raw === 'string' ? raw : raw?.data;
        if (!result) throw new Error('factory call returned no data');
        decodedByCall.set(
          callerId,
          decodeFactoryProducts(call.signature, result)
        );
      } catch (error) {
        absent(error instanceof Error ? error.message : String(error));
        continue;
      }
    }
    const products = decodedByCall.get(callerId);
    if (!products) {
      absent('factory call produced no addresses');
      continue;
    }
    const address = productAddress(products, strategy.output);
    if (!address) {
      absent(
        `the factory call returned no address named ${strategy.output ?? '(first)'}`
      );
      continue;
    }
    entries[step.id] = {
      salt: `0x${'0'.repeat(64)}` as Hex32,
      initcodeHash: productInitcodeHash(frozen[step.contractId]!),
      predictedAddress: address,
      provisional: true,
      notes: [`returned by ${callerStrategyLabel(plan, callerId)}`],
    };
  }

  const confirmedExisting = new Set<string>();
  if (deps.client?.getCode)
    for (const step of plan.steps) {
      if (
        step.kind !== 'deploy' ||
        dynamic.has(step.id) ||
        !step.strategy ||
        step.strategy.kind === 'create'
      )
        continue;
      const current = predictions[step.id];
      if (!current || !ackIsFresh(step.strategy, chainId, current)) continue;
      const code = await deps.client
        .getCode({ address: current.predictedAddress })
        .catch(() => undefined);
      if (code && code !== '0x') confirmedExisting.add(step.id);
    }
  const createAddresses = nonceError
    ? new Map<string, Hex>()
    : computeCreateAddresses(
        plan,
        frozen,
        chainId,
        signers,
        baseNonces,
        confirmedExisting
      );
  for (const step of plan.steps) {
    if (step.kind !== 'deploy' || !dynamic.has(step.id)) continue;
    const absent = (reason: string) => {
      entries[step.id] = { absent: true, provisional: true, reason };
    };
    const signer = signers.get(step.id);
    if (!signer) {
      absent('signer is unavailable');
      continue;
    }
    if (nonceError) {
      absent(`nonce read failed: ${nonceError}`);
      continue;
    }
    try {
      const input = frozen[step.contractId];
      if (!input)
        throw new Error(`Frozen input missing for ${step.contractId}`);
      const initcode = buildInitcode(
        step,
        input,
        chainId,
        (id) => {
          const entry = entries[id];
          if (hasPredicted(entry)) return entry.predictedAddress;
          const created = createAddresses.get(id);
          if (created) return created;
          throw new Error(`Missing provisional pointer ${id}`);
        },
        { frozen, contracts: plan.contracts }
      );
      const hash = initcodeHashOf(initcode);
      const strategy = step.strategy!;
      if (strategy.kind === 'create2') {
        const salt = effectiveSalt(strategy, chainId);
        if (!salt) throw new Error(`No salt is available for ${step.id}`);
        entries[step.id] = {
          salt,
          initcodeHash: hash,
          predictedAddress: predictCreate2Address(salt, hash),
          provisional: true,
        };
        continue;
      }
      if (!deps.deploymentTypes)
        throw new Error('deployment-type preparation is unavailable');
      const runtimeBytecode = buildRuntimeCode(
        step,
        input,
        chainId,
        (id) => {
          const entry = entries[id];
          if (hasPredicted(entry)) return entry.predictedAddress;
          return (
            createAddresses.get(id) ??
            (() => {
              throw new Error(`Missing provisional pointer ${id}`);
            })()
          );
        },
        { frozen, contracts: plan.contracts }
      );
      if (strategy.kind !== 'plugin')
        throw new Error(`Unsupported deterministic strategy for ${step.id}`);
      const cacheKey = `${strategy.pluginId}:${chainId}:${hash}:${runtimeBytecode ? initcodeHashOf(runtimeBytecode) : ''}:${JSON.stringify(strategy.params ?? {})}`;
      const now = Date.now();
      let cached = provisionalCache.get(cacheKey);
      if (!cached || cached.expires < now) {
        const value = deps.deploymentTypes.prepare(strategy.pluginId, {
          chainId,
          initcode,
          ...(runtimeBytecode === undefined ? {} : { runtimeBytecode }),
          params: strategy.params,
        });
        cached = { expires: now + 30_000, value };
        provisionalCache.set(cacheKey, cached);
        void value.catch(() => {
          if (provisionalCache.get(cacheKey)?.value === value)
            provisionalCache.delete(cacheKey);
        });
        if (provisionalCache.size > 50)
          provisionalCache.delete(provisionalCache.keys().next().value!);
      }
      const prepared = await cached.value;
      if (
        predictCreate2Address(prepared.salt, hash).toLowerCase() !==
        prepared.predictedAddress.toLowerCase()
      )
        throw new Error(
          'deployment type returned a mismatched predicted address'
        );
      entries[step.id] = {
        salt: prepared.salt as Hex32,
        initcodeHash: hash,
        predictedAddress: prepared.predictedAddress as Hex,
        provisional: true,
        notes: prepared.notes,
      };
    } catch (error) {
      absent(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    predictions,
    entries,
    createAddresses,
    baseNonces,
    ...(nonceError ? { nonceError } : {}),
    confirmedExisting,
    dynamic,
  };
}

function callerStrategyLabel(plan: DeploymentPlan, stepId: string): string {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (step?.kind === 'call') return step.signature ?? stepId;
  const strategy = step?.kind === 'deploy' ? step.strategy : undefined;
  return (
    (isFactoryStrategy(strategy) ? strategy.signature : undefined) ?? stepId
  );
}

export function ackIsFresh(
  strategy: Exclude<NonNullable<DeployStep['strategy']>, { kind: 'create' }>,
  chainId: number,
  current: { predictedAddress: Hex; initcodeHash: Hex32 }
): boolean {
  const ack = strategy.acknowledgeDeployed?.[String(chainId)];
  return Boolean(
    ack &&
      ack.predictedAddress.toLowerCase() ===
        current.predictedAddress.toLowerCase() &&
      ack.initcodeHash.toLowerCase() === current.initcodeHash.toLowerCase()
  );
}

export function computeCreateAddresses(
  plan: DeploymentPlan,
  _frozen: FrozenInputs,
  chainId: number,
  signers: Map<string, Hex>,
  baseNonces: Map<Hex, number>,
  skipTx: Set<string> = new Set()
): Map<string, Hex> {
  const next = new Map(
    [...baseNonces.entries()].map(([address, nonce]) => [
      address.toLowerCase() as Hex,
      nonce,
    ])
  );
  const addresses = new Map<string, Hex>();
  for (const step of plan.steps) {
    // Acknowledged-existing steps broadcast nothing and consume no nonce.
    if (skipTx.has(step.id)) continue;
    const from =
      signers.get(step.id) ??
      (resolveSigner(plan, step, chainId)?.address as Hex | undefined);
    if (!from) continue;
    const key = from.toLowerCase() as Hex;
    const nonce = next.get(key) ?? 0;
    // Every scheduled tx advances the signer's nonce — calls and create2
    // proxy txs included; only plain creates yield a nonce-derived address.
    if (
      step.kind === 'deploy' &&
      (!step.strategy?.kind || step.strategy.kind === 'create')
    ) {
      addresses.set(
        step.id,
        getContractAddress({ from, nonce: BigInt(nonce) })
      );
    }
    next.set(key, nonce + 1);
  }
  return addresses;
}

export function buildSchedule(
  plan: DeploymentPlan,
  frozen: FrozenInputs,
  chainId: number,
  opts: {
    signers: Map<string, Hex>;
    createAddresses?: Map<string, Hex>;
    confirmedExisting?: Set<string>;
    predictions?: Predictions;
  }
): ScheduleEntry[] {
  const predictions =
    opts.predictions ?? predictPlanAddresses(plan, frozen, chainId);
  const creates = opts.createAddresses ?? new Map<string, Hex>();
  const addresses = (id: string) =>
    predictions[id]?.predictedAddress ??
    creates.get(id) ??
    (() => {
      throw new Error(`No resolved address for ${id}`);
    })();
  return plan.steps.map((step) => {
    const from = opts.signers.get(step.id);
    if (step.kind === 'call') {
      const fn = callAbiItem(
        step,
        chainId,
        callTargetAbi(plan, step, chainId, frozen)
      );
      const values = resolveStepValues(
        step,
        chainId,
        addresses,
        fn?.inputs ?? [],
        { frozen, contracts: plan.contracts }
      );
      const data = fn
        ? encodeFunctionData({
            abi: [fn],
            functionName: fn.name,
            args: toConstructorArgs(fn.inputs, values.args, 'call'),
          })
        : '0x';
      return {
        stepId: step.id,
        kind: 'tx',
        from,
        to: values.target!,
        data,
        value: effectiveValue(step, chainId),
      };
    }
    const strategy = step.strategy ?? { kind: 'create' as const };
    const data = isFactoryStrategy(strategy)
      ? ('0x' as Hex)
      : buildInitcode(step, frozen[step.contractId]!, chainId, addresses, {
          frozen,
          contracts: plan.contracts,
        });
    // 'existing' requires OBSERVED code, not just a fresh acknowledgment —
    // the caller (simulation) verifies via eth_getCode; execution deploys
    // when code is absent, so the schedule must include that tx (F7). When
    // no confirmation set is provided, fall back to acknowledgment freshness
    // (pure callers that cannot read the chain).
    const existing = opts.confirmedExisting
      ? opts.confirmedExisting.has(step.id)
      : strategy.kind !== 'create' &&
        ackIsFresh(strategy, chainId, predictions[step.id]!);
    if (strategy.kind !== 'create' && existing)
      return {
        stepId: step.id,
        kind: 'existing',
        address: predictions[step.id]!.predictedAddress,
        predictedAddress: predictions[step.id]!.predictedAddress,
      };
    if (isFactoryStrategy(strategy)) {
      // A product whose deployment is performed by another step's call sends
      // nothing itself; it only carries the address that call will create.
      if (strategy.fulfilledBy) {
        const predicted = predictions[step.id]?.predictedAddress;
        return {
          stepId: step.id,
          kind: 'existing',
          ...(predicted
            ? { address: predicted, predictedAddress: predicted }
            : {}),
        };
      }
      const factoryData = buildFactoryCalldata(
        step as never,
        chainId,
        addresses,
        { frozen, contracts: plan.contracts }
      );
      return {
        stepId: step.id,
        kind: 'tx',
        from,
        to: resolveFactoryAddress(strategy, chainId, addresses),
        data: factoryData,
        value: effectiveValue(step, chainId),
        ...(predictions[step.id]
          ? { predictedAddress: predictions[step.id].predictedAddress }
          : {}),
      };
    }
    return strategy.kind === 'create'
      ? {
          stepId: step.id,
          kind: 'tx',
          from,
          to: null,
          data,
          value: effectiveValue(step, chainId),
          address: creates.get(step.id),
        }
      : {
          stepId: step.id,
          kind: 'tx',
          from,
          to: CREATE2_PROXY_ADDRESS,
          data: create2Calldata(predictions[step.id]!.salt, data),
          value: effectiveValue(step, chainId),
          predictedAddress: predictions[step.id]!.predictedAddress,
        };
  });
}
