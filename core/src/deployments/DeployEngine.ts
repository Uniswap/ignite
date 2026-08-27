import crypto from 'node:crypto';
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, parseAbiItem, parseTransaction, toFunctionSignature, type Abi, type AbiFunction, type AbiParameter, type Hex } from 'viem';
import type {
  DeploymentPlan,
  Lane,
  PauseReason,
  ResolveLaneRequest,
  RpcSelection,
  RunEvent,
  RunRecord,
  WorkflowDocument,
  WorkflowRunBinding,
} from '@ignite/api';
import { allowedActions, CREATE2_PROXY_ADDRESS } from '@ignite/api';
import { RpcProviderService } from '../chains/RpcProviderService.js';
import { RpcStore } from '../chains/RpcStore.js';
import { ChainRegistry } from '../chains/ChainRegistry.js';
import { verifyRpcEndpoint } from '../chains/rpcVerify.js';
import {
  SignerProviderService,
  type ExecuteTxArgs,
} from '../signers/SignerProviderService.js';
import type { ChainMetadata } from '@ignite/plugin-types/types';
import type { TxOverrides } from '../tx/TxService.js';
import { ErrorCodes, IgniteError } from '../types/errors.js';
import { writeArtifact } from './artifact.js';
import { sanitizeRunError } from './errors.js';
import { RunEvents, type RunListener } from './events.js';
import {
  callAbiItem,
  callTargetAbi,
  collectRefs,
  effectiveValue,
  mergeGas,
  resolveSigner,
  resolveStepValues,
  toConstructorArgs,
  validateDependencies,
  dynamicDeterministicStepIds,
} from './resolver.js';
import { ackIsFresh, buildInitcode, buildRuntimeCode, predictPlanAddresses } from './schedule.js';
import { create2Calldata, effectiveSalt, initcodeHashOf, predictCreate2Address } from './create2.js';
import { decodeProducedAddresses, encodeDeclaredProductArgs, isInitcodeStrategy, isProducedStrategy, producedRole, productsOfProducer } from './produced.js';
import { decomposeCreationCalldata } from './create2.js';
import { linkBytecode } from './linking.js';
import { RunStore } from './RunStore.js';
import { runStatus } from './runStatus.js';
import { validatePlan } from './validation.js';
import { VerificationQueue } from '../verifications/VerificationQueue.js';
import { getLogger } from '../utils/logger.js';
import { DeploymentHookService } from './DeploymentHookService.js';
import { DeploymentTypeService } from './DeploymentTypeService.js';
import { contractTypeStaticItems, validateWrapsIntegrity } from './contractTypeValidation.js';

type ResolvedRpc = { url: string; fingerprint: string; label?: string };
type ExecuteResult = {
  txHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: number;
  contractAddress: Hex | null;
  gasUsed: string;
  effectiveGasPrice: string;
  nonce?: number;
};
type Receipt = Omit<ExecuteResult, 'txHash'>;
type WrapperCapture = { captured: Record<string, Hex>; note?: string };
const RECEIPT_RECHECK_ATTEMPTS = 60;
const RECEIPT_RECHECK_INTERVAL_MS = 500;
// A receipt does not prove the executing node can see the resulting state:
// load-balanced endpoints answer consecutive calls from providers at
// different heads, and some chains serve receipts from preconfirmations
// before the block seals. Deterministic deploys probe for the created code
// over this budget before concluding the deployment produced none.
const CREATED_CODE_PROBE_ATTEMPTS = 20;
const CREATED_CODE_PROBE_INTERVAL_MS = 500;

export interface DeployEngineDeps {
  runStore: Pick<
    RunStore,
    | 'create'
    | 'get'
    | 'list'
    | 'mutate'
    | 'findByIdempotencyKey'
    | 'recoverStartup'
  >;
  executeTx: (
    args: ExecuteTxArgs & {
      onPhase?: ExecuteTxArgs extends never
        ? never
        : (
            phase: 'built' | 'signed' | 'broadcasting',
            data: { tx: { nonce: number }; rawTx?: Hex; txHash?: Hex }
          ) => Promise<void>;
    },
    ctx: { log: (line: string) => void; signal: AbortSignal }
  ) => Promise<ExecuteResult>;
  resolveRpcUrl: (
    chainId: number,
    endpointId: string
  ) => Promise<ResolvedRpc | undefined>;
  verifyRpc: typeof verifyRpcEndpoint;
  resolveAccount: SignerProviderService['resolveAccount'];
  validate: (
    plan: DeploymentPlan,
    rpc: RpcSelection,
    deps?: { profileId?: string; explorerSelection?: Record<string, string[]>; workflow?: { document: WorkflowDocument; binding: WorkflowRunBinding } }
  ) => ReturnType<typeof validatePlan>;
  writeArtifact: (run: RunRecord) => Promise<unknown>;
  getReceipt: (url: string, hash: Hex) => Promise<Receipt | undefined>;
  getTxForProvenance: (
    url: string,
    hash: Hex
  ) => Promise<{ from: Hex; to: Hex | null; input: Hex; value: bigint } | undefined>;
  getCode: (url: string, address: Hex) => Promise<Hex>;
  getStorageAt: (url: string, address: Hex, slot: Hex) => Promise<Hex>;
  // `from`/`value` matter when the call simulates the very transaction about
  // to be sent: factories that scope product addresses to msg.sender (salt
  // schemes) or take payment derive different results for a different sender.
  call: (url: string, args: { to: Hex; data: Hex; from?: Hex; value?: bigint }) => Promise<Hex>;
  getTransactionData: (url: string, hash: Hex) => Promise<Hex | undefined>;
  verificationQueue: Pick<VerificationQueue, 'enqueueForConfirmedStep' | 'enqueueContractTypeCapture'>;
  rebroadcast: (url: string, raw: Hex) => Promise<Hex>;
  chainMetadata: (chainId: number) => Promise<ChainMetadata>;
  deploymentHooks: Pick<DeploymentHookService, 'dispatch' | 'reconcileStartup'>;
  deploymentTypes: Pick<DeploymentTypeService, 'prepare' | 'validate' | 'list' | 'launchBinding'>;
  now: () => number;
  createdCodeProbe: { attempts: number; intervalMs: number };
}

interface ActiveLane {
  controller: AbortController;
  promise: Promise<void>;
  wake?: () => void;
}

export class DeployEngine {
  private static instance: DeployEngine | undefined;
  private readonly deps: DeployEngineDeps;
  private readonly events = new RunEvents();
  private readonly active = new Map<string, ActiveLane>();
  private readonly commands = new Map<string, Promise<unknown>>();
  private readonly resolvedCommands = new Map<string, RunRecord>();
  private readonly launches = new Map<string, Promise<unknown>>();
  private stopped = false;

  constructor(deps?: Partial<DeployEngineDeps>) {
    const signers = SignerProviderService.getInstance();
    this.deps = {
      runStore: deps?.runStore ?? new RunStore(),
      executeTx:
        deps?.executeTx ??
        ((args, ctx) =>
          signers.executeTx(
            args as ExecuteTxArgs,
            ctx
          ) as Promise<ExecuteResult>),
      resolveRpcUrl: deps?.resolveRpcUrl ?? defaultResolveRpcUrl,
      verifyRpc: deps?.verifyRpc ?? verifyRpcEndpoint,
      resolveAccount:
        deps?.resolveAccount ?? signers.resolveAccount.bind(signers),
      validate:
        deps?.validate ?? ((plan, rpc, opts) => validatePlan(plan, rpc, opts)),
      writeArtifact: deps?.writeArtifact ?? writeArtifact,
      getReceipt:
        deps?.getReceipt ??
        (async (url, hash) => {
          const result = await import('viem').then(
            ({ createPublicClient, http }) =>
              createPublicClient({
                transport: http(url),
              }).getTransactionReceipt({ hash })
          );
          return {
            status: result.status,
            blockNumber: Number(result.blockNumber),
            contractAddress: result.contractAddress ?? null,
            gasUsed: result.gasUsed.toString(),
            effectiveGasPrice: result.effectiveGasPrice.toString(),
          };
        }),
      getTxForProvenance:
        deps?.getTxForProvenance ??
        (async (url, hash) => {
          const { createPublicClient, http } = await import('viem');
          const tx = await createPublicClient({ transport: http(url) })
            .getTransaction({ hash })
            .catch(() => undefined);
          return tx ? { from: tx.from, to: tx.to ?? null, input: tx.input as Hex, value: tx.value } : undefined;
        }),
      getCode: deps?.getCode ?? (async (url, address) => {
        const { createPublicClient, http } = await import('viem');
        return (await createPublicClient({ transport: http(url) }).getCode({ address })) ?? '0x';
      }),
      getStorageAt: deps?.getStorageAt ?? (async (url, address, slot) => {
        const { createPublicClient, http } = await import('viem');
        return await createPublicClient({ transport: http(url) }).getStorageAt({ address, slot }) ?? '0x';
      }),
      call: deps?.call ?? (async (url, args) => {
        const { createPublicClient, http } = await import('viem');
        return await createPublicClient({ transport: http(url) }).call({ to: args.to, data: args.data, ...(args.from ? { account: args.from } : {}), ...(args.value !== undefined ? { value: args.value } : {}) }).then((result) => result.data ?? '0x');
      }),
      getTransactionData: deps?.getTransactionData ??
        (async (url, hash) => {
          const { createPublicClient, http } = await import('viem');
          const tx = await createPublicClient({ transport: http(url) }).getTransaction({ hash });
          return tx.input as Hex;
        }),
      verificationQueue: deps?.verificationQueue ?? VerificationQueue.getInstance(),
      rebroadcast:
        deps?.rebroadcast ??
        (async (url, raw) =>
          (await import('viem'))
            .createPublicClient({ transport: (await import('viem')).http(url) })
            .sendRawTransaction({ serializedTransaction: raw })),
      chainMetadata: deps?.chainMetadata ?? defaultChainMetadata,
      deploymentHooks: deps?.deploymentHooks ?? DeploymentHookService.getInstance(),
      deploymentTypes: deps?.deploymentTypes ?? DeploymentTypeService.getInstance(),
      now: deps?.now ?? Date.now,
      createdCodeProbe: deps?.createdCodeProbe ?? {
        attempts: CREATED_CODE_PROBE_ATTEMPTS,
        intervalMs: CREATED_CODE_PROBE_INTERVAL_MS,
      },
    };
  }

  static getInstance(): DeployEngine {
    return (this.instance ??= new DeployEngine());
  }
  static resetInstance(): void {
    this.instance = undefined;
  }

