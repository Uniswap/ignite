import { useEffect } from 'react';
import Switch from '../../../components/Switch';
import PointerValue, { type PointerOption } from './PointerValue';
import {
  shortSignerAddress,
  type SignerAddressOption,
} from '../signerDisplay';

export interface AbiInput {
  name?: string;
  type: string;
  components?: AbiInput[];
}

interface AbiArgFieldProps {
  input: AbiInput;
  fieldKey: string;
  value: unknown;
  // True only on the global argument form: bool fields self-initialize to
  // an explicit false there, never inside sparse per-chain overrides.
  autoDefault?: boolean;
  eligibleSteps?: PointerOption[];
  signerOptions?: SignerAddressOption[];
  onChange: (value: unknown) => void;
}

export function signerFillChoices(
  options: SignerAddressOption[]
): Array<{ address: string; label: string }> {
  const byAddress = new Map<
    string,
    { address: string; chainLabels: Set<string> }
  >();
  for (const option of options) {
    const key = option.address.toLowerCase();
    const current = byAddress.get(key) ?? {
      address: option.address,
      chainLabels: new Set<string>(),
    };
    current.chainLabels.add(option.chainLabel);
    byAddress.set(key, current);
  }
  return [...byAddress.values()].map(({ address, chainLabels }) => ({
    address,
    label: `${[...chainLabels].join(', ')} · ${shortSignerAddress(address)}`,
  }));
}

function SignerFillAction({
  options,
  onFill,
}: {
  options: SignerAddressOption[];
  onFill: (address: string) => void;
}) {
  const choices = signerFillChoices(options);
  if (choices.length === 0) return null;
  if (choices.length === 1) {
    return (
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        aria-label="Fill from effective signer"
        onClick={() => onFill(choices[0].address)}
      >
        Use signer {shortSignerAddress(choices[0].address)}
      </button>
    );
  }
  return (
    <select
      className="input-glass text-xs w-auto"
      aria-label="Fill from effective signer"
      value=""
      onChange={(event) => {
        if (event.target.value) onFill(event.target.value);
      }}
    >
      <option value="">Use signer…</option>
      {choices.map((choice) => (
        <option key={choice.address.toLowerCase()} value={choice.address}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

function inputHint(type: string): string {
  if (/^u?int/.test(type)) return 'Decimal integer';
  if (type === 'address') return '0x… address';
  if (/^bytes/.test(type)) return '0x… hex bytes';
  if (type.endsWith(']')) return 'JSON array';
  return type;
}

function validationMessage(type: string, value: string): string | undefined {
  if (!value) return undefined;
  if (/^uint/.test(type) && !/^\d+$/.test(value))
    return 'Enter a non-negative decimal integer.';
  if (/^int/.test(type) && !/^-?\d+$/.test(value))
    return 'Enter a decimal integer.';
  if (type === 'address' && !/^0x[0-9a-fA-F]{40}$/.test(value))
    return 'Enter a 20-byte 0x address.';
  if (/^bytes/.test(type)) {
    const fixed = type.match(/^bytes([0-9]+)$/)?.[1];
    if (fixed && value.length !== 2 + Number(fixed) * 2)
      return `Enter exactly ${fixed} bytes.`;
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value))
      return 'Enter even-length 0x-prefixed hex bytes.';
  }
  if (type.endsWith(']')) {
    try {
      if (!Array.isArray(JSON.parse(value))) return 'Enter a JSON array.';
    } catch {
      return 'Enter a valid JSON array.';
    }
  }
  return undefined;
}

function BoolArgField({
  label,
  value,
  autoDefault,
  onChange,
}: {
  label: string;
  value: unknown;
  autoDefault: boolean;
  onChange: (value: unknown) => void;
}) {
  // An untouched GLOBAL switch must still contribute an explicit `false` —
  // otherwise validation reports the field missing and the user has to
  // toggle true-and-back just to deploy with false. Per-chain override
  // fields must NOT auto-write: that would turn "no override" into an
  // explicit false override on every chain whose expander was opened.
  useEffect(() => {
    if (autoDefault && value === undefined) onChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="grid gap-1">
      <span className="text-sm font-medium">{label}</span>
      <Switch
        label={`${label} (bool)`}
        checked={value === true || value === 'true'}
        onCheckedChange={onChange}
      />
    </div>
  );
}

export default function AbiArgField({
  input,
  fieldKey,
  value,
  autoDefault = false,
  eligibleSteps,
  signerOptions = [],
  onChange,
}: AbiArgFieldProps) {
  const label = input.name || fieldKey;
  if (input.type === 'bool') {
    return (
      <BoolArgField
        label={label}
        value={value}
        autoDefault={autoDefault}
        onChange={onChange}
      />
    );
  }

  if (input.type.startsWith('tuple') && !input.type.endsWith(']')) {
    const tuple =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : {};
    return (
      <fieldset className="card-milky p-3 grid gap-3">
        <legend className="text-sm font-medium px-1">
          {label} <span className="mono-data text-muted">{input.type}</span>
        </legend>
        {(input.components ?? []).map((component, index) => {
          const key = component.name || `arg${index}`;
          return (
            <AbiArgField
              key={key}
              input={component}
              fieldKey={key}
              value={tuple[key]}
              autoDefault={autoDefault}
              eligibleSteps={eligibleSteps}
              signerOptions={signerOptions}
              onChange={(next) => onChange({ ...tuple, [key]: next })}
            />
          );
        })}
      </fieldset>
    );
  }

  const stringValue =
    value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  const invalid = validationMessage(input.type, stringValue);
  if (input.type === 'address') {
    const literal = typeof value === 'string' ? value : '';
    const ref =
      value && typeof value === 'object' && '$ref' in value
        ? (value as { $ref: { kind: 'step'; stepId: string } })
        : undefined;
    return (
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-sm font-medium">
            {label} <span className="mono-data text-muted">{input.type}</span>
          </span>
          <SignerFillAction options={signerOptions} onFill={onChange} />
        </div>
        {eligibleSteps && (
          <PointerValue
            value={ref ?? literal}
            onChange={onChange}
            eligibleSteps={eligibleSteps}
          />
        )}
        {!ref && (
          <input
            className="input-glass"
            value={literal}
            placeholder={inputHint(input.type)}
            aria-invalid={Boolean(invalid)}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        {invalid && !ref && <span className="text-xs text-err">{invalid}</span>}
      </div>
    );
  }
  return (
    <label className="grid gap-1">
      <span className="text-sm font-medium">
        {label} <span className="mono-data text-muted">{input.type}</span>
      </span>
      <input
        className="input-glass"
        value={stringValue}
        placeholder={inputHint(input.type)}
        inputMode={/^u?int/.test(input.type) ? 'numeric' : undefined}
        aria-invalid={Boolean(invalid)}
        onChange={(event) => {
          const next = event.target.value;
          if (input.type.endsWith(']')) {
            try {
              onChange(JSON.parse(next));
            } catch {
              onChange(next);
            }
          } else {
            onChange(next);
          }
        }}
      />
      {invalid && <span className="text-xs text-err">{invalid}</span>}
    </label>
  );
}
