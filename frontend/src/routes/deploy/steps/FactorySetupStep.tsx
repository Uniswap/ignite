import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import type { Hex } from '@ignite/api';
import ArtifactPicker from '../../../components/ArtifactPicker';
import Select from '../../../components/Select';
import { useAppDispatch, useAppSelector } from '../../../store';
import {
  setCallStepField,
  setFactoryProduct,
  setFactorySetup,
} from '../../../store/features/deployments/deployDraftSlice';
import type {
  DraftCallStep,
  FactoryDraftSetup,
} from '../../../store/features/deployments/types';
import {
  useDeploymentArtifacts,
  type DeploymentArtifactEntry,
} from '../useDeploymentArtifacts';
import {
  deployCandidates,
  factoryCallSignature,
  productsOf,
} from '../../../utils/factorySignatures';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The first reason the Factory step cannot continue. Address and args move
 * to the generated call step once it exists, so the blocker reads the
 * address from there — the staging copy is deleted at materialization.
 */
export function factorySetupBlocker(
  setup: FactoryDraftSetup | undefined,
  call: DraftCallStep | undefined
): string | undefined {
  if (!setup?.source) return 'Pick the factory contract';
  const address =
    call?.target?.kind === 'address' ? call.target.address : setup.address;
  if (!address || !ADDRESS.test(address)) return 'Enter the factory address';
  if (!setup.signature) return 'Pick the deploy function';
  const missing = productsOf(setup.signature).filter(
    (output) => !setup.products?.[output]
  );
  if (missing.length > 0)
    return `Map each deployed contract to an artifact: ${missing.join(', ')}`;
  return undefined;
}

