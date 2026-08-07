import { useMemo } from 'react';
import type { ArtifactData, Hex } from '@ignite/api';
import Select from '../../../components/Select';
import AbiArgField, { type AbiInput } from './AbiArgField';
import { useAppDispatch, useAppSelector } from '../../../store';
import { useDeploymentArtifacts } from '../useDeploymentArtifacts';
import { setStrategy } from '../../../store/features/deployments/deployDraftSlice';
import type { DraftDeployExtras } from '../../../store/features/deployments/types';
import {
  deployCandidates,
  parsedFactoryFunction,
  productsOf,
  type AbiEntry,
} from '../../../utils/factorySignatures';

type FactoryStrategy = Extract<
  DraftDeployExtras['strategy'],
  { kind: 'factory' }
>;

/**
 * The signature keeps its return clause: a deploy function's address-typed
 * outputs are how Ignite knows which contracts the call produces, and what
 * each of them is called. Inputs stay types-only — the storage format of
 * per-step factory strategies already in drafts and workflows.
 */
function signatureOf(entry: AbiEntry): string {
  const inputs = (entry.inputs ?? []).map((input) => input.type).join(',');
  const outputs = (entry.outputs ?? [])
    .map((output) => `${output.type}${output.name ? ` ${output.name}` : ''}`)
    .join(', ');
  return `${entry.name}(${inputs})${outputs ? ` returns (${outputs})` : ''}`;
}

export default function FactoryStrategyFields({
  stepId,
  strategy,
}: {
  stepId: string;
  strategy: FactoryStrategy;
}) {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const { artifacts } = useDeploymentArtifacts(draft.contracts);
  const update = (patch: Partial<FactoryStrategy>) =>
    dispatch(setStrategy({ stepId, strategy: { ...strategy, ...patch } }));

  // The factory's own contract supplies the ABI that drives these pickers, so
  // functions and argument names come from the compiled artifact rather than a
  // typed signature.
  const factoryAbi = strategy.factoryContractId
    ? (artifacts[strategy.factoryContractId] as ArtifactData | undefined)?.abi
    : undefined;
  const candidates = useMemo(() => deployCandidates(factoryAbi), [factoryAbi]);
  const fn = useMemo(
    () => parsedFactoryFunction(strategy.signature),
    [strategy.signature]
  );
  const products = useMemo(
    () => productsOf(strategy.signature),
    [strategy.signature]
  );

  // Other factory steps whose call could deploy this product too — how the
  // second contract from one call rides along with the step that sends it.
  const fulfillers = draft.steps.flatMap((candidate) => {
    if (candidate.id === stepId) return [];
    const other = draft.deployExtras[candidate.id]?.strategy;
    return other?.kind === 'factory' && !other.fulfilledBy && other.signature
      ? [{ value: candidate.id, label: other.signature.split('(')[0] }]
      : [];
  });

  return (
    <div className="grid gap-3">
      {fulfillers.length > 0 && (
        <label className="grid gap-1">
          <span className="eyebrow">Deployed by</span>
          <Select
            value={strategy.fulfilledBy ?? '__own__'}
            requireSelection
            options={[
              { value: '__own__', label: 'Its own factory call' },
              ...fulfillers.map((item) => ({
                value: item.value,
                label: `Another step's call · ${item.label}`,
              })),
            ]}
            onValueChange={(value) =>
              update({ fulfilledBy: value === '__own__' ? undefined : value })
            }
          />
        </label>
      )}

      {!strategy.fulfilledBy && (
        <label className="grid gap-1">
          <span className="eyebrow">Factory contract</span>
          <Select
            value={strategy.factoryContractId ?? ''}
            requireSelection
            placeholder="Which contract is the factory?"
            options={draft.contracts.map((contract) => ({
              value: contract.id,
              label: contract.contractName ?? contract.id,
            }))}
            onValueChange={(value) => update({ factoryContractId: value })}
          />
          <span className="text-xs text-muted">
            Its ABI lists the deploy functions and names their arguments.
          </span>
        </label>
      )}

      {!strategy.fulfilledBy && (
        <label className="grid gap-1">
          <span className="eyebrow">Factory address</span>
          <input
            className="input-glass"
            value={strategy.factoryAddress ?? ''}
            placeholder="0x… (already deployed)"
            onChange={(event) =>
              update({
                factoryAddress: (event.target.value || undefined) as
                  | Hex
                  | undefined,
              })
            }
          />
        </label>
      )}

      <label className="grid gap-1">
        <span className="eyebrow">Deploy function</span>
        {candidates.length > 0 ? (
          <Select
            value={strategy.signature ?? ''}
            requireSelection
            placeholder="Choose the function that deploys"
            options={candidates.map((entry) => {
              const signature = signatureOf(entry);
              const produced = productsOf(signature);
              return {
                value: signature,
                label: `${entry.name}(${(entry.inputs ?? [])
                  .map((input) => input.name || input.type)
                  .join(', ')}) → ${produced.join(', ')}`,
              };
            })}
            onValueChange={(value) =>
              update({ signature: value, output: productsOf(value)[0] })
            }
          />
        ) : (
          <>
            <input
              className="input-glass"
              value={strategy.signature ?? ''}
              placeholder="deploy(address,bytes32) returns (address jar, address releaser)"
              onChange={(event) =>
                update({ signature: event.target.value || undefined })
              }
            />
            <span className="text-xs text-muted">
              Add the factory&apos;s contract to this deployment to pick its
              functions from the ABI instead of typing a signature.
            </span>
          </>
        )}
      </label>

      {products.length > 0 && (
        <label className="grid gap-1">
          <span className="eyebrow">
            {products.length > 1
              ? `This call deploys ${products.length} contracts — which is this step?`
              : 'Deployed contract'}
          </span>
          <Select
            value={strategy.output ?? products[0]}
            requireSelection
            options={products.map((name) => ({ value: name, label: name }))}
            onValueChange={(value) => update({ output: value })}
          />
          {products.length > 1 && !strategy.fulfilledBy && (
            <span className="text-xs text-muted">
              Add a step for each other product and set its “Deployed by” to
              this step, so later calls can point at them.
            </span>
          )}
        </label>
      )}

      {!strategy.fulfilledBy && fn && (fn.inputs ?? []).length > 0 && (
        <section className="grid gap-2">
          <span className="eyebrow">Factory arguments</span>
          {(fn.inputs as AbiInput[]).map((input, index) => {
            const key = input.name || `arg${index}`;
            return (
              <AbiArgField
                key={key}
                input={input}
                fieldKey={key}
                value={strategy.args?.[key]}
                onChange={(value) =>
                  update({ args: { ...(strategy.args ?? {}), [key]: value } })
                }
              />
            );
          })}
        </section>
      )}
    </div>
  );
}
