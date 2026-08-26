import { Loader2 } from 'lucide-react';
import type { DeploymentComposerField } from '@ignite/api';
import ArtifactPicker from '../../../components/ArtifactPicker';
import Select from '../../../components/Select';
import { useAppDispatch } from '../../../store';
import {
  setCompositionArtifact,
  setCompositionValue,
} from '../../../store/features/deployments/deployDraftSlice';
import type {
  DeploymentCompositionDraft,
  DraftContract,
} from '../../../store/features/deployments/types';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Whether an artifact field's picker may offer contract-type sources. A
 * declared origin restriction of ['repo'] hides the contract-type section:
 * offering sources the server would reject reads as a broken picker.
 */
export function artifactFieldShowsContractTypes(
  field: Extract<DeploymentComposerField, { type: 'artifact' }>
): boolean {
  return field.origins ? field.origins.includes('contract-type') : true;
}

function ArtifactField({
  field,
  selected,
  onSelect,
}: {
  field: Extract<DeploymentComposerField, { type: 'artifact' }>;
  selected: DraftContract | undefined;
  onSelect: (source: DraftContract) => void;
}) {
  return (
    <section className="grid gap-2">
      <span className="eyebrow">{field.label}</span>
      {selected && (
        <div className="card-milky p-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{selected.contractName}</div>
            <div className="mono-data text-muted truncate">
              {selected.origin === 'contract-type'
                ? `${selected.pluginId} @ ${selected.versionLabel}`
                : selected.sourcePath}
            </div>
          </div>
        </div>
      )}
      {selected ? (
        <details>
          <summary className="text-sm text-muted cursor-pointer">
            Change artifact
          </summary>
          <div className="mt-2">
            <ArtifactPicker
              value={selected}
              showContractTypes={artifactFieldShowsContractTypes(field)}
              onSelect={onSelect}
            />
          </div>
        </details>
      ) : (
        <ArtifactPicker
          showContractTypes={artifactFieldShowsContractTypes(field)}
          onSelect={onSelect}
        />
      )}
      {field.description && (
        <span className="text-xs text-muted">{field.description}</span>
      )}
    </section>
  );
}

export default function ComposerStep({
  composition,
  fields,
  loading,
  error,
  label,
  description,
}: {
  composition: DeploymentCompositionDraft;
  fields: DeploymentComposerField[];
  loading: boolean;
  error?: string;
  label?: string;
  description?: string;
}) {
  const dispatch = useAppDispatch();
  return (
    <section className="grid gap-5">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          {label ?? 'Compose deployment'}
          {loading && <Loader2 size={14} className="animate-spin text-muted" />}
        </h2>
        <p className="text-sm text-muted">
          {description ??
            'Answer the deployment type’s questions; Continue turns them into ordinary call and deploy steps.'}
        </p>
      </div>
      {fields.length === 0 && loading && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading composer…
        </p>
      )}
      {fields.map((field) => {
        if (field.type === 'artifact') {
          return (
            <ArtifactField
              key={field.key}
              field={field}
              selected={composition.artifacts[field.key]}
              onSelect={(source) =>
                dispatch(setCompositionArtifact({ key: field.key, source }))
              }
            />
          );
        }
        if (field.type === 'select') {
          const value = composition.values[field.key];
          return (
            <label key={field.key} className="grid gap-1">
              <span className="eyebrow">{field.label}</span>
              <Select
                value={typeof value === 'string' ? value : undefined}
                requireSelection
                placeholder="Choose…"
                options={field.options}
                onValueChange={(next) =>
                  dispatch(setCompositionValue({ key: field.key, value: next }))
                }
              />
              {field.description && (
                <span className="text-xs text-muted">{field.description}</span>
              )}
            </label>
          );
        }
        const value = composition.values[field.key];
        const text = typeof value === 'string' ? value : '';
        return (
          <label key={field.key} className="grid gap-1">
            <span className="eyebrow">{field.label}</span>
            <input
              className="input-glass"
              value={text}
              placeholder="0x…"
              onChange={(event) =>
                dispatch(
                  setCompositionValue({
                    key: field.key,
                    value: event.target.value || undefined,
                  })
                )
              }
            />
            {text && !ADDRESS.test(text) && (
              <span className="text-xs text-err">
                Enter a 20-byte 0x address.
              </span>
            )}
            {field.description && (
              <span className="text-xs text-muted">{field.description}</span>
            )}
          </label>
        );
      })}
      {error && <p className="text-sm text-err">{error}</p>}
    </section>
  );
}
