import { useEffect, useMemo, useState } from 'react';
import type { Abi } from 'viem';
import { decodeEventLog } from 'viem';
import type { ChainChecklist, ChainInfo, DeploymentPlan, FrozenInputs, RpcSelection, SimulatedLog, SimulationStepResult, StorageSlotChangesData, ValidationItem } from '@ignite/api';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { replaceIdsForDisplay } from '../../../utils/displayText';
import { apiClient } from '../../../store/api/client';

const ITEM_KEYS = [
  'rpc',
  'signers',
  'args',
  'estimation',
  'balance',
  'inputs',
  'verification',
  'create2',
  'simulation',
] as const;

interface ValidationChecklistProps {
  chains: Record<string, ChainChecklist>;
  chainInfo: ChainInfo[];
  stepLabels?: Record<string, string>;
  onAcknowledge?: (chainId: number, item: ValidationItem) => void;
  run?: { workflow?: ValidationItem; outputs?: ValidationItem };
  onAcceptArtifactDrift?: (
    drifts: Array<{ sourceId: string; expected: string; actual: string }>
  ) => void;
  plan?: DeploymentPlan;
  rpcSelection?: RpcSelection;
  frozenInputs?: FrozenInputs;
  storageResetKey?: unknown;
}

function formatValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([key, entry]) => `${key}: ${formatValue(entry)}`).join(', ')} }`;
  return String(value);
}

function knownEvent(log: SimulatedLog, abis: Abi[], abiByAddress: Map<string, Abi>): string | undefined {
  const knownAbi = abiByAddress.get(log.address.toLowerCase());
  for (const abi of knownAbi ? [knownAbi] : abis) {
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], strict: false });
      const args = Object.entries(decoded.args ?? {}).map(([key, value]) => `${key}: ${formatValue(value)}`).join(', ');
      return `${decoded.eventName}(${args})`;
    } catch {
      // An ABI that does not define this topic is expected while scanning the
      // draft's frozen contracts.
    }
  }
  return undefined;
}

export function signatureFallback(signature: string | undefined, log: SimulatedLog): { label: string; raw: string } {
  return {
    label: signature ?? 'Raw event',
    raw: `topics: ${log.topics.join(', ') || 'none'}\ndata: ${log.data}`,
  };
}

function EventLogs({ logs, abis, abiByAddress }: { logs: SimulatedLog[] | undefined; abis: Abi[]; abiByAddress: Map<string, Abi> }) {
  const [signatures, setSignatures] = useState<Record<string, string | undefined>>({});
  const loadUnknown = () => {
    if (!logs) return;
    const topic0s = [...new Set(logs.flatMap((log) => knownEvent(log, abis, abiByAddress) || !log.topics[0] ? [] : [log.topics[0]]))]
      .filter((topic): topic is `0x${string}` => signatures[topic] === undefined && !Object.prototype.hasOwnProperty.call(signatures, topic));
    if (!topic0s.length) return;
    void Promise.all(topic0s.map(async (topic) => {
      try {
        const response = await apiClient.request('lookupEventSignature', { query: { topic0: topic as `0x${string}` } });
        return [topic, 'data' in response ? response.data.signature : undefined] as const;
      } catch {
        return [topic, undefined] as const;
      }
    })).then((results) => setSignatures((current) => ({ ...current, ...Object.fromEntries(results) })));
  };
  return <details className="text-xs text-muted mt-2" onToggle={(event) => { if (event.currentTarget.open) loadUnknown(); }}>
    <summary className="cursor-pointer">Events{logs ? ` (${logs.length})` : ''}</summary>
    {!logs ? <div className="mt-1">Events need a simulating tier.</div> : logs.length === 0 ? <div className="mt-1">No events were emitted.</div> : <div className="mt-2 max-h-48 overflow-y-auto grid gap-2 pr-1">
      {logs.map((log, index) => {
        const decoded = knownEvent(log, abis, abiByAddress);
        const signature = !decoded && log.topics[0] ? signatures[log.topics[0]] : undefined;
        const fallback = !decoded ? signatureFallback(signature, log) : undefined;
        return <div key={`${log.address}-${index}`} className="rounded border border-white/10 p-2 mono-data">
          <div>{decoded ?? fallback!.label}</div>
          {!decoded && <div className="break-all mt-1">topics: {log.topics.join(', ') || 'none'}<br />data: {log.data}</div>}
          <div className="break-all mt-1 text-muted">from {log.address}</div>
        </div>;
      })}
    </div>}
  </details>;
}

function StorageChanges({ plan, rpcSelection, loading, result, onLoad }: { plan?: DeploymentPlan; rpcSelection?: RpcSelection; loading: boolean; result?: { data?: StorageSlotChangesData; error?: string }; onLoad: () => void }) {
  const data = result?.data;
  const error = result?.error;
  return <div className="mt-2">
    <button type="button" className="btn btn-sm btn-secondary" disabled={!plan || !rpcSelection || loading} onClick={onLoad}>{loading ? 'Getting storage changes…' : 'Get storage slot changes'}</button>
    {error && <div className="text-xs text-err mt-1">{error}</div>}
    {data && <details className="text-xs text-muted mt-2">
      <summary className="cursor-pointer">Storage slot changes</summary>
      <div className="mt-2 max-h-48 overflow-y-auto grid gap-2 pr-1">{Object.entries(data.storage).sort(([left], [right]) => left.toLowerCase() === data.target?.toLowerCase() ? -1 : right.toLowerCase() === data.target?.toLowerCase() ? 1 : left.localeCompare(right)).map(([address, changes]) => <div key={address} className="rounded border border-white/10 p-2 mono-data"><div className="break-all">{address}</div>{changes.length ? changes.map((change) => <div key={change.slot} className="break-all mt-1">slot {change.slot}<br />before {change.before}<br />after {change.after}</div>) : <div className="mt-1">No storage slots changed.</div>}</div>)}</div>
    </details>}
  </div>;
}

function simulationSteps(details: Record<string, unknown> | undefined): Record<string, SimulationStepResult> {
  if (!details || !details.perStep || typeof details.perStep !== 'object') return {};
  return details.perStep as Record<string, SimulationStepResult>;
}

function eventAbiByAddress(
  plan: DeploymentPlan | undefined,
  frozenInputs: FrozenInputs | undefined,
  chains: Record<string, ChainChecklist>,
): Map<string, Abi> {
  const byAddress = new Map<string, Abi>();
  if (!plan || !frozenInputs) return byAddress;
  const abiByStep = new Map(
    plan.steps.flatMap((step) =>
      step.kind === 'deploy' && Array.isArray(frozenInputs[step.contractId]?.abi)
        ? [[step.id, frozenInputs[step.contractId]!.abi as Abi] as const]
        : [],
    ),
  );
  for (const checklist of Object.values(chains)) {
    const predicted = checklist.create2?.details?.predicted;
    if (!predicted || typeof predicted !== 'object' || Array.isArray(predicted)) continue;
    for (const [stepId, entry] of Object.entries(predicted as Record<string, unknown>)) {
      const address = entry && typeof entry === 'object'
        ? (entry as { predictedAddress?: unknown }).predictedAddress
        : undefined;
      const abi = abiByStep.get(stepId);
      if (typeof address === 'string' && abi) byAddress.set(address.toLowerCase(), abi);
    }
  }
  return byAddress;
}

export function artifactDrifts(item: {
  code?: string;
  details?: Record<string, unknown>;
}): Array<{ sourceId: string; expected: string; actual: string }> {
  if (
    item.code !== 'WORKFLOW_ARTIFACT_DRIFT' ||
    !Array.isArray(item.details?.drifts)
  )
    return [];
  return item.details.drifts.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    return typeof value.sourceId === 'string' &&
      typeof value.expected === 'string' &&
      typeof value.actual === 'string'
      ? [
          {
            sourceId: value.sourceId,
            expected: value.expected,
            actual: value.actual,
          },
        ]
      : [];
  });
}

export function simulationTierLabel(tier: unknown): string | undefined {
  if (tier === 'simulateV1') return 'Simulated on-chain (eth_simulateV1)';
  if (tier === 'fork') return 'Simulated on local fork';
  if (tier === 'estimate') return 'Per-transaction estimates';
  return undefined;
}

function detailGas(
  details: Record<string, unknown> | undefined
): Array<[string, string]> {
  if (!details) return [];
  const gas = details.perStep ?? details.gas ?? details.gasByStep;
  if (!gas || typeof gas !== 'object') return [];
  return Object.entries(gas as Record<string, unknown>).flatMap(
    ([stepId, value]) =>
      typeof value === 'string' || typeof value === 'number'
        ? [[stepId, String(value)]]
        : value &&
            typeof value === 'object' &&
            typeof (value as { gasUsed?: unknown }).gasUsed === 'string'
          ? [[stepId, (value as { gasUsed: string }).gasUsed]]
          : []
  );
}

function simulationWarnings(
  details: Record<string, unknown> | undefined
): string[] {
  if (!details) return [];
  const explicit = Array.isArray(details.warnings)
    ? details.warnings.filter(
        (warning): warning is string => typeof warning === 'string'
      )
    : [];
  const perStep = details.perStep;
  const dependent =
    perStep && typeof perStep === 'object'
      ? Object.entries(perStep as Record<string, unknown>).flatMap(
          ([stepId, value]) =>
            value &&
            typeof value === 'object' &&
            (value as { reason?: unknown }).reason ===
              'SIMULATION_UNAVAILABLE_DEPENDENT'
              ? [
                  `SIMULATION_UNAVAILABLE_DEPENDENT: ${stepId} will resolve at execution`,
                ]
              : []
        )
      : [];
  return [...new Set([...explicit, ...dependent])].filter((warning) =>
    warning.includes('SIMULATION_UNAVAILABLE_DEPENDENT')
  );
}

export default function ValidationChecklist({
  chains,
  chainInfo,
  stepLabels = {},
  onAcknowledge,
  run,
  onAcceptArtifactDrift,
  plan,
  rpcSelection,
  frozenInputs,
  storageResetKey,
}: ValidationChecklistProps) {
  const eventAbis = Object.values(frozenInputs ?? {}).flatMap((input) => Array.isArray(input.abi) ? [input.abi as Abi] : []);
  const abiByAddress = useMemo(
    () => eventAbiByAddress(plan, frozenInputs, chains),
    [chains, frozenInputs, plan],
  );
  const [storageResults, setStorageResults] = useState<Record<string, { data?: StorageSlotChangesData; error?: string }>>({});
  const [storageLoading, setStorageLoading] = useState(false);
  useEffect(() => {
    setStorageResults({});
  }, [plan, rpcSelection, storageResetKey]);
  const loadStorage = async (chainId: number, stepId: string, baseBlock: number | undefined) => {
    if (!plan || !rpcSelection || storageLoading) return;
    const key = `${chainId}:${stepId}`;
    setStorageLoading(true);
    setStorageResults((current) => ({ ...current, [key]: {} }));
    try {
      const response = await apiClient.request('getStorageSlotChanges', {
        body: { plan, rpcSelection, chainId, stepId, ...(baseBlock === undefined ? {} : { baseBlock }) },
      });
      if (!('data' in response)) throw new Error(response.message);
      setStorageResults((current) => ({ ...current, [key]: { data: response.data } }));
    } catch (cause) {
      setStorageResults((current) => ({ ...current, [key]: { error: cause instanceof Error ? cause.message : String(cause) } }));
    } finally {
      setStorageLoading(false);
    }
  };
  return (
    <div className="grid gap-3">
      {run && (run.workflow || run.outputs) && (
        <section className="card-milky p-4">
          <h3 className="font-semibold mb-3">Run</h3>
          <div className="glass-list">
            {(['workflow', 'outputs'] as const).map((key) => {
              const item = run[key];
              if (!item) return null;
              const failed = item.blocking && !item.ok;
              return (
                <div key={key} className="list-row flex items-start gap-3">
                  {failed ? (
                    <CircleAlert size={17} className="text-err mt-0.5" />
                  ) : item.ok ? (
                    <CheckCircle2 size={17} className="text-ok mt-0.5" />
                  ) : (
                    <CircleAlert size={17} className="text-warn mt-0.5" />
                  )}
                  <div>
                    <div className="text-sm font-medium capitalize">{key}</div>
                    <div className="text-xs text-muted">{item.message}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {Object.entries(chains).map(([chainId, checklist]) => {
        const chain = chainInfo.find(
          (item) => String(item.chainId) === chainId
        );
        return (
          <section key={chainId} className="card-milky p-4">
            <h3 className="font-semibold mb-3">
              {chain?.name ?? `Chain ${chainId}`}
            </h3>
            <div className="glass-list">
              {ITEM_KEYS.map((key) => {
                const item = checklist[key];
                if (!item) return null;
                const failed = item.blocking && !item.ok;
                const warning = !item.blocking && !item.ok;
                return (
                  <div key={key} className="list-row flex items-start gap-3">
                    {failed ? (
                      <CircleAlert size={17} className="text-err mt-0.5" />
                    ) : warning ? (
                      <CircleAlert size={17} className="text-warn mt-0.5" />
                    ) : (
                      <CheckCircle2
                        size={17}
                        className={
                          item.ok ? 'text-ok mt-0.5' : 'text-warn mt-0.5'
                        }
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium capitalize">
                        {key}
                      </div>
                      <div
                        className="text-xs text-muted"
                        style={{ overflowWrap: 'anywhere' }}
                      >
                        {replaceIdsForDisplay(item.message, stepLabels)}
                      </div>
                      {key === 'simulation' && (
                        <span className="chip chip-info mt-2">
                          {simulationTierLabel(
                            item.details?.tier ?? item.details?.simulationTier
                          ) ?? replaceIdsForDisplay(item.message, stepLabels)}
                        </span>
                      )}
                      {key === 'simulation' && Object.entries(simulationSteps(item.details)).length > 0 && (
                        <div className="grid gap-2 mt-2">
                          {Object.entries(simulationSteps(item.details)).map(([stepId, step]) => (
                            <div key={stepId} className="rounded border border-white/10 p-2">
                              <div className="font-medium">{replaceIdsForDisplay(stepId, stepLabels)}</div>
                              <div className="text-xs text-muted mt-1">Status: {step.status}</div>
                              {step.reason && <div className="text-xs text-warn mt-1">{replaceIdsForDisplay(step.reason, stepLabels)}</div>}
                              {step.gasUsed && <div className="mono-data mt-1">{step.gasUsed} gas</div>}
                              <EventLogs logs={step.logs} abis={eventAbis} abiByAddress={abiByAddress} />
                              {step.status !== 'skipped-existing' && item.details?.tier !== 'estimate' && <StorageChanges
                                plan={plan}
                                rpcSelection={rpcSelection}
                                loading={storageLoading}
                                result={storageResults[`${chainId}:${stepId}`]}
                                onLoad={() => void loadStorage(Number(chainId), stepId, typeof item.details?.baseBlock === 'number' ? item.details.baseBlock : undefined)}
                              />}
                            </div>
                          ))}
                        </div>
                      )}
                      {(key !== 'simulation' || Object.entries(simulationSteps(item.details)).length === 0) && detailGas(item.details).length > 0 && (
                        <details className="text-xs text-muted mt-2">
                          <summary className="cursor-pointer">
                            Per-step gas
                          </summary>
                          {detailGas(item.details).map(([stepId, gas]) => (
                            <div key={stepId} className="mono-data mt-1">
                              {replaceIdsForDisplay(stepId, stepLabels)}: {gas}{' '}
                              gas
                            </div>
                          ))}
                        </details>
                      )}
                      {key === 'simulation' &&
                        simulationWarnings(item.details).map((warning) => (
                          <div key={warning} className="text-xs text-warn mt-1">
                            {replaceIdsForDisplay(warning, stepLabels)}
                          </div>
                        ))}
                      {key === 'args' &&
                        Array.isArray(item.details?.contractTypeItems) && (
                          <div className="grid gap-1 mt-2 text-xs">
                            {(item.details!.contractTypeItems as unknown[]).map((entry, index) => {
                              if (!entry || typeof entry !== 'object') return null;
                              const contractTypeItem = entry as ValidationItem;
                              return <div key={`${contractTypeItem.code}-${index}`} className={contractTypeItem.blocking && !contractTypeItem.ok ? 'text-err' : contractTypeItem.ok ? 'text-muted' : 'text-warn'}>{contractTypeItem.details?.['plugin-declared'] === true && <span className="chip mr-1">plugin-declared</span>}{replaceIdsForDisplay(contractTypeItem.message, stepLabels)}</div>;
                            })}
                          </div>
                        )}
                    </div>
                    {!item.ok &&
                      (item.code === 'CREATE2_ALREADY_DEPLOYED' ||
                        item.code === 'CREATE2_ACK_STALE') &&
                      onAcknowledge && (
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary shrink-0"
                          onClick={() => onAcknowledge(Number(chainId), item)}
                        >
                          {item.code === 'CREATE2_ACK_STALE'
                            ? 'Re-confirm already deployed'
                            : 'Mark as already deployed'}
                        </button>
                      )}
                    {!item.ok &&
                      item.code === 'WORKFLOW_ARTIFACT_DRIFT' &&
                      artifactDrifts(item).length > 0 &&
                      onAcceptArtifactDrift && (
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary shrink-0"
                          onClick={() =>
                            onAcceptArtifactDrift(artifactDrifts(item))
                          }
                        >
                          Accept drifted bytecode
                        </button>
                      )}
                    {!item.ok && item.code === 'UNINITIALIZED_PROXY_ACK_REQUIRED' && onAcknowledge && (
                      <button type="button" className="btn btn-sm btn-secondary shrink-0" onClick={() => onAcknowledge(Number(chainId), item)}>Acknowledge risk</button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
