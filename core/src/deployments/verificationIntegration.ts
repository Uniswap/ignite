// Deployment-owned reconciliation for the queue's durable crash window.
// The run record is authoritative; queue tasks are only a derived work list.
import fs from 'node:fs/promises';
import path from 'node:path';
import { encodeAbiParameters, parseTransaction, type Abi, type AbiParameter, type Hex } from 'viem';
import { FileSystem } from '../filesystem/FileSystem.js';
import { RunStore } from './RunStore.js';
import { VerificationQueue } from '../verifications/VerificationQueue.js';
import { getLogger } from '../utils/logger.js';
import { RpcStore } from '../chains/RpcStore.js';
import { decomposeCreationCalldata } from './create2.js';
import { encodeDeclaredProductArgs, isProducedStrategy } from './produced.js';
import { linkBytecode } from './linking.js';
import { resolveStepValues } from './resolver.js';

export function wireVerificationReconciliation(queue: VerificationQueue): void {
  queue.reconcileRuns = async () => {
    const base = FileSystem.getInstance().getIgniteHome();
    let profiles: string[] = [];
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: profiles dir within ~/.ignite
    try { profiles = (await fs.readdir(path.join(base, 'profiles'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { return; }
    const runs = new RunStore();
    const rpcStore = new RpcStore();
    for (const profileId of profiles) {
      const listed = await runs.list(profileId);
      for (const summary of listed.runs) {
        const run = await runs.get(profileId, summary.id);
        if (!run) continue;
        for (const [chainKey, lane] of Object.entries(run.lanes)) {
          if (!run.explorerTargets?.[chainKey]?.length) continue;
          for (const step of lane.steps.filter((item) => item.status === 'confirmed' && item.address)) {
            const planStep = run.plan.steps.find((item) => item.id === step.stepId);
            const attempt = step.attempts.findLast((item) => item.txHash);
            const input = planStep?.kind === 'deploy' ? run.inputs[planStep.contractId] : undefined;
            // Produced products must divert BEFORE the generic decompose path:
            // they can satisfy its guards while their producer's calldata is a
            // call, not creation calldata.
            if (planStep?.kind === 'deploy' && isProducedStrategy(planStep.strategy) && input && step.address) {
              // Produced products confirm with no creation calldata of their
              // own (they carry no transaction at all), so reconciliation
              // mirrors the engine: encode the DECLARED constructor args
              // against the frozen ABI and attribute the producer call's
              // transaction hash.
              const strategy = planStep.strategy;
              let encoded: Hex | undefined;
              try {
                encoded = encodeDeclaredProductArgs(planStep, input, Number(chainKey), (id) => {
                  const ref = lane.steps.find((entry) => entry.stepId === id);
                  if (ref?.address) return ref.address;
                  const standIn = ref?.predictedAddress ?? ref?.expectedAddress;
                  if (standIn && ref!.status !== 'skipped' && ref!.status !== 'failed') return standIn;
                  throw new Error(`Pointer ${id} is unresolved`);
                }, { frozen: run.inputs, contracts: run.plan.contracts });
              } catch { encoded = undefined; }
              const creationTxHash = attempt?.txHash
                ?? lane.steps.find((entry) => entry.stepId === strategy.producedBy.stepId)?.attempts.findLast((item) => item.txHash)?.txHash;
              if (encoded === undefined || !creationTxHash) {
                getLogger().warn(`verification reconciliation skipped produced product ${step.stepId}: ${encoded === undefined ? 'constructor arguments are not declared' : 'the producer call has no transaction hash'}`);
                continue;
              }
              await queue.enqueueForConfirmedStep(profileId, run, Number(chainKey), step.stepId, planStep.contractId, step.address, creationTxHash, encoded);
              continue;
            }
            if (!planStep || planStep.kind !== 'deploy' || !attempt?.txHash || !attempt.expected || !input || !step.address) continue;
            const rpc = run.rpcSelection[chainKey];
            if (!rpc) continue;
            let data: Hex | undefined;
            try {
              const endpoint = (await rpcStore.list(Number(chainKey))).find((item) => item.id === rpc.endpointId);
              if (endpoint) {
                const response = await fetch(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [attempt.txHash] }) });
                const json = await response.json() as { result?: { input?: string } };
                if (typeof json.result?.input === 'string') data = json.result.input as Hex;
              }
            } catch { /* raw signed transaction fallback below */ }
            if (!data && attempt.rawTx) try { data = parseTransaction(attempt.rawTx).data as Hex | undefined; } catch { /* skip */ }
            if (!data) continue;
            const linked = input.creationCodeLinkReferences
              ? linkBytecode(input.creationBytecode, input.creationCodeLinkReferences, attempt.expected.libraries ?? {})
              : input.creationBytecode as Hex;
            const strategy = !planStep.strategy || planStep.strategy.kind === 'create' ? 'create' : 'create2';
            const decomposition = decomposeCreationCalldata(data, linked, strategy);
            if (!decomposition) {
              getLogger().warn(`verification reconciliation skipped ${attempt.txHash}: transaction data unavailable or calldata mismatch`);
              continue;
            }
            await queue.enqueueForConfirmedStep(profileId, run, Number(chainKey), step.stepId, planStep.contractId, step.address, attempt.txHash, decomposition.constructorData, attempt.expected.libraries);
            if (planStep.wraps && step.captured) {
              const type = run.contractTypes?.[planStep.wraps.contractTypePluginId];
              if (type) {
                const ctor = ((input.abi as Abi).find((item) => item.type === 'constructor')?.inputs ?? []) as readonly AbiParameter[];
                const resolved = resolveStepValues(planStep, Number(chainKey), (stepId) => {
                  const value = lane.steps.find((entry) => entry.stepId === stepId);
                  if (!value?.address) throw new Error(`Pointer ${stepId} is unresolved`);
                  return value.address;
                }, ctor, { frozen: run.inputs, contracts: run.plan.contracts });
                for (const capture of type.descriptor.capture) {
                  if (!capture.derivedCreate || !capture.record || !capture.verifyAs || !step.captured[capture.record]) continue;
                  const artifact = type.artifacts[capture.verifyAs];
                  if (!artifact) continue;
                  const adminCtor = ((artifact.abi as Abi).find((item) => item.type === 'constructor')?.inputs ?? []) as readonly AbiParameter[];
                  const values = (capture.constructorArgs ?? []).map((param) => {
                    const synthesis = type.descriptor.synthesis?.constructorArgs.find((entry) => entry.from === 'param' && entry.param === param);
                    if (!synthesis || !(synthesis.name in resolved.args)) throw new Error(`Capture constructor argument ${param} is unresolved`);
                    return resolved.args[synthesis.name];
                  });
                  await queue.enqueueContractTypeCapture(profileId, run, Number(chainKey), planStep.id, planStep.contractId, capture.record, step.captured[capture.record], artifact, encodeAbiParameters(adminCtor, values as readonly unknown[]));
                }
              }
            }
          }
        }
      }
    }
  };
}