  async launch(args: {
    profileId: string;
    plan: DeploymentPlan;
    rpcSelection: RpcSelection;
    explorerSelection?: Record<string, string[]>;
    name?: string;
    idempotencyKey: string;
    workflow?: WorkflowRunBinding;
    workflowDocument?: WorkflowDocument;
  }): Promise<RunRecord> {
    return this.queued(this.launches, args.profileId, async () => {
      const existing = await this.deps.runStore.findByIdempotencyKey(
        args.profileId,
        args.idempotencyKey
      );
      if (existing) return existing;
      const validated = await this.deps.validate(args.plan, args.rpcSelection, {
        profileId: args.profileId,
        explorerSelection: args.explorerSelection,
        ...(args.workflow && args.workflowDocument ? { workflow: { binding: args.workflow, document: args.workflowDocument } } : {}),
      });
      if (
        Object.values(validated.report.chains).some((checklist) =>
          Object.values(checklist).some((item) => item.blocking && !item.ok)
        ) || Object.values(validated.report.run ?? {}).some((item) => item?.blocking && !item.ok)
      ) {
        throw new IgniteError(
          'Deployment validation contains blocking failures',
          ErrorCodes.DEPLOYMENT_VALIDATION_FAILED
        );
      }
      // Freeze the reviewed identity of every deployment-type plugin the plan
      // uses. launchBinding re-describes the provider and rejects a descriptor
      // that changed since authoring; the mode must match the materialized
      // strategy shape. Once the run exists no plugin code executes in the
      // transaction lifecycle, so a call-products plugin need not stay
      // available after this point.
      const pluginIds = [...new Set(args.plan.steps.flatMap((step) =>
        step.kind === 'deploy' && step.strategy?.kind === 'plugin' ? [step.strategy.pluginId] : []
      ))];
      const deploymentTypeBindings: Record<string, import('@ignite/api').DeploymentTypeBinding> = {};
      for (const pluginId of pluginIds)
        deploymentTypeBindings[pluginId] = await this.deps.deploymentTypes.launchBinding(pluginId);
      for (const step of args.plan.steps) {
        if (step.kind !== 'deploy' || step.strategy?.kind !== 'plugin') continue;
        const expected = isProducedStrategy(step.strategy) ? 'call-products' : 'create2';
        if (deploymentTypeBindings[step.strategy.pluginId]!.execution !== expected)
          throw new IgniteError(
            `Deployment type ${step.strategy.pluginId} does not support ${expected} execution`,
            ErrorCodes.DEPLOYMENT_VALIDATION_FAILED
          );
      }
      const now = new Date(this.deps.now()).toISOString();
      const run: RunRecord = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        profileId: args.profileId,
        name: args.name ?? 'Deployment run',
        idempotencyKey: args.idempotencyKey,
        createdAt: now,
        updatedAt: now,
        plan: globalThis.structuredClone(args.plan),
        inputs: validated.frozen,
        ...(Object.keys(validated.contractTypes ?? {}).length ? { contractTypes: globalThis.structuredClone(validated.contractTypes) } : {}),
        ...(Object.keys(deploymentTypeBindings).length ? { deploymentTypeBindings } : {}),
        rpcSelection: validated.rpcBindings,
        ...(Object.keys(validated.explorerTargets ?? {}).length
          ? { explorerTargets: validated.explorerTargets }
          : {}),
        validation: validated.report,
        ...(args.workflow ? { workflow: globalThis.structuredClone(args.workflow) } : {}),
        ...(Object.keys(validated.report.chains).length
          ? { simulationTiers: Object.fromEntries(Object.entries(validated.report.chains).flatMap(([key, checklist]) => {
              const tier = (checklist.simulation?.details as { tier?: 'simulateV1' | 'fork' | 'estimate' } | undefined)?.tier;
              return tier ? [[key, tier]] : [];
            })) }
          : {}),
        status: 'running',
        lanes: Object.fromEntries(
          args.plan.chains.map((chainId) => [
            String(chainId),
            makeLane(chainId, args.plan, validated.predicted?.[String(chainId)]),
          ])
        ),
      };
      await this.deps.runStore.create(run);
      for (const lane of Object.values(run.lanes))
        this.startLane(run.profileId, run.id, lane.chainId);
      return run;
    });
  }

  async resolveLane(
    profileId: string,
    runId: string,
    chainId: number,
    cmd: ResolveLaneRequest
  ): Promise<RunRecord> {
    return this.queued(this.commands, `${profileId}:${runId}`, async () => {
      const replayKey = `${profileId}:${runId}:${chainId}:${cmd.commandId}`;
      // Exact replays are idempotent but must reflect CURRENT state — the
      // cached record is only a consumed-command marker, not the response.
      if (this.resolvedCommands.has(replayKey))
        return this.requireRun(profileId, runId);
      const run = await this.requireRun(profileId, runId);
      const lane = run.lanes[String(chainId)];
      if (!lane)
        throw new IgniteError(
          'Deployment lane not found',
          ErrorCodes.DEPLOYMENT_RUN_NOT_FOUND
        );
      const attempt = lane.steps
        .flatMap((step) => step.attempts)
        .find((entry) => entry.id === cmd.attemptId);
      if (!lane.pause || lane.pause.attemptId !== cmd.attemptId)
        throw new IgniteError(
          'This pause has already been resolved',
          ErrorCodes.STALE_RESOLVE
        );
      const signer = resolveSigner(
        run.plan,
        run.plan.steps[lane.pause.stepIndex],
        chainId
      );
      const resolved = signer
        ? await this.deps.resolveAccount(signer.pluginId, signer.accountId, {
            refresh: true,
          })
        : undefined;
      const capability =
        resolved?.account.capability ??
        (attempt?.rawTx ? 'sign-only' : 'sign-and-send');
      const submitted = Boolean(attempt?.txHash || attempt?.rawTx);
      const pausedRole = run.plan.steps[lane.pause.stepIndex]
        ? producedRole(run.plan, run.plan.steps[lane.pause.stepIndex]!.id)
        : undefined;
      if (
        !allowedActions({
          reason: lane.pause.reason,
          capability,
          submitted,
          hasIntent: Boolean(attempt?.expected),
          ...(pausedRole ? { producedRole: pausedRole } : {}),
        }).includes(cmd.action)
      )
        throw new IgniteError(
          'This resolution is not allowed for the current pause',
          ErrorCodes.ILLEGAL_RESOLVE
        );
      if (
        (cmd.action === 'keep-waiting' ||
          (cmd.action === 'recheck' && lane.pause.reason !== 'produced-code-missing')) &&
        !attempt?.txHash
      )
        throw new IgniteError(
          'A transaction hash is required to continue receipt checks',
          ErrorCodes.ILLEGAL_RESOLVE
        );
      if (cmd.action === 'keep-waiting') {
        const txHash = attempt?.txHash;
        if (!attempt || !txHash)
          throw new IgniteError(
            'A transaction hash is required to continue receipt checks',
            ErrorCodes.ILLEGAL_RESOLVE
          );
        const stepIndex = lane.pause.stepIndex;
        const waiting = await this.mutate(
          profileId,
          runId,
          (current) => {
            const target = current.lanes[String(chainId)];
            const step = target.steps[target.pause!.stepIndex];
            target.pause = undefined;
            target.status = 'running';
            step.status = 'confirming';
          },
          chainId
        );
        this.startReceiptWait(
          profileId,
          runId,
          chainId,
          txHash,
          attempt.id,
          stepIndex
        );
        this.resolvedCommands.set(replayKey, waiting);
        return waiting;
      }
      if (cmd.action === 'accept-deployed') {
        const pausedStep = run.plan.steps[lane.pause.stepIndex];
        const predicted = lane.steps[lane.pause.stepIndex].predictedAddress;
        if (pausedStep?.kind !== 'deploy' || !predicted)
          throw new IgniteError('Only a deterministic deployment can be accepted', ErrorCodes.ILLEGAL_RESOLVE);
        const code = await this.deps.getCode((await this.rpcFor(run, chainId)).url, predicted);
        if (!code || code === '0x') {
          await this.mutate(profileId, runId, (current) => {
            const target = current.lanes[String(chainId)];
            target.pause = undefined; target.status = 'running';
            target.steps[target.currentStepIndex].status = 'pending';
          }, chainId);
        } else {
          let capture: WrapperCapture | undefined;
          let captureError: unknown;
          try { capture = await this.captureWrapper(run, chainId, lane.pause.stepIndex, predicted); }
          catch (error) { captureError = error; }
          await this.mutate(profileId, runId, (current) => {
            const target = current.lanes[String(chainId)];
            const planStep = current.plan.steps[target.currentStepIndex] as Extract<typeof pausedStep, { kind: 'deploy' }>;
            const targetStep = target.steps[target.currentStepIndex];
            const expected = targetStep.attempts.find((entry) => entry.id === cmd.attemptId);
            if (captureError) {
              targetStep.status = 'failed'; target.status = 'paused';
              target.pause = {
                reason: (captureError as { pauseReason?: PauseReason }).pauseReason === 'rpc' ? 'rpc' : 'needs-review',
                stepIndex: target.currentStepIndex,
                error: sanitizeRunError(captureError),
                attemptId: cmd.attemptId,
                ...((captureError as { details?: Record<string, unknown> }).details ? { details: (captureError as { details: Record<string, unknown> }).details } : {}),
              };
              return;
            }
            const strategy = planStep.strategy;
            if (!strategy || strategy.kind === 'create') throw new IgniteError('Only deterministic deployment can be accepted', ErrorCodes.ILLEGAL_RESOLVE);
            const dynamic = dynamicDeterministicStepIds(current.plan, chainId).has(planStep.id);
            const salt = dynamic ? targetStep.salt : isInitcodeStrategy(strategy) ? strategy.saltPerChain?.[String(chainId)] ?? strategy.salt : undefined;
            if (!salt) throw new IgniteError('Deterministic deployment has no salt', ErrorCodes.ILLEGAL_RESOLVE);
            const initcodeHash = initcodeHashOf(buildInitcode(planStep, current.inputs[planStep.contractId]!, chainId, (id) => {
              const ref = target.steps.find((item) => item.stepId === id);
              if (!ref?.address && !ref?.predictedAddress) throw new Error('unresolved');
              return (ref.address ?? ref.predictedAddress)!;
            }, { frozen: current.inputs, contracts: current.plan.contracts }));
            planStep.strategy = {
              ...strategy,
              acknowledgeDeployed: {
                ...(strategy.acknowledgeDeployed ?? {}),
                [String(chainId)]: { predictedAddress: predicted, initcodeHash },
              },
            };
            if (expected) { expected.resolution = 'accept-deployed'; expected.endedAt = iso(this.deps.now()); }
            targetStep.status = 'skipped'; targetStep.address = predicted;
            if (capture && Object.keys(capture.captured).length) targetStep.captured = capture.captured;
            if (capture?.note) appendLaneStepNote(targetStep, capture.note);
            target.currentStepIndex += 1; target.pause = undefined;
            target.status = target.currentStepIndex >= target.steps.length ? 'completed' : 'running';
          }, chainId);
        }
        const result = await this.requireRun(profileId, runId);
        if (result.lanes[String(chainId)].status === 'running') this.startLane(profileId, runId, chainId);
        this.resolvedCommands.set(replayKey, result);
        return result;
      }
      if (cmd.action === 'record-deployed-address') {
        const pausedStep = run.plan.steps[lane.pause.stepIndex];
        const pausedLaneStep = lane.steps[lane.pause.stepIndex];
        // Only the matching produced product may be reconciled; the producer's
        // transaction attempt and receipt are never rewritten.
        if (pausedStep?.kind !== 'deploy' || !isProducedStrategy(pausedStep.strategy) || !pausedLaneStep?.expectedAddress)
          throw new IgniteError('Only a produced product with an expected address can record a deployed address', ErrorCodes.ILLEGAL_RESOLVE);
        const code = await this.deps.getCode((await this.rpcFor(run, chainId)).url, cmd.address);
        // Fails without mutation: an invalid manual address leaves the lane
        // paused and every persisted product/transaction fact unchanged.
        if (!code || code === '0x')
          throw new IgniteError('No contract code exists at the supplied address', ErrorCodes.ILLEGAL_RESOLVE);
        const recordedAt = iso(this.deps.now());
        await this.mutate(profileId, runId, (current) => {
          const target = current.lanes[String(chainId)];
          const targetStep = target.steps[target.pause!.stepIndex];
          const expected = targetStep.expectedAddress;
          if (!expected) throw new IgniteError('Produced product lost its expected address', ErrorCodes.ILLEGAL_RESOLVE);
          const currentAttempt = targetStep.attempts.find((entry) => entry.id === cmd.attemptId);
          if (currentAttempt) {
            currentAttempt.resolution = 'record-deployed-address';
            currentAttempt.endedAt = recordedAt;
            currentAttempt.resolutionData = { recordedAddress: cmd.address, ...(cmd.note ? { note: cmd.note } : {}) };
          }
          targetStep.status = 'confirmed';
          targetStep.address = cmd.address;
          // Operator attestation, never relabelled as a prediction: mutable
          // factory state can make the expected address stale, and the chain
          // cannot prove which call created the code at the recorded one.
          targetStep.addressProvenance = { kind: 'operator-recorded', expectedAddress: expected, recordedAddress: cmd.address, recordedAt, ...(cmd.note ? { note: cmd.note } : {}) };
          target.pause = undefined;
          target.currentStepIndex += 1;
          target.status = target.currentStepIndex >= target.steps.length ? 'completed' : 'running';
        }, chainId);
        const result = await this.requireRun(profileId, runId);
        // Product verification still attributes the producer's transaction
        // hash even though the final address was manually reconciled.
        void this.enqueueProducedProductVerification(result, chainId, pausedStep.id).catch((error) =>
          getLogger().warn(`verification enqueue skipped for produced product ${pausedStep.id}: ${error instanceof Error ? error.message : String(error)}`)
        );
        if (result.lanes[String(chainId)].status === 'running') this.startLane(profileId, runId, chainId);
        this.resolvedCommands.set(replayKey, result);
        return result;
      }
      if (cmd.action === 'recheck') {
        if (lane.pause.reason === 'produced-code-missing') {
          // Read-only by contract: recheck after a successful producer receipt
          // never rebroadcasts the producer transaction.
          const pausedStep = run.plan.steps[lane.pause.stepIndex];
          const expected = lane.steps[lane.pause.stepIndex]?.expectedAddress;
          const code = expected
            ? await this.deps.getCode((await this.rpcFor(run, chainId)).url, expected)
            : undefined;
          if (expected && code && code !== '0x') {
            const observedAt = iso(this.deps.now());
            const settled = await this.mutate(profileId, runId, (current) => {
              const target = current.lanes[String(chainId)];
              const targetStep = target.steps[target.pause!.stepIndex];
              targetStep.status = 'confirmed';
              targetStep.address = expected;
              targetStep.addressProvenance = { kind: 'observed-at-expected', expectedAddress: expected, observedAt };
              target.pause = undefined;
              target.currentStepIndex += 1;
              target.status = target.currentStepIndex >= target.steps.length ? 'completed' : 'running';
            }, chainId);
            if (pausedStep)
              void this.enqueueProducedProductVerification(settled, chainId, pausedStep.id).catch((error) =>
                getLogger().warn(`verification enqueue skipped for produced product ${pausedStep.id}: ${error instanceof Error ? error.message : String(error)}`)
              );
          }
          const result = await this.requireRun(profileId, runId);
          this.resolvedCommands.set(replayKey, result);
          if (result.lanes[String(chainId)].status === 'running') this.startLane(profileId, runId, chainId);
          return result;
        }
        if (lane.pause.reason === 'created-code-missing') {
          const predicted = lane.steps[lane.pause.stepIndex].predictedAddress;
          const code = predicted
            ? await this.deps.getCode((await this.rpcFor(run, chainId)).url, predicted)
            : undefined;
          if (predicted && code && code !== '0x') {
            const confirmedHash = attempt?.txHash;
            let capture: WrapperCapture | undefined;
            let captureError: unknown;
            try { capture = await this.captureWrapper(run, chainId, lane.pause.stepIndex, predicted); }
            catch (error) { captureError = error; }
            const settled = await this.mutate(profileId, runId, (current) => {
              const target = current.lanes[String(chainId)]; const targetStep = target.steps[target.currentStepIndex];
              if (captureError) {
                targetStep.status = 'failed'; target.status = 'paused';
                target.pause = {
                  reason: (captureError as { pauseReason?: PauseReason }).pauseReason === 'rpc' ? 'rpc' : 'needs-review',
                  stepIndex: target.currentStepIndex,
                  error: sanitizeRunError(captureError),
                  attemptId: targetStep.attempts.at(-1)?.id ?? lane.pause!.attemptId,
                  ...((captureError as { details?: Record<string, unknown> }).details ? { details: (captureError as { details: Record<string, unknown> }).details } : {}),
                };
                return;
              }
              targetStep.status = 'confirmed'; targetStep.address = predicted; target.currentStepIndex += 1;
              if (capture && Object.keys(capture.captured).length) targetStep.captured = capture.captured;
              if (capture?.note) appendLaneStepNote(targetStep, capture.note);
              target.pause = undefined; target.status = target.currentStepIndex >= target.steps.length ? 'completed' : 'running';
            }, chainId);
            // Late confirmation follows the same post-confirmation path as
            // confirmReceipt — without this the step never verifies (F9).
            if (confirmedHash && !captureError)
              void this.enqueueConfirmedVerification(settled, chainId, confirmedHash).catch((error) =>
                getLogger().warn(`verification enqueue skipped for ${confirmedHash}: ${error instanceof Error ? error.message : String(error)}`)
              );
          }
          const result = await this.requireRun(profileId, runId);
          this.resolvedCommands.set(replayKey, result);
          if (result.lanes[String(chainId)].status === 'running') this.startLane(profileId, runId, chainId);
          return result;
        }
        if (attempt?.txHash)
          await this.reconcile(profileId, runId, chainId, attempt.txHash);
        const result = await this.requireRun(profileId, runId);
        this.resolvedCommands.set(replayKey, result);
        // A recheck that confirmed the receipt leaves the lane 'running' in
        // the record; without restarting the driver here (as every sibling
        // verb does) nothing executes the remaining steps.
        if (result.lanes[String(chainId)].status === 'running') this.startLane(profileId, runId, chainId);
        return result;
      }
      if (cmd.action === 'confirm-hash') {
        // A hash is accepted only when it matches the durable intent written
        // at the provider's `built` phase.  This protects calls and CREATE2
        // proxy transactions as well as ordinary contract creations.
        if (!attempt?.expected)
          throw new IgniteError('No durable transaction intent is available for this attempt', ErrorCodes.ILLEGAL_RESOLVE);
        const step = run.plan.steps[lane.pause.stepIndex];
        const planSigner = step && resolveSigner(run.plan, step, chainId);
        const origin = await this.deps.getTxForProvenance(
          (await this.rpcFor(run, chainId)).url,
          cmd.txHash
        );
        if (!origin)
          throw coded(
            'receipt-timeout',
            'The supplied transaction hash is not known to the RPC yet'
          );
        if (
          !planSigner ||
          origin.from.toLowerCase() !== planSigner.address.toLowerCase() ||
          origin.to?.toLowerCase() !== attempt.expected.to?.toLowerCase() ||
          keccak256(origin.input) !== attempt.expected.dataHash ||
          origin.value.toString() !== attempt.expected.value
        )
          throw new IgniteError(
            'The supplied hash does not match the durable transaction intent',
            ErrorCodes.ILLEGAL_RESOLVE
          );
        const receipt = await this.safeReceipt((await this.rpcFor(run, chainId)).url, cmd.txHash);
        if (!receipt || receipt.status !== 'success')
          throw new IgniteError('The supplied transaction has not succeeded', ErrorCodes.ILLEGAL_RESOLVE);
        await this.reconcile(profileId, runId, chainId, cmd.txHash);
        const result = await this.requireRun(profileId, runId);
        this.resolvedCommands.set(replayKey, result);
        // Confirming mid-plan leaves the lane 'running' in the record; without
        // restarting the driver here (as every sibling verb does) nothing
        // executes the remaining steps — a produced product whose expected
        // address was already committed would never be reached.
        if (result.lanes[String(chainId)].status === 'running') this.startLane(profileId, runId, chainId);
        return result;
      }
      let editedRpcBinding:
        | { endpointId: string; label: string; urlFingerprint: string }
        | undefined;
      if (cmd.action === 'edit' && cmd.edits.rpcEndpointId) {
        const editedRpc = await this.deps.resolveRpcUrl(
          chainId,
          cmd.edits.rpcEndpointId
        );
        if (!editedRpc) {
          throw coded('rpc', 'The edited RPC endpoint is unavailable');
        }
        const verification = await this.deps.verifyRpc(editedRpc.url, chainId);
        if (!verification.ok || verification.chainIdMatch === false) {
          throw coded(
            'rpc',
            verification.error ?? 'The edited RPC endpoint failed verification'
          );
        }
        editedRpcBinding = {
          endpointId: cmd.edits.rpcEndpointId,
          label: editedRpc.label ?? cmd.edits.rpcEndpointId,
          urlFingerprint: editedRpc.fingerprint,
        };
      }
      const editedPredictions = cmd.action === 'edit'
        ? this.validateEdits(run, lane, cmd)
        : undefined;
      await this.mutate(
        profileId,
        runId,
        (current) => {
          const currentLane = current.lanes[String(chainId)];
          const step = currentLane.steps[currentLane.pause!.stepIndex];
          const currentAttempt = step.attempts.find(
            (entry) => entry.id === cmd.attemptId
          )!;
          const beforeDynamic = cmd.action === 'edit'
            ? dynamicDeterministicStepIds(current.plan, currentLane.chainId)
            : undefined;
          if (cmd.action === 'edit')
            this.applyEdits(
              current,
              currentLane,
              cmd,
              currentAttempt,
              editedRpcBinding
            );
          if (cmd.action === 'edit' && editedPredictions) {
            const edited = new Set([current.plan.steps[currentLane.currentStepIndex]!.id, ...Object.keys(cmd.edits.argsByStep ?? {}), ...Object.keys(cmd.edits.librariesByStep ?? {})]);
            const affected = dependentPlanStepIds(current.plan, currentLane.chainId, edited);
            const afterDynamic = dynamicDeterministicStepIds(current.plan, currentLane.chainId);
            for (let index = currentLane.currentStepIndex; index < currentLane.steps.length; index += 1) {
              const laneStep = currentLane.steps[index]; const id = laneStep.stepId;
              if (afterDynamic.has(id) && (affected.has(id) || !beforeDynamic!.has(id))) {
                delete laneStep.predictedAddress; delete laneStep.salt; delete laneStep.notes;
              } else if (!afterDynamic.has(id)) {
                if (beforeDynamic!.has(id)) { delete laneStep.salt; delete laneStep.notes; }
                const prediction = editedPredictions[id];
                if (prediction) laneStep.predictedAddress = prediction.predictedAddress;
              }
            }
            // Prune acknowledgments whose provenance no longer matches the
            // refreshed predictions (review F18) — execution re-checks too,
            // but a stale entry must not present as valid.
            const chainKey = String(currentLane.chainId);
            for (const planStep of current.plan.steps) {
              if (planStep.kind !== 'deploy' || !planStep.strategy || planStep.strategy.kind === 'create') continue;
              const ack = planStep.strategy.acknowledgeDeployed?.[chainKey];
              const prediction = editedPredictions[planStep.id];
              if (ack && prediction && (ack.predictedAddress.toLowerCase() !== prediction.predictedAddress.toLowerCase() || ack.initcodeHash.toLowerCase() !== prediction.initcodeHash.toLowerCase())) {
                delete planStep.strategy.acknowledgeDeployed![chainKey];
              }
            }
          }
          if (cmd.action === 'replace') {
            const key = String(currentLane.chainId);
            const planStep = current.plan.steps[currentLane.currentStepIndex];
            planStep.gasOverridesPerChain = {
              ...(planStep.gasOverridesPerChain ?? {}),
              [key]: {
                ...(planStep.gasOverridesPerChain?.[key] ?? {}),
                ...cmd.gas,
              },
            };
            currentAttempt.edits = { gas: cmd.gas };
          }
          if (cmd.action === 'skip' || cmd.action === 'abort-lane') {
            currentAttempt.resolution = cmd.action;
            currentAttempt.endedAt = iso(this.deps.now());
            if (currentAttempt.txHash || currentAttempt.rawTx)
              step.unresolvedTx = {
                txHash: currentAttempt.txHash,
                note:
                  cmd.action === 'skip'
                    ? (cmd.note ?? 'Skipped while transaction may be in flight')
                    : 'Lane aborted while transaction may be in flight',
              };
            step.status = cmd.action === 'skip' ? 'skipped' : step.status;
            currentLane.status = cmd.action === 'skip' ? 'running' : 'aborted';
            currentLane.abortRequested =
              cmd.action === 'abort-lane' || undefined;
            currentLane.currentStepIndex += cmd.action === 'skip' ? 1 : 0;
          } else if (cmd.action === 'mark-not-sent') {
            currentAttempt.resolution = 'mark-not-sent';
            currentAttempt.endedAt = iso(this.deps.now());
            step.status = 'pending';
          } else if (
            cmd.action === 'retry' ||
            cmd.action === 'edit' ||
            cmd.action === 'replace'
          ) {
            currentAttempt.resolution = cmd.action;
            currentAttempt.endedAt = iso(this.deps.now());
            step.status = 'pending';
          }
          currentLane.pause = undefined;
          if (currentLane.status !== 'aborted') currentLane.status = 'running';
        },
        chainId
      );
      if (cmd.action !== 'abort-lane')
        this.startLane(profileId, runId, chainId);
      const result = await this.requireRun(profileId, runId);
      this.resolvedCommands.set(replayKey, result);
      return result;
    });
  }

  async resume(profileId: string, runId: string): Promise<RunRecord> {
    return this.queued(this.commands, `${profileId}:${runId}`, async () => {
      const run = await this.requireRun(profileId, runId);
      for (const lane of Object.values(run.lanes)) {
        if (
          lane.status !== 'paused' ||
          !['interrupted', 'needs-review', 'rpc'].includes(lane.pause?.reason ?? '')
        )
          continue;
        const attempt = lane.steps[lane.pause!.stepIndex]?.attempts.at(-1);
        if (lane.pause?.reason === 'rpc' && attempt?.txHash && !attempt.rawTx) {
          const receipt = await this.safeReceipt((await this.rpcFor(run, lane.chainId)).url, attempt.txHash);
          if (receipt) {
            await this.confirmReceipt(profileId, runId, lane.chainId, attempt.txHash, receipt);
            await this.startLaneIfRunning(profileId, runId, lane.chainId);
          }
          // A sign-and-send submission is already in-flight. Without raw
          // bytes it cannot be safely rebroadcast, and must never fall
          // through into a fresh deployment attempt.
          continue;
        }
        if (attempt?.rawTx && attempt.txHash) {
          const rpc = await this.rpcFor(run, lane.chainId);
          const receipt = await this.safeReceipt(rpc.url, attempt.txHash);
          if (receipt) {
            await this.confirmReceipt(
              profileId,
              runId,
              lane.chainId,
              attempt.txHash,
              receipt
            );
          } else {
            await this.deps.rebroadcast(rpc.url, attempt.rawTx);
            const afterBroadcast = await this.safeReceipt(
              rpc.url,
              attempt.txHash
            );
            if (afterBroadcast) {
              await this.confirmReceipt(
                profileId,
                runId,
                lane.chainId,
                attempt.txHash,
                afterBroadcast
              );
            } else {
              // The raw tx is back in the mempool but unmined. The lane MUST
              // stay paused on this attempt — falling through to clear the
              // pause and start a fresh attempt would deploy twice as soon as
              // the rebroadcast mines.
              await this.pause(
                profileId,
                runId,
                lane.chainId,
                lane.pause!.stepIndex,
                'receipt-timeout',
                new Error(
                  'Transaction was re-broadcast; receipt is still pending'
                )
              );
              continue;
            }
          }
          // Both confirmation paths above advance the lane to 'running' with
          // no driver attached; restart it exactly as the pause-resolution
          // verbs do, or the remaining steps never execute.
          await this.startLaneIfRunning(profileId, runId, lane.chainId);
          continue;
        } else if (attempt?.txHash || lane.pause?.reason === 'needs-review')
          continue;
        await this.mutate(
          profileId,
          runId,
          (current) => {
            const target = current.lanes[String(lane.chainId)];
            const interrupted = target.steps[target.pause!.stepIndex]?.attempts.find((entry) => entry.id === target.pause?.attemptId)
              ?? target.steps[target.pause!.stepIndex]?.attempts.at(-1);
            if (interrupted) { interrupted.resolution = 'retry'; interrupted.endedAt ??= iso(this.deps.now()); }
            target.status = 'running';
            target.pause = undefined;
          },
          lane.chainId
        );
        this.startLane(profileId, runId, lane.chainId);
      }
      return this.requireRun(profileId, runId);
    });
  }

  async abort(profileId: string, runId: string): Promise<RunRecord> {
    return this.queued(this.commands, `${profileId}:${runId}`, async () => {
      const next = await this.mutate(profileId, runId, (run) => {
        run.abortRequested = true;
        for (const lane of Object.values(run.lanes)) {
          if (terminal(lane)) continue;
          lane.abortRequested = true;
          // Paused lanes do not have an active loop to observe the flag. The
          // same is true for a pending lane before its loop was scheduled.
          if (
            lane.status === 'paused' ||
            (lane.status === 'pending' &&
              !this.active.has(this.key(profileId, runId, lane.chainId)))
          ) {
            const step = lane.steps[lane.currentStepIndex];
            const attempt =
              step?.attempts.find(
                (entry) => entry.id === lane.pause?.attemptId
              ) ?? step?.attempts.at(-1);
            if (attempt) {
              attempt.resolution = 'abort-run';
              attempt.endedAt ??= iso(this.deps.now());
              if (attempt.txHash || attempt.rawTx)
                step.unresolvedTx = {
                  txHash: attempt.txHash,
                  note: 'Run aborted while transaction may be in flight',
                };
            }
            lane.status = 'aborted';
            lane.pause = undefined;
          }
        }
      });
      for (const lane of Object.values(next.lanes))
        this.active.get(this.key(profileId, runId, lane.chainId))?.wake?.();
      return next;
    });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const active = [...this.active.values()];
    for (const lane of active) {
      lane.controller.abort();
      lane.wake?.();
    }
    await Promise.all(active.map((lane) => lane.promise));
    this.active.clear();
  }
  subscribe(listener: RunListener): () => void {
    return this.events.subscribe(listener);
  }
  eventsSince(runId: string, epoch: string, afterSeq: number): RunEvent[] {
    return this.events.eventsSince(runId, epoch, afterSeq);
  }
  eventCursor(runId: string): { epoch: string; lastSeq: number } {
    return this.events.cursor(runId);
  }
  async recoverOnStartup(): Promise<void> {
    const recovered = await this.deps.runStore.recoverStartup();
    // A sign-and-send provider owns submission and may not have exposed a
    // durable hash, so an interrupted in-flight attempt is never retried
    // automatically. The decision is made from the RUN RECORD ALONE: a live
    // account lookup cannot work here — a browser wallet has no connected
    // host while core is starting up, and a missed conversion would let
    // resume() re-execute an uncertain submission. A step that reached
    // 'broadcasting' persisted its intent before any submission; the
    // sign-only path always stores rawTx with that intent, so a broadcasting
    // step WITHOUT rawTx is exactly an in-flight sign-and-send.
    await Promise.all(
      recovered.map(async (run) =>
        Promise.all(
          Object.values(run.lanes).map(async (lane) => {
            if (lane.pause?.reason !== 'interrupted') return;
            const step = lane.steps[lane.pause.stepIndex];
            const attempt = step?.attempts.at(-1);
            if (step?.status !== 'broadcasting' || attempt?.rawTx) return;
            await this.mutate(
              run.profileId,
              run.id,
              (current) => {
                const target = current.lanes[String(lane.chainId)];
                if (target.pause?.reason === 'interrupted')
                  target.pause = {
                    ...target.pause,
                    reason: 'needs-review',
                    error:
                      'Signer-provider submission was interrupted and needs review',
                  };
              },
              lane.chainId
            );
          })
        )
      )
    );
    await this.deps.deploymentHooks.reconcileStartup();
  }
  async get(profileId: string, runId: string): Promise<RunRecord | undefined> {
    return this.deps.runStore.get(profileId, runId);
  }
  async list(profileId: string): Promise<{
    runs: import('@ignite/api').RunSummary[];
    unreadable: string[];
  }> {
    return this.deps.runStore.list(profileId);
  }
  async validatePlan(
    plan: DeploymentPlan,
    rpc: RpcSelection,
    opts?: { profileId?: string; explorerSelection?: Record<string, string[]>; workflow?: { document: WorkflowDocument; binding: WorkflowRunBinding } }
  ) {
    return this.deps.validate(plan, rpc, opts);
  }

  private startLane(profileId: string, runId: string, chainId: number): void {
    if (this.stopped || this.active.has(this.key(profileId, runId, chainId)))
      return;
    const controller = new AbortController();
    const promise = this.runLane(profileId, runId, chainId, controller).finally(
      () => this.active.delete(this.key(profileId, runId, chainId))
    );
    this.active.set(this.key(profileId, runId, chainId), {
      controller,
      promise,
    });
  }

  /** Re-reads the record because the caller's snapshot predates the confirmation that may have advanced the lane. */
  private async startLaneIfRunning(profileId: string, runId: string, chainId: number): Promise<void> {
    const current = await this.requireRun(profileId, runId);
    if (current.lanes[String(chainId)]?.status === 'running') this.startLane(profileId, runId, chainId);
  }

  private startReceiptWait(
    profileId: string,
    runId: string,
    chainId: number,
    txHash: Hex,
    attemptId: string,
    stepIndex: number
  ): void {
    const key = this.key(profileId, runId, chainId);
    if (this.stopped) return;
    const exiting = this.active.get(key);
    if (exiting) {
      void exiting.promise.finally(() =>
        this.startReceiptWait(
          profileId,
          runId,
          chainId,
          txHash,
          attemptId,
          stepIndex
        )
      );
      return;
    }
    const controller = new AbortController();
    const promise = (async () => {
      let confirmed = false;
      try {
        confirmed = await this.waitForKnownReceipt(
          profileId,
          runId,
          chainId,
          txHash,
          attemptId,
          controller.signal
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          try {
            await this.pause(
              profileId,
              runId,
              chainId,
              stepIndex,
              classify(error),
              error,
              attemptId
            );
          } catch {
            // Never fall through to fresh execution after an uncertain
            // receipt. Startup recovery will claim the still-running lane.
          }
        }
      } finally {
        this.active.delete(key);
        if (confirmed) this.startLane(profileId, runId, chainId);
      }
    })();
    this.active.set(key, { controller, promise });
  }

  private async waitForKnownReceipt(
    profileId: string,
    runId: string,
    chainId: number,
    txHash: Hex,
    attemptId: string,
    signal: AbortSignal
  ): Promise<boolean> {
    for (let attempt = 0; attempt < RECEIPT_RECHECK_ATTEMPTS; attempt += 1) {
      if (signal.aborted) return false;
      const run = await this.requireRun(profileId, runId);
      const receipt = await this.safeReceipt(
        (await this.rpcFor(run, chainId)).url,
        txHash
      );
      if (receipt) {
        await this.confirmReceipt(
          profileId,
          runId,
          chainId,
          txHash,
          receipt,
          attemptId,
          signal
        );
        return true;
      }
      await abortableDelay(RECEIPT_RECHECK_INTERVAL_MS, signal);
    }
    if (!signal.aborted) {
      const run = await this.requireRun(profileId, runId);
      await this.pause(
        profileId,
        runId,
        chainId,
        run.lanes[String(chainId)].currentStepIndex,
        'receipt-timeout',
        new Error('Transaction receipt is still pending'),
        attemptId
      );
    }
    return false;
  }

  // One eth_getCode taken right after a receipt proves nothing: the read can
  // land on a provider behind the one that served the receipt, and preconf
  // chains hand out receipts before the containing block seals. Poll for the
  // code before letting the caller conclude created-code-missing. Callers
  // without a signal (resume/reconcile commands) accept the full budget.
  private async waitForDeterministicCode(
    url: string,
    address: Hex,
    signal?: AbortSignal
  ): Promise<boolean> {
    const { attempts, intervalMs } = this.deps.createdCodeProbe;
    const delaySignal = signal ?? new AbortController().signal;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) return false;
      const code = await this.deps.getCode(url, address);
      if (code && code !== '0x') return true;
      await abortableDelay(intervalMs, delaySignal);
    }
    return false;
  }

  private async runLane(
    profileId: string,
    runId: string,
    chainId: number,
    controller: AbortController
  ): Promise<void> {
    for (;;) {
      if (controller.signal.aborted) return;
      const run = await this.requireRun(profileId, runId);
      const lane = run.lanes[String(chainId)];
      if (!lane || terminal(lane)) {
        await this.maybeArtifact(run);
        return;
      }
      if (lane.abortRequested || run.abortRequested) {
        await this.mutate(
          profileId,
          runId,
          (current) => {
            const target = current.lanes[String(chainId)];
            if (!terminal(target)) {
              target.status = 'aborted';
              target.pause = undefined;
            }
          },
          chainId
        );
        continue;
      }
      if (lane.status === 'paused') return;
      const stepIndex = lane.currentStepIndex;
      const step = run.plan.steps[stepIndex];
      if (!step) {
        await this.mutate(
          profileId,
          runId,
          (current) => {
            const target = current.lanes[String(chainId)];
            target.status = 'completed';
          },
          chainId
        );
        continue;
      }
      try {
        await this.executeStep(
          profileId,
          runId,
          chainId,
          stepIndex,
          controller.signal
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        await this.pause(
          profileId,
          runId,
          chainId,
          stepIndex,
          classify(error),
          error
        );
        return;
      }
    }
  }

  /**
   * Simulates a producer call to learn the addresses its products will get.
   * Runs immediately before the producer broadcasts, against the same node,
   * with the transaction's own target, calldata, sender and value — the
   * narrowest window available for "what will this call create". Review-time
   * predictions are deliberately never seeded into the lane (they are display
   * data), so this simulation is the only execution commitment; a failure
   * pauses the producer BEFORE broadcast, where retry costs nothing and no
   * producer call can confirm with unrecoverable products. The whole output
   * set is accepted or rejected together: every linked product must decode to
   * exactly one nonzero address and no two products may claim the same one.
   */
  private async predictProducedProducts(
    run: RunRecord,
    step: DeploymentPlan['steps'][number],
    chainId: number,
    rpcUrl: string,
    to: Hex | null,
    data: Hex,
    from: Hex,
    value: bigint,
    fn: AbiFunction | undefined
  ): Promise<Array<{ stepId: string; expectedAddress: Hex; note: string }> | undefined> {
    if (step.kind !== 'call') return undefined;
    const products = productsOfProducer(run.plan, step.id);
    if (!products.length) return undefined;
    if (!fn || !to)
      throw coded('estimation', `Products of ${step.id} need the producer call's function and target to simulate`);
    let raw: Hex;
    try {
      raw = await this.deps.call(rpcUrl, { to, data, from, ...(value > 0n ? { value } : {}) });
    } catch (error) {
      throw coded('estimation', `The producer call simulation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let decoded: Map<number, Hex>;
    try {
      decoded = decodeProducedAddresses(fn, raw);
    } catch (error) {
      throw coded('estimation', `The producer call result did not decode: ${error instanceof Error ? error.message : String(error)}`);
    }
    const claimed = new Map<string, string>();
    return products.map((product) => {
      const index = product.strategy.producedBy.outputIndex;
      const address = decoded.get(index);
      if (!address || /^0x0{40}$/i.test(address))
        throw coded('estimation', `The producer call returned no usable address at output ${index} for ${product.id}`);
      const holder = claimed.get(address.toLowerCase());
      if (holder)
        throw coded('estimation', `Products ${holder} and ${product.id} both resolve to ${address}`);
      claimed.set(address.toLowerCase(), product.id);
      return { stepId: product.id, expectedAddress: address, note: `address simulated from ${fn.name}() before broadcast` };
    });
  }

  private async executeStep(
    profileId: string,
    runId: string,
    chainId: number,
    stepIndex: number,
    signal: AbortSignal
  ): Promise<void> {
    const run = await this.requireRun(profileId, runId);
    const lane = run.lanes[String(chainId)];
    const step = run.plan.steps[stepIndex];
    const signer = resolveSigner(run.plan, step, chainId);
    if (!signer)
      throw coded('signer-mismatch', 'No signer is configured for this chain');
    const account = await this.deps.resolveAccount(
      signer.pluginId,
      signer.accountId,
      { refresh: true }
    );
    if (
      !account ||
      account.account.address.toLowerCase() !== signer.address.toLowerCase()
    )
      throw coded(
        'signer-mismatch',
        'Signer account no longer matches the deployment plan'
      );
    const rpc = await this.rpcFor(run, chainId);
    const resolveRef = (id: string): Hex => {
      const ref = lane.steps.find((candidate) => candidate.stepId === id);
      if (ref?.address) return ref.address;
      // A prediction only stands in for a step that will still execute:
      // failure-skipped steps have no code at the predicted address, so
      // resolving through them would bake a dead address in (review F6).
      // Accept-deployed skips carry `address` and resolve above. A produced
      // product's expected address stands in the same way once its producer
      // has durably committed it.
      const standIn = ref?.predictedAddress ?? ref?.expectedAddress;
      if (standIn && ref!.status !== 'skipped' && ref!.status !== 'failed')
        return standIn;
      throw coded('pointer-unresolved', `Pointer ${id} has no confirmed or predicted address`);
    };
    let to: Hex | null;
    let data: Hex;
    let libraries: Record<string, Hex> | undefined;
    let pointers: Record<string, Hex> | undefined;
    let deterministicInitcode: Hex | undefined;
    let callFn: AbiFunction | undefined;
    const attemptId = crypto.randomUUID();
    let jit: { predictedAddress: Hex; salt: Hex; notes: string[] } | undefined;
    if (step.kind === 'call') {
      const fn = callAbiItem(step, chainId, callTargetAbi(run.plan, step, chainId, run.inputs));
      const values = resolveStepValues(step, chainId, resolveRef, fn?.inputs ?? [], { frozen: run.inputs, contracts: run.plan.contracts });
      to = values.target!;
      pointers = values.pointers;
      callFn = fn;
      data = fn
        ? encodeFunctionData({ abi: [fn], functionName: fn.name, args: toConstructorArgs(fn.inputs, values.args, 'call') as never })
        : '0x';
    } else {
      const input = run.inputs[step.contractId];
      if (!input) throw coded('estimation', `Frozen input missing for ${step.contractId}`);
      if (isProducedStrategy(step.strategy)) {
        // Another step's producer call already deployed this product: it
        // submits no transaction and invokes no plugin operation. Record the
        // observed address and advance.
        const expected = lane.steps[stepIndex].expectedAddress;
        // The producer commits this before it broadcasts, so absence means
        // the producer call never executed inside this run.
        if (!expected) throw coded('pointer-unresolved', `Produced product ${step.id} has no expected address — its producer call did not execute in this run`);
        // A product confirms moments after its producer's receipt — exactly
        // the visibility window waitForDeterministicCode exists for — so one
        // read here paused healthy lanes the same way created-code-missing
        // used to before the probe.
        const observed = await this.waitForDeterministicCode(rpc.url, expected, signal);
        // Preserves the producer attempt, receipt, and expected address; the
        // operator reconciles with recheck or record-deployed-address.
        if (!observed) throw coded('produced-code-missing', `No contract at expected address ${expected} for produced product ${step.id}`);
        const observedAt = iso(this.deps.now());
        const settled = await this.mutate(profileId, runId, (current) => {
          const target = current.lanes[String(chainId)];
          const targetStep = target.steps[stepIndex];
          targetStep.status = 'confirmed';
          targetStep.address = expected;
          targetStep.addressProvenance = { kind: 'observed-at-expected', expectedAddress: expected, observedAt };
          target.currentStepIndex += 1;
          target.status = target.currentStepIndex >= target.steps.length ? 'completed' : 'running';
        }, chainId);
        // Runs only after mutate has persisted the confirmed product. Queue
        // failure never affects lane progress; startup reconciliation heals
        // this deliberately tolerated crash/failure window (same posture as
        // the receipt-driven settle path).
        void this.enqueueProducedProductVerification(settled, chainId, step.id).catch((error) =>
          getLogger().warn(`verification enqueue skipped for produced product ${step.id}: ${error instanceof Error ? error.message : String(error)}`)
        );
        return;
      }
      {
      const ctor = (input.abi as Abi).find((entry) => entry.type === 'constructor');
      const values = resolveStepValues(step, chainId, resolveRef, (ctor?.inputs ?? []) as never, { frozen: run.inputs, contracts: run.plan.contracts });
      libraries = values.libraries;
      pointers = values.pointers;
      const initcode = buildInitcode(step, input, chainId, resolveRef, { frozen: run.inputs, contracts: run.plan.contracts });
      deterministicInitcode = initcode;
      const strategy = step.strategy ?? { kind: 'create' as const };
      if (strategy.kind === 'create') {
        to = null;
        data = initcode;
      } else {
        const dynamic = dynamicDeterministicStepIds(run.plan, chainId).has(step.id);
        let predictedAddress = lane.steps[stepIndex].predictedAddress;
        let salt: Hex | undefined;
        if (dynamic) {
          try {
            if (strategy.kind === 'plugin') {
              const runtimeBytecode = buildRuntimeCode(step, input, chainId, resolveRef, { frozen: run.inputs, contracts: run.plan.contracts });
              const prepared = await this.deps.deploymentTypes.prepare(strategy.pluginId, { chainId, initcode, ...(runtimeBytecode === undefined ? {} : { runtimeBytecode }), params: strategy.params });
              if (predictCreate2Address(prepared.salt, initcodeHashOf(initcode)).toLowerCase() !== prepared.predictedAddress.toLowerCase())
                throw new Error('Deployment type returned a mismatched predicted address');
              const info = (await this.deps.deploymentTypes.list()).find((entry) => entry.pluginId === strategy.pluginId);
              if (info?.validateSupported) {
                const verdict = await this.deps.deploymentTypes.validate(strategy.pluginId, { chainId, initcode, ...(runtimeBytecode === undefined ? {} : { runtimeBytecode }), salt: prepared.salt, predictedAddress: prepared.predictedAddress, params: strategy.params });
                if (!verdict.ok) throw new Error(verdict.reason ?? 'Deployment type rejected this deployment');
              }
              predictedAddress = prepared.predictedAddress; salt = prepared.salt; jit = { predictedAddress, salt, notes: prepared.notes };
            } else {
              salt = isInitcodeStrategy(strategy) ? effectiveSalt(strategy, chainId) : undefined;
              if (!salt) throw new Error(`Create2 step ${step.id} has no salt`);
              predictedAddress = predictCreate2Address(salt, initcodeHashOf(initcode)); jit = { predictedAddress, salt, notes: [] };
            }
          } catch (error) { throw coded('estimation', error instanceof Error ? error.message : String(error)); }
        }
        if (!predictedAddress) throw coded('pointer-unresolved', `Create2 step ${step.id} has no predicted address`);
        if (!dynamic) {
          const code = await this.deps.getCode(rpc.url, predictedAddress);
          if (code && code !== '0x') {
            if (ackIsFresh(strategy, chainId, { predictedAddress, initcodeHash: initcodeHashOf(initcode) })) {
              let capture: WrapperCapture | undefined;
              let captureError: unknown;
              const captureAttemptId = crypto.randomUUID();
              try { capture = await this.captureWrapper(run, chainId, stepIndex, predictedAddress); }
              catch (error) { captureError = error; }
              await this.mutate(profileId, runId, (current) => {
                const target = current.lanes[String(chainId)];
                const targetStep = target.steps[stepIndex];
                if (captureError) {
                  targetStep.attempts.push({ id: captureAttemptId, startedAt: iso(this.deps.now()), error: sanitizeRunError(captureError) });
                  targetStep.status = 'failed'; target.status = 'paused';
                  target.pause = {
                    reason: (captureError as { pauseReason?: PauseReason }).pauseReason === 'rpc' ? 'rpc' : 'needs-review',
                    stepIndex,
                    error: sanitizeRunError(captureError),
                    attemptId: captureAttemptId,
                    ...((captureError as { details?: Record<string, unknown> }).details ? { details: (captureError as { details: Record<string, unknown> }).details } : {}),
                  };
                  return;
                }
                targetStep.status = 'skipped'; targetStep.address = predictedAddress;
                if (capture && Object.keys(capture.captured).length) targetStep.captured = capture.captured;
                if (capture?.note) appendLaneStepNote(targetStep, capture.note);
                target.currentStepIndex += 1;
                target.status = target.currentStepIndex >= target.steps.length ? 'completed' : 'running';
              }, chainId);
              return;
            }
            throw coded('create2-collision', `Code already exists at predicted address ${predictedAddress}`);
          }
        }
        to = CREATE2_PROXY_ADDRESS;
        data = create2Calldata((jit?.salt ?? (isInitcodeStrategy(strategy) ? strategy.saltPerChain?.[String(chainId)] ?? strategy.salt : undefined))!, initcode);
      }
      }
    }
    // Produced products commit to their addresses here, seconds before the
    // producer transaction broadcasts — never from review-time predictions.
    const producedExpectations = await this.predictProducedProducts(
      run, step, chainId, rpc.url, to, data, signer.address as Hex, effectiveValue(step, chainId), callFn
    );
    // Pre-existing code at ANY expected product address pauses the producer
    // before broadcast: the existing contracts are not products of this call,
    // and persisting their addresses would claim they are. Deliberately a
    // single read, not waitForDeterministicCode: that probe waits for code to
    // APPEAR, while this check requires the address to be empty — polling
    // would only slow every healthy broadcast.
    if (producedExpectations)
      for (const expectation of producedExpectations) {
        const existing = await this.deps.getCode(rpc.url, expectation.expectedAddress);
        if (existing && existing !== '0x')
          throw coded('produced-address-occupied', `Code already exists at expected product address ${expectation.expectedAddress} for ${expectation.stepId}`);
      }
    const gas = mergeGas(step, chainId);
    const overrides: TxOverrides = Object.fromEntries(
      Object.entries(gas).map(([key, value]) => [key, BigInt(value)])
    );
    const previousAttempt = lane.steps[stepIndex].attempts.at(-1);
    if (
      previousAttempt?.resolution === 'replace' &&
      previousAttempt.nonce !== undefined
    ) {
      overrides.nonce = previousAttempt.nonce;
    }
    await this.mutate(
      profileId,
      runId,
      (current) => {
        const target = current.lanes[String(chainId)];
        target.status = 'running';
        const targetStep = target.steps[stepIndex];
        targetStep.status = 'awaiting-signature';
        if (jit) { targetStep.predictedAddress = jit.predictedAddress; targetStep.salt = jit.salt as `0x${string}`; targetStep.notes = jit.notes; }
        // Durable BEFORE broadcast: a crash after the producer call is sent
        // must never leave its products without their committed addresses.
        // All expected addresses land in this one mutate — atomically with
        // the attempt — or not at all.
        if (producedExpectations) for (const expectation of producedExpectations) {
          const productStep = target.steps.find((candidate) => candidate.stepId === expectation.stepId);
          if (productStep && !productStep.address) { productStep.expectedAddress = expectation.expectedAddress; appendLaneStepNote(productStep, expectation.note); }
        }
        targetStep.attempts.push({
          id: attemptId,
          startedAt: iso(this.deps.now()),
          ...(jit ? { expected: { to, value: effectiveValue(step, chainId).toString(), dataHash: keccak256(data), ...(libraries && Object.keys(libraries).length ? { libraries } : {}), ...(pointers && Object.keys(pointers).length ? { pointers } : {}) } } : {}),
        });
      },
      chainId
    );
    if (jit) {
      const code = await this.deps.getCode(rpc.url, jit.predictedAddress);
      if (code && code !== '0x') {
        const strategy = step.kind === 'deploy' ? step.strategy : undefined;
        if (strategy && strategy.kind !== 'create' && deterministicInitcode && ackIsFresh(strategy, chainId, { predictedAddress: jit.predictedAddress, initcodeHash: initcodeHashOf(deterministicInitcode) })) {
          let capture: WrapperCapture | undefined;
          let captureError: unknown;
          try { capture = await this.captureWrapper(run, chainId, stepIndex, jit.predictedAddress); }
          catch (error) { captureError = error; }
          await this.mutate(profileId, runId, (current) => {
            const target = current.lanes[String(chainId)]; const targetStep = target.steps[stepIndex];
            if (captureError) {
              targetStep.status = 'failed'; target.status = 'paused';
              target.pause = {
                reason: (captureError as { pauseReason?: PauseReason }).pauseReason === 'rpc' ? 'rpc' : 'needs-review',
                stepIndex,
                error: sanitizeRunError(captureError),
                attemptId: targetStep.attempts.find((entry) => entry.id === attemptId)?.id ?? attemptId,
                ...((captureError as { details?: Record<string, unknown> }).details ? { details: (captureError as { details: Record<string, unknown> }).details } : {}),
              };
              return;
            }
            targetStep.status = 'skipped'; targetStep.address = jit.predictedAddress;
            const attempt = targetStep.attempts.find((entry) => entry.id === attemptId);
            if (attempt) { attempt.resolution = 'accept-deployed'; attempt.endedAt = iso(this.deps.now()); }
            if (capture && Object.keys(capture.captured).length) targetStep.captured = capture.captured;
            if (capture?.note) appendLaneStepNote(targetStep, capture.note);
            target.currentStepIndex += 1;
            target.status = target.currentStepIndex >= target.steps.length ? 'completed' : 'running';
          }, chainId);
          return;
        }
        throw coded('create2-collision', `Code already exists at predicted address ${jit.predictedAddress}`);
      }
    }
    const chain = await this.deps.chainMetadata(chainId);
    const result = await this.deps.executeTx(
      {
        pluginId: signer.pluginId,
        accountId: signer.accountId,
        chainId,
        rpcUrl: rpc.url,
        chain,
        to,
        value: effectiveValue(step, chainId),
        data,
        expectedAddress: signer.address as Hex,
        overrides: overrides as ExecuteTxArgs['overrides'],
        onPhase: async (phase, phaseData) => {
          if (phase === 'built') {
            try {
              await this.mutate(profileId, runId, (current) => {
                const attempt = current.lanes[String(chainId)].steps[stepIndex].attempts.find((entry) => entry.id === attemptId);
                if (!attempt) throw coded('write-failure', 'Deployment attempt disappeared before intent could be persisted');
                attempt.expected = {
                  to, value: effectiveValue(step, chainId).toString(), dataHash: keccak256(data),
                  ...(libraries && Object.keys(libraries).length ? { libraries } : {}),
                  ...(pointers && Object.keys(pointers).length ? { pointers } : {}),
                };
              }, chainId);
            } catch (error) { throw coded('write-failure', sanitizeRunError(error)); }
            return;
          }
          if (phase !== 'broadcasting') return;
          try {
            await this.mutate(
              profileId,
              runId,
              (current) => {
                const target = current.lanes[String(chainId)];
                const targetStep = target.steps[stepIndex];
                const attempt = targetStep.attempts.find(
                  (entry) => entry.id === attemptId
                );
                if (!attempt)
                  throw coded(
                    'write-failure',
                    'Deployment attempt disappeared before broadcast intent could be persisted'
                  );
                attempt.txHash = phaseData.txHash;
                attempt.rawTx = phaseData.rawTx;
                attempt.nonce = phaseData.tx.nonce;
                targetStep.status = 'broadcasting';
              },
              chainId
            );
          } catch (error) {
            throw coded('write-failure', sanitizeRunError(error));
          }
        },
      },
      { log: () => undefined, signal }
    );
    // Reverted results flow through confirmReceipt too: it persists the
    // hash/gas/block audit data on the attempt AND raises the revert pause.
    // Throwing here instead would discard the receipt entirely.
    await this.confirmReceipt(
      profileId,
      runId,
      chainId,
      result.txHash,
      result,
      attemptId,
      signal
    );
  }

  private async confirmReceipt(
    profileId: string,
    runId: string,
    chainId: number,
    hash: Hex,
    receipt: Receipt,
    attemptId?: string,
    signal?: AbortSignal
  ): Promise<void> {
    const before = await this.requireRun(profileId, runId);
    const beforeLane = before.lanes[String(chainId)];
    const planStep = before.plan.steps[beforeLane.currentStepIndex];
    const laneStep = beforeLane.steps[beforeLane.currentStepIndex];
    // The CREATE2 proxy does not put the created address in the receipt, so
    // the predicted runtime code is the only confirmation signal. Probe for
    // it rather than trusting one read (see waitForDeterministicCode).
    const deterministic = planStep?.kind === 'deploy' && planStep.strategy?.kind !== undefined && planStep.strategy.kind !== 'create';
    const deterministicCodePresent = !deterministic || !laneStep.predictedAddress
      ? true
      : receipt.status === 'success' &&
        (await this.waitForDeterministicCode((await this.rpcFor(before, chainId)).url, laneStep.predictedAddress, signal));
    // A probe cut short by lane teardown answered nothing; a verdict written
    // now would fabricate created-code-missing. The broadcast phase already
    // persisted txHash/rawTx, so startup recovery re-derives the receipt.
    if (signal?.aborted && receipt.status === 'success' && !deterministicCodePresent) return;
    let capture: WrapperCapture | undefined;
    let captureError: unknown;
    const confirmedAddress = deterministic ? laneStep.predictedAddress : receipt.contractAddress ?? undefined;
    if (receipt.status === 'success' && planStep?.kind === 'deploy' && planStep.wraps && confirmedAddress && deterministicCodePresent) {
      try { capture = await this.captureWrapper(before, chainId, beforeLane.currentStepIndex, confirmedAddress); }
      catch (error) { captureError = error; }
    }
    const settled = await this.mutate(
      profileId,
      runId,
      (run) => {
        const lane = run.lanes[String(chainId)];
        const step = lane.steps[lane.currentStepIndex];
        const attempt =
          (attemptId
            ? step.attempts.find((entry) => entry.id === attemptId)
            : step.attempts.find((entry) => entry.txHash === hash)) ??
          step.attempts.at(-1);
        if (!attempt)
          throw coded(
            'write-failure',
            'No deployment attempt exists for receipt confirmation'
          );
        Object.assign(attempt, {
          txHash: hash,
          endedAt: iso(this.deps.now()),
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          blockNumber: receipt.blockNumber,
          txStatus: receipt.status,
          ...(receipt.nonce === undefined ? {} : { nonce: receipt.nonce }),
        });
        if (receipt.status === 'reverted') {
          // The attempt's own error is load-bearing: aborted-after-failure
          // detection in runStatus keys on it, and the audit trail should
          // say why the attempt ended even with full receipt data present.
          attempt.error = 'Transaction reverted';
          step.status = 'failed';
          lane.status = 'paused';
          lane.pause = {
            reason: 'revert',
            stepIndex: lane.currentStepIndex,
            error: 'Transaction reverted',
            attemptId: attempt.id,
          };
        } else if (deterministic && !deterministicCodePresent) {
          step.status = 'failed';
          lane.status = 'paused';
          lane.pause = {
            reason: 'created-code-missing',
            stepIndex: lane.currentStepIndex,
            error: 'Transaction succeeded but no code exists at the predicted CREATE2 address',
            attemptId: attempt.id,
          };
        } else if (
          planStep?.kind === 'deploy' &&
          !deterministic &&
          !receipt.contractAddress
        ) {
          // A successful plain-create receipt MUST carry the created
          // address; confirming without one strands every dependent
          // pointer (review F8). Operator verbs sort out the anomaly.
          step.status = 'failed';
          lane.status = 'paused';
          lane.pause = {
            reason: 'needs-review',
            stepIndex: lane.currentStepIndex,
            error: 'Transaction succeeded but the receipt reports no created contract address',
            attemptId: attempt.id,
          };
        } else if (captureError) {
          step.status = 'failed';
          lane.status = 'paused';
          lane.pause = {
            reason: (captureError as { pauseReason?: PauseReason }).pauseReason === 'rpc' ? 'rpc' : 'needs-review',
            stepIndex: lane.currentStepIndex,
            error: sanitizeRunError(captureError),
            attemptId: attempt.id,
            ...((captureError as { details?: Record<string, unknown> }).details ? { details: (captureError as { details: Record<string, unknown> }).details } : {}),
          };
        } else {
          step.status = 'confirmed';
          if (planStep?.kind === 'deploy')
            step.address = deterministic
              ? lane.steps[lane.currentStepIndex].predictedAddress
              : receipt.contractAddress ?? undefined;
          if (capture && Object.keys(capture.captured).length) step.captured = capture.captured;
          if (capture?.note) appendLaneStepNote(step, capture.note);
          // A pause aimed at the step this receipt just confirmed is resolved
          // by that confirmation (recheck/resume after a receipt-timeout);
          // leaving it stale marks a progressing lane as stuck.
          if (lane.pause?.stepIndex === lane.currentStepIndex)
            lane.pause = undefined;
          lane.currentStepIndex += 1;
          lane.status =
            lane.currentStepIndex >= lane.steps.length
              ? 'completed'
              : 'running';
        }
      },
      chainId
    );
    // This runs only after mutate has persisted the confirmed step. Queue
    // failure never affects deployment lane progress; startup reconciliation
    // heals this deliberately tolerated crash/failure window.
    if (receipt.status === 'success')
      void this.enqueueConfirmedVerification(settled, chainId, hash).catch((error) =>
        getLogger().warn(`verification enqueue skipped for ${hash}: ${error instanceof Error ? error.message : String(error)}`)
      );
  }

  private async enqueueConfirmedVerification(run: RunRecord, chainId: number, hash: Hex): Promise<void> {
    const lane = run.lanes[String(chainId)];
    const step = lane?.steps.find((candidate) =>
      candidate.status === 'confirmed' && candidate.attempts.some((attempt) => attempt.txHash === hash)
    );
    if (!step?.address || !run.explorerTargets?.[String(chainId)]?.length) return;
    const attempt = step.attempts.find((candidate) => candidate.txHash === hash);
    const planStep = run.plan.steps.find((candidate) => candidate.id === step.stepId);
    if (!attempt || !planStep || planStep.kind !== 'deploy') return;
    // Produced products confirm without a transaction of their own and are
    // enqueued from their confirmation paths; a receipt can never belong to
    // one, but the guard keeps a malformed record from decomposing the
    // producer's calldata as if it were creation calldata.
    if (isProducedStrategy(planStep.strategy))
      return this.enqueueProducedProductVerification(run, chainId, planStep.id);
    const input = run.inputs[planStep.contractId];
    if (!input || !attempt.expected) return;
    let data: Hex | undefined;
    try { data = await this.deps.getTransactionData((await this.rpcFor(run, chainId)).url, hash); }
    catch {
      if (attempt.rawTx) data = parseTransaction(attempt.rawTx).data as Hex | undefined;
    }
    if (!data) return;
    const linkedCreationCode = input.creationCodeLinkReferences
      ? linkBytecode(input.creationBytecode, input.creationCodeLinkReferences, attempt.expected.libraries ?? {})
      : input.creationBytecode as Hex;
    const strategy = planStep.strategy?.kind === 'create' || !planStep.strategy ? 'create' : 'create2';
    const decomposition = decomposeCreationCalldata(data, linkedCreationCode, strategy);
    if (!decomposition) {
      getLogger().warn(`verification enqueue skipped for ${hash}: creation calldata does not match frozen linked bytecode`);
      return;
    }
    await this.deps.verificationQueue.enqueueForConfirmedStep(
      run.profileId, run, chainId, step.stepId, planStep.contractId,
      step.address, hash, decomposition.constructorData, attempt.expected.libraries
    );
    await this.enqueueCapturedContractTypeVerifications(run, chainId, planStep, step);
  }

  /**
   * Produced products confirm with no creation calldata of their own — the
   * producer encodes their constructor arguments onchain — so verification
   * cannot decompose a transaction. It instead encodes the product's
   * DECLARED constructor args (step args, the composer's mapping) against
   * the frozen constructor ABI. An incomplete declaration only skips
   * auto-verification; it never touches lane state.
   */
  private async enqueueProducedProductVerification(run: RunRecord, chainId: number, stepId: string): Promise<void> {
    if (!run.explorerTargets?.[String(chainId)]?.length) return;
    const lane = run.lanes[String(chainId)];
    const laneStep = lane?.steps.find((candidate) => candidate.stepId === stepId);
    const planStep = run.plan.steps.find((candidate) => candidate.id === stepId);
    if (!laneStep?.address || laneStep.status !== 'confirmed') return;
    if (!planStep || planStep.kind !== 'deploy') return;
    const strategy = planStep.strategy;
    if (!isProducedStrategy(strategy)) return;
    const input = run.inputs[planStep.contractId];
    if (!input) return;
    // Same stand-in rule as execution: an expected address resolves only for
    // steps that will still execute (failure-skipped products have no code
    // there). Declarations referencing sibling products of the same producer
    // resolve from these persisted addresses.
    const resolveRef = (id: string): Hex => {
      const ref = lane.steps.find((candidate) => candidate.stepId === id);
      if (ref?.address) return ref.address;
      const standIn = ref?.predictedAddress ?? ref?.expectedAddress;
      if (standIn && ref!.status !== 'skipped' && ref!.status !== 'failed') return standIn;
      throw coded('pointer-unresolved', `Pointer ${id} has no confirmed or predicted address`);
    };
    const encoded = encodeDeclaredProductArgs(planStep, input, chainId, resolveRef, { frozen: run.inputs, contracts: run.plan.contracts });
    if (encoded === undefined) {
      getLogger().warn(`verification enqueue skipped for produced product ${stepId}: constructor arguments are not declared`);
      return;
    }
    // A product's creation transaction is its producer call's — even when the
    // final address was manually reconciled.
    const creationTxHash = laneStep.attempts.findLast((attempt) => attempt.txHash)?.txHash
      ?? lane.steps.find((candidate) => candidate.stepId === strategy.producedBy.stepId)?.attempts.findLast((attempt) => attempt.txHash)?.txHash;
    if (!creationTxHash) {
      getLogger().warn(`verification enqueue skipped for produced product ${stepId}: the producer call has no transaction hash`);
      return;
    }
    await this.deps.verificationQueue.enqueueForConfirmedStep(
      run.profileId, run, chainId, stepId, planStep.contractId,
      laneStep.address, creationTxHash, encoded
    );
  }

  private async enqueueCapturedContractTypeVerifications(
    run: RunRecord,
    chainId: number,
    wrapper: Extract<RunRecord['plan']['steps'][number], { kind: 'deploy' }>,
    laneStep: RunRecord['lanes'][string]['steps'][number]
  ): Promise<void> {
    if (!wrapper.wraps || !laneStep.captured) return;
    const type = run.contractTypes?.[wrapper.wraps.contractTypePluginId];
    if (!type) return;
    const ctor = ((run.inputs[wrapper.contractId]?.abi as Abi | undefined)?.find((item) => item.type === 'constructor')?.inputs ?? []) as readonly AbiParameter[];
    const resolved = resolveStepValues(wrapper, chainId, (stepId) => {
      const step = run.lanes[String(chainId)]?.steps.find((entry) => entry.stepId === stepId);
      if (!step?.address) throw new Error(`Pointer ${stepId} is unresolved`);
      return step.address;
    }, ctor, { frozen: run.inputs, contracts: run.plan.contracts });
    for (const capture of type.descriptor.capture) {
      if (!capture.derivedCreate || !capture.record || !capture.verifyAs) continue;
      const address = laneStep.captured[capture.record];
      const artifact = type.artifacts[capture.verifyAs];
      if (!address || !artifact) continue;
      const adminCtor = ((artifact.abi as Abi).find((item) => item.type === 'constructor')?.inputs ?? []) as readonly AbiParameter[];
      const values = (capture.constructorArgs ?? []).map((param) => {
        const synthesis = type.descriptor.synthesis?.constructorArgs.find((entry) => entry.from === 'param' && entry.param === param);
        if (!synthesis || !(synthesis.name in resolved.args)) throw new Error(`Capture constructor argument ${param} is unresolved`);
        return resolved.args[synthesis.name];
      });
      await this.deps.verificationQueue.enqueueContractTypeCapture(
        run.profileId, run, chainId, wrapper.id, wrapper.contractId, capture.record,
        address, artifact, encodeAbiParameters(adminCtor, values as readonly unknown[])
      );
    }
  }

  /** Executes only frozen descriptor capture rules; live plugin data is never read. */
  private async captureWrapper(run: RunRecord, chainId: number, stepIndex: number, wrapperAddress: Hex): Promise<WrapperCapture> {
    const wrapper = run.plan.steps[stepIndex];
    if (!wrapper || wrapper.kind !== 'deploy' || !wrapper.wraps) return { captured: {} };
    const type = run.contractTypes?.[wrapper.wraps.contractTypePluginId];
    if (!type) throw Object.assign(new Error('Frozen contract-type descriptor is missing'), { details: { assertion: 'descriptor' } });
    const impl = run.lanes[String(chainId)].steps.find((entry) => entry.stepId === wrapper.wraps!.stepId)?.address;
    if (!impl) throw Object.assign(new Error('Wrapped implementation address is unresolved'), { details: { assertion: 'implementation-address' } });
    const rpc = await this.rpcFor(run, chainId);
    const addresses = (id: string): Hex => {
      const laneStep = run.lanes[String(chainId)].steps.find((entry) => entry.stepId === id);
      if (!laneStep?.address && !laneStep?.predictedAddress) throw coded('pointer-unresolved', `Pointer ${id} is unresolved during capture`);
      return (laneStep.address ?? laneStep.predictedAddress)!;
    };
    const synthesis = type.descriptor.synthesis;
    const ctor = synthesis ? ((run.inputs[wrapper.contractId]?.abi as Abi | undefined)?.find((item) => item.type === 'constructor')?.inputs ?? []) : [];
    const values = resolveStepValues(wrapper, chainId, addresses, ctor as never, { frozen: run.inputs, contracts: run.plan.contracts });
    const captured: Record<string, Hex> = {};
    const assertions: Array<NonNullable<(typeof type.descriptor.capture)[number]['assertCalls']>[number]> = [];
    for (const capture of type.descriptor.capture) {
      let word: Hex;
      try { word = await this.deps.getStorageAt(rpc.url, wrapperAddress, capture.slot); }
      catch (error) { throw coded('rpc', `Capture storage read failed: ${error instanceof Error ? error.message : String(error)}`); }
      if (!/^0x[0-9a-fA-F]{64}$/.test(word)) throw Object.assign(new Error(`Capture slot ${capture.slot} did not return a 32-byte word`), { details: { assertion: 'storage-word', slot: capture.slot } });
      const address = `0x${word.slice(-40)}` as Hex;
      if (capture.record) captured[capture.record] = address;
      const expectedWord = (address: Hex) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
      if (capture.expect === 'implementation-address' && word.toLowerCase() !== expectedWord(impl))
        throw Object.assign(new Error('Captured implementation address does not match the wrapped implementation'), { details: { assertion: 'implementation-address', slot: capture.slot, expected: impl, actual: address } });
      if (capture.derivedCreate) {
        const expected = getContractAddress({ from: wrapperAddress, nonce: BigInt(capture.derivedCreate.nonce) });
        if (word.toLowerCase() !== expectedWord(expected))
          throw Object.assign(new Error('Captured address does not match the required CREATE derivation'), { details: { assertion: 'derivedCreate', slot: capture.slot, expected, actual: address } });
      }
      if (capture.expectCodeOf) {
        const artifact = type.artifacts[capture.expectCodeOf];
        if (!artifact) throw Object.assign(new Error(`Frozen capture artifact ${capture.expectCodeOf} is missing`), { details: { assertion: 'expectCodeOf' } });
        let code: Hex;
        try { code = await this.deps.getCode(rpc.url, address); }
        catch (error) { throw coded('rpc', `Capture code read failed: ${error instanceof Error ? error.message : String(error)}`); }
        if (code.toLowerCase() !== artifact.runtimeBytecode.toLowerCase())
          throw Object.assign(new Error('Captured contract runtime bytecode does not match the frozen artifact'), { details: { assertion: 'expectCodeOf', artifact: capture.expectCodeOf, expected: artifact.runtimeBytecode, actual: code } });
      }
      for (const assertion of capture.assertCalls ?? []) {
        assertions.push(assertion);
      }
    }
    // All storage reads are complete before assertions run. Descriptor
    // validation additionally guarantees assertion.on is from this or an
    // earlier capture, so assertions always see their recorded target.
    for (const assertion of assertions) {
        const target = captured[assertion.on];
        const artifact = type.artifacts[assertion.on];
        if (!target || !artifact) throw Object.assign(new Error(`Capture call target ${assertion.on} is unavailable`), { details: { assertion: 'assertCalls', on: assertion.on } });
        const fn = Array.isArray(artifact.abi)
          ? artifact.abi.find((item): item is AbiFunction => Boolean(item && typeof item === 'object' && (item as { type?: string }).type === 'function') && (() => { try { return toFunctionSignature(item as AbiFunction) === assertion.call; } catch { return false; } })())
          : undefined;
        const callFn = fn ?? parseAbiItem(`function ${assertion.call}`) as AbiFunction;
        let data: Hex;
        try { data = await this.deps.call(rpc.url, { to: target, data: encodeFunctionData({ abi: [callFn], functionName: callFn.name }) }); }
        catch (error) { throw coded('rpc', `Capture call failed: ${error instanceof Error ? error.message : String(error)}`); }
        const actual = decodeFunctionResult({ abi: [callFn], functionName: callFn.name, data });
        const parameter = synthesis?.constructorArgs.find((arg) => arg.from === 'param' && arg.param === assertion.expectParam);
        const expected = parameter ? values.args[parameter.name] : undefined;
        const same = typeof actual === 'string' && typeof expected === 'string' && /^0x[0-9a-fA-F]{40}$/.test(actual) && /^0x[0-9a-fA-F]{40}$/.test(expected)
          ? String(actual).toLowerCase() === (expected as string).toLowerCase()
          : actual === expected;
        if (!same) throw Object.assign(new Error(`Capture call ${assertion.call} returned an unexpected value`), { details: { assertion: 'assertCalls', call: assertion.call, expected, actual } });
    }
    const runtime = run.inputs[wrapper.contractId]?.runtimeBytecode;
    let note: string | undefined;
    if (runtime) {
      let code: Hex;
      try { code = await this.deps.getCode(rpc.url, wrapperAddress); }
      catch (error) { throw coded('rpc', `Capture wrapper code read failed: ${error instanceof Error ? error.message : String(error)}`); }
      if (code.toLowerCase() !== runtime.toLowerCase())
        note = 'wrapper runtime differs from frozen artifact (immutables or unverified provenance)';
    }
    return { captured, note };
  }

  private async reconcile(
    profileId: string,
    runId: string,
    chainId: number,
    hash: Hex
  ): Promise<void> {
    const run = await this.requireRun(profileId, runId);
    const receipt = await this.safeReceipt(
      (await this.rpcFor(run, chainId)).url,
      hash
    );
    if (!receipt)
      throw coded(
        'receipt-timeout',
        'Transaction receipt is not available yet'
      );
    await this.confirmReceipt(profileId, runId, chainId, hash, receipt);
  }
  private async safeReceipt(
    url: string,
    hash: Hex
  ): Promise<Receipt | undefined> {
    try {
      return await this.deps.getReceipt(url, hash);
    } catch {
      return undefined;
    }
  }
  private async rpcFor(run: RunRecord, chainId: number): Promise<ResolvedRpc> {
    const binding = run.rpcSelection[String(chainId)];
    if (!binding) throw coded('rpc', 'No RPC binding is available');
    const resolved = await this.deps.resolveRpcUrl(chainId, binding.endpointId);
    if (!resolved) throw coded('rpc', 'Selected RPC endpoint is unavailable');
    if (resolved.fingerprint !== binding.urlFingerprint)
      throw coded('rpc-binding-changed', 'The selected RPC endpoint changed');
    return resolved;
  }
  private async pause(
    profileId: string,
    runId: string,
    chainId: number,
    stepIndex: number,
    reason: PauseReason,
    error: unknown,
    attemptId?: string
  ): Promise<void> {
    await this.mutate(
      profileId,
      runId,
      (run) => {
        const lane = run.lanes[String(chainId)];
        const step = lane.steps[stepIndex];
        let attempt =
          (attemptId
            ? step.attempts.find((entry) => entry.id === attemptId)
            : undefined) ?? step.attempts.at(-1);
        if (!attempt) {
          // Signer/RPC/encoding failures can precede attempt creation. A
          // synthetic attempt keeps the pause representable — throwing here
          // would strand the lane with no attemptId for the resolve UI.
          attempt = { id: crypto.randomUUID(), startedAt: iso(this.deps.now()) };
          step.attempts.push(attempt);
        }
        attempt.error = sanitizeRunError(error);
        attempt.endedAt = iso(this.deps.now());
        if (reason === 'revert') step.status = 'failed';
        lane.status = 'paused';
        // POINTER_UNRESOLVED errors carry {stepId, path}: the run view uses
        // them to route the edit dialog to the broken field (review F17).
        const errorDetails = (error as { details?: Record<string, unknown> })?.details;
        lane.pause = {
          reason,
          stepIndex,
          error: sanitizeRunError(error),
          attemptId: attempt.id,
          ...(reason === 'pointer-unresolved' && errorDetails
            ? { details: { stepId: errorDetails.stepId, path: errorDetails.path } }
            : {}),
        };
      },
      chainId
    );
  }
  private applyEdits(
    run: RunRecord,
    lane: Lane,
    cmd: Extract<ResolveLaneRequest, { action: 'edit' }>,
    attempt: RunRecord['lanes'][string]['steps'][number]['attempts'][number],
    rpcBinding?: RunRecord['rpcSelection'][string]
  ): void {
    const key = String(lane.chainId);
    for (const [stepId, args] of Object.entries(cmd.edits.argsByStep ?? {})) {
      const index = run.plan.steps.findIndex((step) => step.id === stepId);
      if (index < 0)
        throw new IgniteError(`Argument edit for unknown step ${stepId}`, ErrorCodes.ILLEGAL_RESOLVE);
      if (index >= lane.currentStepIndex) {
        const planStep = run.plan.steps[index];
        planStep.argsPerChain = {
          ...(planStep.argsPerChain ?? {}),
          [key]: { ...(planStep.argsPerChain?.[key] ?? {}), ...args },
        };
      }
    }
    for (const [stepId, target] of Object.entries(cmd.edits.targetByStep ?? {})) {
      const index = run.plan.steps.findIndex((step) => step.id === stepId);
      const planStep = run.plan.steps[index];
      // Inapplicable edits reject the WHOLE request — silently dropping a
      // field would persist a half-applied edit (final-review F18).
      if (index < lane.currentStepIndex || planStep?.kind !== 'call')
        throw new IgniteError(`Target edit for ${stepId} is not applicable`, ErrorCodes.ILLEGAL_RESOLVE);
      planStep.targetPerChain = { ...(planStep.targetPerChain ?? {}), [key]: target };
    }
    for (const [stepId, libraries] of Object.entries(cmd.edits.librariesByStep ?? {})) {
      const index = run.plan.steps.findIndex((step) => step.id === stepId);
      const planStep = run.plan.steps[index];
      if (index < lane.currentStepIndex || planStep?.kind !== 'deploy')
        throw new IgniteError(`Library edit for ${stepId} is not applicable`, ErrorCodes.ILLEGAL_RESOLVE);
      planStep.librariesPerChain = { ...(planStep.librariesPerChain ?? {}), [key]: { ...(planStep.librariesPerChain?.[key] ?? {}), ...libraries } };
    }
    const current = run.plan.steps[lane.currentStepIndex];
    if (cmd.edits.gas)
      current.gasOverridesPerChain = {
        ...(current.gasOverridesPerChain ?? {}),
        [key]: {
          ...(current.gasOverridesPerChain?.[key] ?? {}),
          ...cmd.edits.gas,
        },
      };
    if (rpcBinding) run.rpcSelection[key] = rpcBinding;
    attempt.edits = { ...cmd.edits };
  }

  /** Validate an edit on a clone before the durable mutation. */
  private validateEdits(
    run: RunRecord,
    lane: Lane,
    cmd: Extract<ResolveLaneRequest, { action: 'edit' }>
  ) {
    const draft = structuredClone(run);
    const draftLane = draft.lanes[String(lane.chainId)];
    const attempt = draftLane.steps[draftLane.currentStepIndex].attempts.find((entry) => entry.id === cmd.attemptId)
      ?? { id: cmd.attemptId, startedAt: iso(this.deps.now()) };
    this.applyEdits(draft, draftLane, cmd, attempt);
    try {
      validateDependencies(draft.plan);
      validateWrapsIntegrity(draft.plan, draft.inputs, draft.contractTypes, lane.chainId);
      const contractTypeFailure = contractTypeStaticItems(
        draft.plan,
        draft.inputs,
        draft.contractTypes,
        lane.chainId
      ).find((item) => !item.ok && item.blocking);
      if (contractTypeFailure)
        throw new IgniteError(
          contractTypeFailure.message,
          ErrorCodes.ILLEGAL_RESOLVE,
          { contractTypeCode: contractTypeFailure.code, ...contractTypeFailure.details }
        );
      const dynamic = dynamicDeterministicStepIds(draft.plan, lane.chainId);
      const addresses = (id: string): Hex => {
        const item = draftLane.steps.find((candidate) => candidate.stepId === id);
        const known = item?.address ?? item?.predictedAddress ?? item?.expectedAddress;
        if (!known) throw coded('pointer-unresolved', `Pointer ${id} is unresolved after edit`);
        return known;
      };
      // A pointer at a produced product that has not run yet is not an edit
      // error: its address is derived by the producer call's pre-broadcast
      // simulation, so it is unresolved before the edit and after it alike.
      const pendingProducedProduct = (id: string | undefined): boolean => {
        if (!id) return false;
        const target = draft.plan.steps.find((candidate) => candidate.id === id);
        if (!target || target.kind !== 'deploy' || !isProducedStrategy(target.strategy)) return false;
        const item = draftLane.steps.find((candidate) => candidate.stepId === id);
        return !item?.address && !item?.predictedAddress && !item?.expectedAddress;
      };
      for (let index = draftLane.currentStepIndex; index < draft.plan.steps.length; index += 1) {
        const step = draft.plan.steps[index];
        if (step.kind === 'call') {
          try {
            const fn = callAbiItem(step, lane.chainId, callTargetAbi(draft.plan, step, lane.chainId, draft.inputs));
            resolveStepValues(step, lane.chainId, addresses, fn?.inputs ?? [], { frozen: draft.inputs, contracts: draft.plan.contracts });
          } catch (error) {
            if ((error as { code?: string }).code === 'POINTER_UNRESOLVED' && pendingProducedProduct((error as { details?: { stepId?: string } }).details?.stepId)) continue;
            throw error;
          }
        } else if (isProducedStrategy(step.strategy)) {
          // A produced product has no initcode of its own — the producer call
          // supplies the constructor arguments — so there is nothing to
          // dry-build, and stray legacy args on an UNTOUCHED product must
          // not fail an unrelated edit. But an edit that touches the
          // product's declared args (its verification mapping) must leave a
          // declaration that still encodes against the frozen ABI.
          if (!(step.id in (cmd.edits.argsByStep ?? {}))) continue;
          const input = draft.inputs[step.contractId];
          if (!input) throw new Error(`Frozen input missing for ${step.contractId}`);
          try {
            encodeDeclaredProductArgs(step, input, lane.chainId, addresses, { frozen: draft.inputs, contracts: draft.plan.contracts });
          } catch (error) {
            if ((error as { code?: string }).code === 'POINTER_UNRESOLVED' && pendingProducedProduct((error as { details?: { stepId?: string } }).details?.stepId)) continue;
            throw error;
          }
          continue;
        } else {
          const input = draft.inputs[step.contractId];
          if (!input) throw new Error(`Frozen input missing for ${step.contractId}`);
          try {
            buildInitcode(step, input, lane.chainId, addresses, { frozen: draft.inputs, contracts: draft.plan.contracts });
          } catch (error) {
            const unresolved = (error as { pauseReason?: string }).pauseReason === 'pointer-unresolved' || (error as { code?: string }).code === 'POINTER_UNRESOLVED';
            // A plain-create step is never in `dynamic`, so without the
            // produced carve-out a downstream create pointing at an unrun
            // product would reject EVERY edit — including the edit to the
            // producer's own arguments that the pause is asking for.
            if (unresolved && (dynamic.has(step.id) || pendingProducedProduct((error as { details?: { stepId?: string } }).details?.stepId))) continue;
            throw error;
          }
        }
      }
      const predictions = predictPlanAddresses(draft.plan, draft.inputs, lane.chainId);
      for (const step of draft.plan.steps.slice(draftLane.currentStepIndex)) {
        if (step.kind !== 'deploy' || step.strategy?.kind !== 'plugin') continue;
        const prepared = step.strategy.prepared?.[String(lane.chainId)];
        const next = predictions[step.id];
        if (prepared && next && prepared.initcodeHash.toLowerCase() !== next.initcodeHash.toLowerCase())
          throw new IgniteError('EDIT_REQUIRES_REMINE', ErrorCodes.ILLEGAL_RESOLVE);
      }
      return predictions;
    } catch (error) {
      if (error instanceof IgniteError && (error.message === 'EDIT_REQUIRES_REMINE' || error.code === ErrorCodes.ILLEGAL_RESOLVE)) throw error;
      throw new IgniteError(error instanceof Error ? error.message : 'Edited plan is invalid', ErrorCodes.ILLEGAL_RESOLVE);
    }
  }
  private async mutate(
    profileId: string,
    runId: string,
    fn: (run: RunRecord) => void,
    chainId?: number
  ): Promise<RunRecord> {
    let enteredTerminal = false;
    const next = await this.deps.runStore.mutate(profileId, runId, (run) => {
      const wasTerminal = terminalRunStatus(run.status);
      fn(run);
      run.updatedAt = iso(this.deps.now());
      run.status = runStatus(run);
      enteredTerminal = !wasTerminal && terminalRunStatus(run.status);
      if (enteredTerminal && run.workflow) {
        run.hookRuns ??= {};
        for (const pluginId of run.workflow.hooks)
          run.hookRuns[pluginId] ??= { status: 'pending' };
      }
    });
    if (chainId === undefined) this.events.emitRun(next, this.deps.now());
    else {
      this.events.emitLane(next, chainId, this.deps.now());
      this.events.emitRun(next, this.deps.now());
    }
    if (enteredTerminal) {
      void this.deps.deploymentHooks.dispatch(next).catch((error) =>
        getLogger().warn(`deployment hook dispatch failed for ${next.id}: ${String(error)}`)
      );
    }
    if (
      enteredTerminal ||
      terminal(
        next.lanes[String(chainId ?? -1)] ?? ({ status: 'pending' } as Lane)
      )
    )
      await this.maybeArtifact(next);
    return next;
  }
  private async maybeArtifact(run: RunRecord): Promise<void> {
    if (!Object.values(run.lanes).some(terminal)) return;
    try {
      await this.deps.writeArtifact(run);
    } catch (error) {
      // Record-keeping must never alter lane truth: this runs inside the
      // mutate that just persisted a terminal transition, so a throw here
      // used to propagate into the runLane catch and pause an already
      // completed lane — past its end, where no resolve verb can operate.
      // The artifact renders on demand at the GET endpoint and this write
      // re-runs on any later terminal mutate, so a failure only logs.
      getLogger().warn(
        `deployment artifact write failed for ${run.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  private async requireRun(
    profileId: string,
    runId: string
  ): Promise<RunRecord> {
    const run = await this.deps.runStore.get(profileId, runId);
    if (!run)
      throw new IgniteError(
        'Deployment run not found',
        ErrorCodes.DEPLOYMENT_RUN_NOT_FOUND
      );
    return run;
  }
  private key(profileId: string, runId: string, chainId: number): string {
    return `${profileId}:${runId}:${chainId}`;
  }
  private async queued<T>(
    queues: Map<string, Promise<unknown>>,
    key: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(fn);
    queues.set(key, current);
    try {
      return await current;
    } finally {
      if (queues.get(key) === current) queues.delete(key);
    }
  }
}

function makeLane(chainId: number, plan: DeploymentPlan, predicted?: Record<string, { predictedAddress: Hex }>): Lane {
  const dynamic = dynamicDeterministicStepIds(plan, chainId);
  return {
    chainId,
    status: 'pending',
    currentStepIndex: 0,
    steps: plan.steps.map((step) => ({
      stepId: step.id,
      status: 'pending',
      ...(!dynamic.has(step.id) && predicted?.[step.id] ? { predictedAddress: predicted[step.id]!.predictedAddress } : {}),
      attempts: [],
    })),
  };
}
function dependentPlanStepIds(plan: DeploymentPlan, chainId: number, initial: Set<string>): Set<string> {
  const affected = new Set(initial); let changed = true;
  while (changed) {
    changed = false;
    for (const step of plan.steps) if (!affected.has(step.id) && collectRefs(step, chainId).some((ref) => affected.has(ref.stepId))) {
      affected.add(step.id); changed = true;
    }
  }
  return affected;
}
function terminal(lane: Lane): boolean {
  return lane.status === 'completed' || lane.status === 'aborted';
}

function terminalRunStatus(status: RunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted';
}
function iso(now: number): string {
  return new Date(now).toISOString();
}
function appendLaneStepNote(step: { notes?: string[] }, note: string): void {
  if (step.notes?.includes(note)) return;
  step.notes = [...(step.notes ?? []), note].slice(-8);
}
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      resolve();
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
function coded(reason: PauseReason, message: string): Error {
  return Object.assign(new Error(message), { pauseReason: reason });
}
function classify(error: unknown): PauseReason {
  const codedError = error as {
    pauseReason?: PauseReason;
    code?: unknown;
    message?: unknown;
    name?: unknown;
  };
  if (codedError.pauseReason) return codedError.pauseReason;
  // The canonical resolver wraps unresolved refs in a typed IgniteError; the
  // pause must carry the dedicated reason or its verb set is wrong.
  if (codedError.code === 'POINTER_UNRESOLVED') return 'pointer-unresolved';
  if (codedError.code === ErrorCodes.SIGNER_ADDRESS_MISMATCH)
    return 'signer-mismatch';
  if (codedError.code === ErrorCodes.INSUFFICIENT_FUNDS) return 'balance';
  if (codedError.code === ErrorCodes.RECEIPT_TIMEOUT) return 'receipt-timeout';
  if (
    codedError.code === 'USER_REJECTED' ||
    codedError.code === 4001 ||
    /\b(?:user|transaction|wallet)\s+(?:rejected|denied)\b/i.test(
      String(codedError.message ?? '')
    )
  )
    return 'signer-rejected';
  if (
    /receipt.*(?:timed?\s*out|timeout)/i.test(String(codedError.message ?? ''))
  )
    return 'receipt-timeout';
  return 'broadcast';
}
async function defaultResolveRpcUrl(
  chainId: number,
  endpointId: string
): Promise<ResolvedRpc | undefined> {
  const stored = (await new RpcStore().list(chainId)).find(
    (endpoint) => endpoint.id === endpointId
  );
  const endpoint =
    stored ??
    (
      await RpcProviderService.getInstance().getChainData(chainId)
    ).endpoints.find((item) => item.id === endpointId);
  if (!endpoint) return undefined;
  const crypto = await import('node:crypto');
  return {
    url: endpoint.url,
    fingerprint: crypto.createHash('sha256').update(endpoint.url).digest('hex'),
    label: endpoint.label ?? endpoint.id,
  };
}
async function defaultChainMetadata(chainId: number): Promise<ChainMetadata> {
  const chain = await new ChainRegistry().getChain(chainId);
  return chain
    ? { name: chain.name, nativeCurrency: chain.nativeCurrency }
    : {
        name: `Chain ${chainId}`,
        nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
      };
}
