import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { AddressBookEntry, AddressBookView } from '@ignite/api';
import { Loader2, Save, X } from 'lucide-react';
import { apiClient } from '../../store/api/client';
import Select from '../../components/Select';
import { getRepoName } from '../../utils/repo';
import AddressBookMergeDialog, {
  type AddressBookMergeConflict,
} from './AddressBookMergeDialog';
import { saveAddressBookWithCas } from './addressBookClient';
import {
  candidateConflicts,
  mergeRunCandidate,
  type RunAddressCandidate,
  uniqueName,
} from './runAddressBook';

type CollisionChoice =
  | { action: 'merge'; chains: Record<string, 'keep' | 'replace'> }
  | { action: 'rename'; name: string };

export default function SaveRunAddressesDialog({
  open,
  onOpenChange,
  candidates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: RunAddressCandidate[];
}) {
  const [books, setBooks] = useState<AddressBookView[]>([]);
  const [targetKey, setTargetKey] = useState('local');
  const [choices, setChoices] = useState<Record<string, CollisionChoice>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [casConflict, setCasConflict] = useState<AddressBookMergeConflict>();
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(undefined);
    void apiClient
      .request('getAddressBook', {})
      .then((response) => {
        if (!('data' in response)) throw new Error(response.message);
        const writable = response.data.books.filter(
          (book) => book.writable && book.entries
        );
        setBooks(writable);
        setTargetKey(
          writable.some((book) => key(book) === 'local')
            ? 'local'
            : writable[0]
              ? key(writable[0])
              : ''
        );
        setChoices({});
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      )
      .finally(() => setLoading(false));
  }, [open]);
  const target = books.find((book) => key(book) === targetKey);
  const collisions = useMemo(
    () =>
      candidates.flatMap((candidate) => {
        const existing = target?.entries?.find(
          (entry) => entry.name === candidate.name
        );
        return existing
          ? [
              {
                candidate,
                existing,
                conflicts: candidateConflicts(existing, candidate),
              },
            ]
          : [];
      }),
    [candidates, target]
  );
  const blocked =
    !target ||
    collisions.some(({ candidate, conflicts }) => {
      const choice = choices[candidate.stepId];
      if (!choice) return true;
      if (choice.action === 'rename')
        return !/^[a-z0-9][a-z0-9-]{0,63}$/.test(choice.name);
      return conflicts.some(({ chainId }) => !choice.chains[chainId]);
    });
  const save = async () => {
    if (!target || blocked) return;
    setLoading(true);
    setError(undefined);
    try {
      const entries = buildEntries(target.entries ?? [], candidates, choices);
      await saveAddressBookWithCas(
        target,
        entries,
        (incoming, current) =>
          new Promise<AddressBookEntry[]>((resolve, reject) =>
            setCasConflict({ incoming, current, resolve, reject })
          )
      );
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <AddressBookMergeDialog
        conflict={casConflict}
        onClose={() => setCasConflict(undefined)}
      />
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="dialog-content glass-overlay"
            style={{ maxWidth: 760, width: '92vw', padding: 24 }}
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <Dialog.Title className="text-lg font-semibold">
                  Save addresses to address book
                </Dialog.Title>
                <Dialog.Description className="text-sm text-muted">
                  Completed deploy lanes are included. Failed and skipped lanes
                  are omitted.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="btn btn-secondary btn-icon"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
            <div className="grid gap-4 max-h-[65vh] overflow-y-auto">
              <label className="grid gap-1">
                <span className="eyebrow">Target book</span>
                <Select
                  requireSelection
                  value={targetKey}
                  options={books.map((book) => ({
                    value: key(book),
                    label:
                      book.source.kind === 'local'
                        ? 'Local address book'
                        : `Repo ${getRepoName(book.source.repoPathOrUrl)}`,
                  }))}
                  onValueChange={(value) => {
                    setTargetKey(value);
                    setChoices({});
                  }}
                />
              </label>
              {candidates.map((candidate) => {
                const collision = collisions.find(
                  (item) => item.candidate.stepId === candidate.stepId
                );
                const choice = choices[candidate.stepId];
                return (
                  <div
                    key={candidate.stepId}
                    className="card-milky p-3 grid gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium mono-data flex-1">
                        {candidate.name}
                      </span>
                      {collision && (
                        <span className="chip chip-warn">name exists</span>
                      )}
                    </div>
                    {Object.entries(candidate.resolutions).map(
                      ([chainId, address]) => (
                        <div
                          key={chainId}
                          className="text-xs mono-data text-muted"
                        >
                          Chain {chainId}: {address}
                        </div>
                      )
                    )}
                    {collision && (
                      <div className="grid gap-2">
                        <label className="flex gap-2 text-sm">
                          <input
                            type="radio"
                            name={`collision-${candidate.stepId}`}
                            checked={choice?.action === 'merge'}
                            onChange={() =>
                              setChoices((current) => ({
                                ...current,
                                [candidate.stepId]: {
                                  action: 'merge',
                                  chains: {},
                                },
                              }))
                            }
                          />
                          Merge into the existing entry
                        </label>
                        {choice?.action === 'merge' &&
                          collision.conflicts.map((conflict) => (
                            <div
                              key={conflict.chainId}
                              className="card-milky p-2 grid gap-1 text-xs"
                            >
                              <div>Chain {conflict.chainId} conflicts</div>
                              <div className="mono-data text-muted">
                                Current: {conflict.current}
                              </div>
                              <div className="mono-data text-muted">
                                Incoming: {conflict.incoming}
                              </div>
                              <div className="flex gap-3">
                                <label className="flex gap-1">
                                  <input
                                    type="radio"
                                    name={`chain-${candidate.stepId}-${conflict.chainId}`}
                                    checked={
                                      choice.chains[conflict.chainId] === 'keep'
                                    }
                                    onChange={() =>
                                      setChoices((current) => ({
                                        ...current,
                                        [candidate.stepId]: {
                                          action: 'merge',
                                          chains: {
                                            ...choice.chains,
                                            [conflict.chainId]: 'keep',
                                          },
                                        },
                                      }))
                                    }
                                  />
                                  Keep current
                                </label>
                                <label className="flex gap-1">
                                  <input
                                    type="radio"
                                    name={`chain-${candidate.stepId}-${conflict.chainId}`}
                                    checked={
                                      choice.chains[conflict.chainId] ===
                                      'replace'
                                    }
                                    onChange={() =>
                                      setChoices((current) => ({
                                        ...current,
                                        [candidate.stepId]: {
                                          action: 'merge',
                                          chains: {
                                            ...choice.chains,
                                            [conflict.chainId]: 'replace',
                                          },
                                        },
                                      }))
                                    }
                                  />
                                  Replace
                                </label>
                              </div>
                            </div>
                          ))}
                        <label className="flex gap-2 text-sm">
                          <input
                            type="radio"
                            name={`collision-${candidate.stepId}`}
                            checked={choice?.action === 'rename'}
                            onChange={() =>
                              setChoices((current) => ({
                                ...current,
                                [candidate.stepId]: {
                                  action: 'rename',
                                  name: nextName(
                                    candidate.name,
                                    target?.entries ?? [],
                                    candidates
                                  ),
                                },
                              }))
                            }
                          />
                          Save under a new name
                        </label>
                        {choice?.action === 'rename' && (
                          <input
                            className="input-glass mono-data"
                            value={choice.name}
                            onChange={(event) =>
                              setChoices((current) => ({
                                ...current,
                                [candidate.stepId]: {
                                  action: 'rename',
                                  name: event.target.value.toLowerCase(),
                                },
                              }))
                            }
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {error && <div className="text-sm text-err">{error}</div>}
            </div>
            <div className="flex justify-end mt-4">
              <button
                type="button"
                className="btn btn-primary"
                disabled={blocked || loading}
                onClick={() => void save()}
              >
                {loading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Save size={14} />
                )}{' '}
                Save addresses
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

export function buildEntries(
  current: AddressBookEntry[],
  candidates: RunAddressCandidate[],
  choices: Record<string, CollisionChoice>
): AddressBookEntry[] {
  const result = current.map((entry) => globalThis.structuredClone(entry));
  for (const candidate of candidates) {
    const index = result.findIndex((entry) => entry.name === candidate.name);
    if (index === -1) {
      result.push(candidate.entry);
      continue;
    }
    const choice = choices[candidate.stepId];
    if (choice?.action === 'rename') {
      result.push({ ...candidate.entry, name: choice.name });
      continue;
    }
    if (choice?.action === 'merge')
      result[index] = mergeRunCandidate(
        result[index]!,
        candidate,
        new Set(
          Object.entries(choice.chains).flatMap(([chainId, action]) =>
            action === 'replace' ? [chainId] : []
          )
        )
      );
  }
  return result;
}

function nextName(
  base: string,
  current: AddressBookEntry[],
  candidates: RunAddressCandidate[]
): string {
  return uniqueName(
    base,
    new Set([
      ...current.map((entry) => entry.name),
      ...candidates.map((candidate) => candidate.name),
    ])
  );
}

function key(book: AddressBookView): string {
  return book.source.kind === 'local'
    ? 'local'
    : `repo:${book.source.repoPathOrUrl}`;
}
