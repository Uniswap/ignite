import { useMemo } from 'react';
import { parseAbiItem, type AbiFunction } from 'viem';
import type { Hex, Hex32 } from '@ignite/api';
import Select from '../../../components/Select';
import AbiArgField, { type AbiInput } from './AbiArgField';
import { useAppDispatch } from '../../../store';
import { setStrategy } from '../../../store/features/deployments/deployDraftSlice';
import type { DraftDeployExtras } from '../../../store/features/deployments/types';

type FactoryStrategy = Extract<
  DraftDeployExtras['strategy'],
  { kind: 'factory' }
>;

/** Parses a canonical signature into its ABI inputs, ignoring incomplete input. */
function inputsOf(signature: string | undefined): AbiInput[] {
  if (!signature?.trim()) return [];
  try {
    return ((parseAbiItem(`function ${signature.trim()}`) as AbiFunction)
      .inputs ?? []) as AbiInput[];
  } catch {
    return [];
  }
}

export default function FactoryStrategyFields({
  stepId,
  strategy,
}: {
  stepId: string;
  strategy: FactoryStrategy;
}) {
  const dispatch = useAppDispatch();
  // setStrategy replaces the whole strategy, so every edit merges onto the
  // current value rather than needing a reducer per field.
  const update = (patch: Partial<FactoryStrategy>) =>
    dispatch(setStrategy({ stepId, strategy: { ...strategy, ...patch } }));

  const deployInputs = useMemo(
    () => inputsOf(strategy.signature),
    [strategy.signature]
  );
  const predictInputs = useMemo(
    () => inputsOf(strategy.predictSignature),
    [strategy.predictSignature]
  );
  const predictKind = strategy.predictKind ?? 'function';

  return (
    <div className="grid gap-3">
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

      <label className="grid gap-1">
        <span className="eyebrow">Deploy function</span>
        <input
          className="input-glass"
          value={strategy.signature ?? ''}
          placeholder="deploy(address,bytes32)"
          onChange={(event) =>
            update({ signature: event.target.value || undefined })
          }
        />
      </label>

      {deployInputs.length > 0 && (
        <section className="grid gap-2">
          <span className="eyebrow">Factory arguments</span>
          {deployInputs.map((input, index) => {
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

      <label className="grid gap-1">
        <span className="eyebrow">Predicted address</span>
        <Select
          value={predictKind}
          requireSelection
          options={[
            { value: 'function', label: 'Ask the factory (predict function)' },
            { value: 'create2', label: 'Raw CREATE2 (salt)' },
          ]}
          onValueChange={(value) =>
            update({ predictKind: value as 'function' | 'create2' })
          }
        />
        <span className="text-xs text-muted">
          A factory may transform the salt (commonly scoping it to the caller),
          so its own predict helper is authoritative. Use raw CREATE2 only when
          the factory exposes no helper.
        </span>
      </label>

      {predictKind === 'function' ? (
        <>
          <label className="grid gap-1">
            <span className="eyebrow">Predict function</span>
            <input
              className="input-glass"
              value={strategy.predictSignature ?? ''}
              placeholder="predictJar(address,bytes32)"
              onChange={(event) =>
                update({ predictSignature: event.target.value || undefined })
              }
            />
          </label>
          {predictInputs.map((input, index) => {
            const key = input.name || `arg${index}`;
            return (
              <AbiArgField
                key={key}
                input={input}
                fieldKey={key}
                value={strategy.predictArgs?.[key]}
                onChange={(value) =>
                  update({
                    predictArgs: {
                      ...(strategy.predictArgs ?? {}),
                      [key]: value,
                    },
                  })
                }
              />
            );
          })}
        </>
      ) : (
        <label className="grid gap-1">
          <span className="eyebrow">Salt</span>
          <input
            className="input-glass"
            value={strategy.salt ?? ''}
            placeholder="0x… (32 bytes)"
            onChange={(event) =>
              update({
                salt: (event.target.value || undefined) as Hex32 | undefined,
              })
            }
          />
          <span className="text-xs text-muted">
            The product&apos;s creation bytecode is used as-is: raw CREATE2
            cannot reconstruct constructor arguments the factory supplies
            itself.
          </span>
        </label>
      )}
    </div>
  );
}
