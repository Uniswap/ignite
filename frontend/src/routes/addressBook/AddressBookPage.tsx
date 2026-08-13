import { useEffect, useState } from 'react';
import type { AddressBookEntry, AddressBookView, Hex } from '@ignite/api';
import { sanitizeDisplayText } from '@ignite/api';
import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { apiClient } from '../../store/api/client';
import { getRepoName } from '../../utils/repo';

const blankEntry = (): AddressBookEntry => ({ name: '' } as AddressBookEntry);

function sourceLabel(book: AddressBookView): string {
  return book.source.kind === 'local' ? 'Local address book' : getRepoName(book.source.repoPathOrUrl);
}

export default function AddressBookPage() {
  const [books, setBooks] = useState<AddressBookView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<Record<string, AddressBookEntry[]>>({});

  const load = async () => {
    setLoading(true);
    try {
      const response = await apiClient.request('getAddressBook', {});
      if (!('data' in response)) throw new Error(response.message);
      setBooks(response.data.books);
      setEditing(Object.fromEntries(response.data.books.flatMap((book) => book.entries ? [[key(book), book.entries]] : [])));
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const save = async (book: AddressBookView, force = false) => {
    const entries = editing[key(book)] ?? [];
    try {
      const body = { entries, ...(force ? { force: true as const } : { baseHash: book.bookHash }) };
      const response = book.source.kind === 'local'
        ? await apiClient.request('putLocalAddressBook', { body })
        : await apiClient.request('putRepoAddressBook', { body: { ...body, repoPathOrUrl: book.source.repoPathOrUrl } });
      if (!('data' in response)) throw new Error(response.message);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const update = (book: AddressBookView, index: number, patch: Partial<AddressBookEntry>) => {
    const entries = [...(editing[key(book)] ?? [])];
    entries[index] = { ...entries[index]!, ...patch };
    setEditing({ ...editing, [key(book)]: entries });
  };

  return <div className="text-[var(--text)] grid gap-6">
    <div className="flex items-start justify-between gap-3">
      <div><h1 className="page-title">Address book</h1><p className="text-muted mt-2">Reusable contract addresses for deployment arguments.</p></div>
      <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={15} /> Refresh</button>
    </div>
    {error && <div className="card-milky p-3 text-err">{error}</div>}
    {books.map((book) => <section key={key(book)} className="card-milky overflow-hidden">
      <header className="p-5 flex items-center justify-between gap-3"><div><h2 className="font-semibold">{sourceLabel(book)}</h2><p className="mono-data text-muted text-xs mt-1">{book.bookHash.slice(0, 12)}{book.writable ? '' : ' · read-only'}</p></div>{book.writable && !book.error && <button type="button" className="btn btn-sm btn-primary" onClick={() => void save(book)}><Save size={14} /> Save</button>}</header>
      {book.error ? <div className="px-5 pb-5 grid gap-3"><p className="text-sm text-err">{sanitizeDisplayText(book.error)}</p>{book.writable && <button type="button" className="btn btn-secondary justify-self-start" onClick={() => void save(book, true)}>Reset book</button>}</div> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-muted"><tr><th className="px-5 py-2">Name</th><th className="px-3 py-2">Global address</th><th className="px-3 py-2">Per-chain overrides</th><th className="px-3 py-2">Note</th>{book.writable && <th className="px-5 py-2" />}</tr></thead><tbody>{(editing[key(book)] ?? []).map((entry, index) => <tr key={`${entry.name}-${index}`} className="border-t border-white/10"><td className="px-5 py-2">{book.writable ? <input className="input-glass w-40" value={entry.name} onChange={(event) => update(book, index, { name: event.target.value.toLowerCase() })} /> : sanitizeDisplayText(entry.name)}</td><td className="px-3 py-2">{book.writable ? <input className="input-glass mono-data w-80" value={entry.address ?? ''} onChange={(event) => update(book, index, { address: event.target.value as Hex || undefined })} /> : <span className="mono-data">{entry.address}</span>}</td><td className="px-3 py-2">{book.writable ? <input className="input-glass mono-data w-60" placeholder="1=0x..., 10=0x..." value={Object.entries(entry.perChain ?? {}).map(([chain, address]) => `${chain}=${address}`).join(', ')} onChange={(event) => update(book, index, { perChain: Object.fromEntries(event.target.value.split(',').map((part) => part.trim()).filter(Boolean).map((part) => { const [chain, address] = part.split('='); return [chain!.trim(), address!.trim() as Hex]; })) })} /> : <span className="mono-data">{Object.entries(entry.perChain ?? {}).map(([chain, address]) => `${chain}: ${address}`).join(', ')}</span>}</td><td className="px-3 py-2">{book.writable ? <input className="input-glass w-56" value={entry.note ?? ''} onChange={(event) => update(book, index, { note: event.target.value || undefined })} /> : sanitizeDisplayText(entry.note ?? '')}</td>{book.writable && <td className="px-5 py-2"><button type="button" className="btn btn-sm btn-secondary" aria-label={`Delete ${entry.name}`} onClick={() => setEditing({ ...editing, [key(book)]: (editing[key(book)] ?? []).filter((_, item) => item !== index) })}><Trash2 size={14} /></button></td>}</tr>)}</tbody></table>{book.writable && <button type="button" className="btn btn-secondary btn-sm m-5" onClick={() => setEditing({ ...editing, [key(book)]: [...(editing[key(book)] ?? []), blankEntry()] })}><Plus size={14} /> Add entry</button>}</div>}
    </section>)}
  </div>;
}

function key(book: AddressBookView): string { return book.source.kind === 'local' ? 'local' : `repo:${book.source.repoPathOrUrl}`; }