export default function FactorySetupStep({
  setup,
  artifactEntries,
  onRetry,
}: {
  setup: FactoryDraftSetup;
  artifactEntries: Record<string, DeploymentArtifactEntry>;
  onRetry: (contractId: string) => void;
}) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const call = draft.steps.find(
    (step): step is DraftCallStep =>
      step.id === setup.callStepId && step.kind === 'call'
  );
  const factoryContracts = useMemo(
    () => (setup.source ? [setup.source] : []),
    [setup.source]
  );
  // The factory's ABI is fetched on demand rather than stored on the draft:
  // persisting ABIs would bloat the saved session for data the server
  // already caches by artifact identity.
  const { artifacts: factoryArtifacts, entries: factoryEntries } =
    useDeploymentArtifacts(factoryContracts);
  const factoryAbi = setup.source
    ? factoryArtifacts[setup.source.id]?.abi
    : undefined;
  const candidates = useMemo(() => deployCandidates(factoryAbi), [factoryAbi]);
  const outputs = useMemo(() => productsOf(setup.signature), [setup.signature]);
  const factoryEntry = setup.source
    ? factoryEntries[setup.source.id]
    : undefined;
  const address =
    call?.target?.kind === 'address' ? call.target.address : setup.address;
  const setAddress = (value: string) => {
    if (call) {
      dispatch(
        setCallStepField({
          id: call.id,
          patch: {
            target: { kind: 'address', address: (value || '0x') as Hex },
          },
        })
      );
    } else {
      dispatch(
        setFactorySetup({ address: (value || undefined) as Hex | undefined })
      );
    }
  };

  return (
    <section className="grid gap-5">
      <div>
        <h2 className="text-lg font-semibold">Factory</h2>
        <p className="text-sm text-muted">
          Call an already-deployed factory and track every contract that call
          creates. The factory&apos;s ABI drives everything below.
        </p>
      </div>

      <section className="grid gap-2">
        <span className="eyebrow">Factory contract</span>
        {setup.source && (
          <div className="card-milky p-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {setup.source.contractName}
              </div>
              <div className="mono-data text-muted truncate">
                {setup.source.origin === 'contract-type'
                  ? `${setup.source.pluginId} @ ${setup.source.versionLabel}`
                  : setup.source.sourcePath}
              </div>
            </div>
            {factoryEntry?.status === 'loading' && (
              <span className="text-xs text-muted flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" /> Loading ABI…
              </span>
            )}
          </div>
        )}
        {setup.source ? (
          <details>
            <summary className="text-sm text-muted cursor-pointer">
              Change factory contract
            </summary>
            <div className="mt-2">
              <ArtifactPicker
                value={setup.source}
                showContractTypes={false}
                onSelect={(contract) =>
                  dispatch(setFactorySetup({ source: contract }))
                }
              />
            </div>
          </details>
        ) : (
          <ArtifactPicker
            showContractTypes={false}
            onSelect={(contract) =>
              dispatch(setFactorySetup({ source: contract }))
            }
          />
        )}
        <span className="text-xs text-muted">
          The factory itself is not deployed by this run — its ABI names the
          deploy functions and their arguments.
        </span>
      </section>

      <label className="grid gap-1">
        <span className="eyebrow">Factory address</span>
        <input
          className="input-glass"
          value={!address || address === '0x' ? '' : address}
          placeholder="0x… (already deployed)"
          onChange={(event) => setAddress(event.target.value)}
        />
        <span className="text-xs text-muted">
          Where the factory already lives. Per-chain overrides can be set on the
          generated call step in Steps.
        </span>
      </label>

      {setup.source && (
        <label className="grid gap-1">
          <span className="eyebrow">Deploy function</span>
          {candidates.length > 0 ? (
            <Select
              value={setup.signature ?? ''}
              requireSelection
              placeholder="Choose the function that deploys"
              options={candidates.map((entry) => {
                const signature = factoryCallSignature(entry);
                return {
                  value: signature,
                  label: `${entry.name}(${(entry.inputs ?? [])
                    .map((input) => input.name || input.type)
                    .join(
                      ', '
                    )}) → deploys ${productsOf(signature).join(', ')}`,
                };
              })}
              onValueChange={(value) => {
                const entry = candidates.find(
                  (candidate) => factoryCallSignature(candidate) === value
                );
                dispatch(
                  setFactorySetup({
                    signature: value,
                    payable: entry?.stateMutability === 'payable',
                  })
                );
              }}
            />
          ) : factoryEntry?.status === 'ready' ? (
            <span className="text-sm text-warn">
              This ABI has no state-changing function that returns an address,
              so it cannot act as a factory here.
            </span>
          ) : (
            <span className="text-sm text-muted">
              Deploy functions appear once the ABI loads.
            </span>
          )}
        </label>
      )}

      {outputs.length > 0 && (
        <section className="grid gap-2">
          <span className="eyebrow">
            This call deploys {outputs.length}{' '}
            {outputs.length === 1 ? 'contract' : 'contracts'}:{' '}
            {outputs.join(', ')}
          </span>
          {outputs.map((output) => {
            const mapped = setup.products?.[output];
            const contractId = mapped ? `${mapped.id}:${output}` : undefined;
            const entry = contractId ? artifactEntries[contractId] : undefined;
            return (
              <div key={output} className="card-milky p-3 grid gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="mono-data font-medium">{output}</span>
                  {mapped && (
                    <span className="text-sm">→ {mapped.contractName}</span>
                  )}
                  {entry?.status === 'loading' && (
                    <span className="text-xs text-muted flex items-center gap-1">
                      <Loader2 size={12} className="animate-spin" /> Loading
                      artifact…
                    </span>
                  )}
                  {entry?.status === 'error' && (
                    <span className="text-xs text-err flex items-center gap-2">
                      {entry.message}
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => onRetry(contractId!)}
                      >
                        Retry
                      </button>
                    </span>
                  )}
                </div>
                {mapped ? (
                  <details>
                    <summary className="text-sm text-muted cursor-pointer">
                      Change artifact
                    </summary>
                    <div className="mt-2">
                      <ArtifactPicker
                        value={mapped}
                        showContractTypes={false}
                        onSelect={(contract) =>
                          dispatch(
                            setFactoryProduct({ output, source: contract })
                          )
                        }
                      />
                    </div>
                  </details>
                ) : (
                  <ArtifactPicker
                    showContractTypes={false}
                    onSelect={(contract) =>
                      dispatch(setFactoryProduct({ output, source: contract }))
                    }
                  />
                )}
              </div>
            );
          })}
          <span className="text-xs text-muted">
            The call&apos;s arguments are filled on its Factory call card in
            Steps, with pointers, signer fill and per-chain overrides.
          </span>
        </section>
      )}
    </section>
  );
}
