import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { AddressBookEntry } from '@ignite/api';
import { X } from 'lucide-react';

export interface AddressBookMergeConflict {
  incoming: AddressBookEntry[];
  current: AddressBookEntry[];
  resolve: (entries: AddressBookEntry[]) => void;
  reject: (reason?: unknown) => void;
}

export default function AddressBookMergeDialog({
  conflict,
  onClose,
}: {
  conflict?: AddressBookMergeConflict;
  onClose: () => void;
}) {
  const names = useMemo(
    () => [
      ...new Set([
        ...(conflict?.current.map((entry) => entry.name) ?? []),
        ...(conflict?.incoming.map((entry) => entry.name) ?? []),
      ]),
    ],
    [conflict]
  );
  const [choices, setChoices] = useState<
    Record<string, 'incoming' | 'current'>
  >({});
  useEffect(() => {
    setChoices(Object.fromEntries(names.map((name) => [name, 'incoming'])));
  }, [names]);
  const close = () => {
    conflict?.reject(new Error('Address book merge cancelled.'));
    onClose();
  };
  const confirm = () => {
    if (!conflict) return;
    const entries = names.flatMap((name) => {
      const list =
        choices[name] === 'current' ? conflict.current : conflict.incoming;
      const entry = list.find((candidate) => candidate.name === name);
      return entry ? [entry] : [];
    });
    conflict.resolve(entries);
    onClose();
  };
  return (
    <Dialog.Root
      open={Boolean(conflict)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content glass-overlay"
          style={{ maxWidth: 760, width: '92vw', padding: 24 }}
        >
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <Dialog.Title className="text-lg font-semibold">
                Merge address book changes
              </Dialog.Title>
              <Dialog.Description className="text-sm text-muted">
                The book changed after it was loaded. Choose the incoming or
                current version for each entry.
              </Dialog.Description>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-icon"
              aria-label="Cancel merge"
              onClick={close}
            >
              <X size={16} />
            </button>
          </div>
          <div className="grid gap-3 max-h-[60vh] overflow-y-auto">
            {names.map((name) => {
              const incoming = conflict?.incoming.find(
                (entry) => entry.name === name
              );
              const current = conflict?.current.find(
                (entry) => entry.name === name
              );
              return (
                <div key={name} className="card-milky p-3 grid gap-2">
                  <div className="font-medium mono-data">{name}</div>
                  <label className="grid grid-cols-[auto_1fr] gap-2 items-start text-sm">
                    <input
                      type="radio"
                      name={`merge-${name}`}
                      checked={choices[name] === 'incoming'}
                      onChange={() =>
                        setChoices((value) => ({
                          ...value,
                          [name]: 'incoming',
                        }))
                      }
                    />
                    <span>
                      <span className="eyebrow block">Incoming</span>
                      {entrySummary(incoming)}
                    </span>
                  </label>
                  <label className="grid grid-cols-[auto_1fr] gap-2 items-start text-sm">
                    <input
                      type="radio"
                      name={`merge-${name}`}
                      checked={choices[name] === 'current'}
                      onChange={() =>
                        setChoices((value) => ({ ...value, [name]: 'current' }))
                      }
                    />
                    <span>
                      <span className="eyebrow block">Current</span>
                      {entrySummary(current)}
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button type="button" className="btn btn-secondary" onClick={close}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={confirm}>
              Merge and retry
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function entrySummary(entry: AddressBookEntry | undefined): string {
  if (!entry) return 'Entry deleted';
  return [
    entry.address ? `global ${entry.address}` : undefined,
    ...Object.entries(entry.perChain ?? {}).map(
      ([chainId, address]) => `${chainId}: ${address}`
    ),
  ]
    .filter(Boolean)
    .join(' · ');
}
