'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The databases this console watches, and the one place to add or remove
 * one. A database is added in two steps: Test connects the way pgops always
 * will and shows what the server answered, including that the session is read
 * only; Add is the operator's confirmation.
 *
 * Gets names and where each is set, never a URL: props reach the HTML.
 */

const BUTTON = 'rounded-[5px] border bg-card px-2 py-0.5 text-xs/[18px] text-foreground hover:bg-muted disabled:opacity-50 '
  + 'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
const INPUT = 'block w-full rounded-[5px] border bg-card px-2 py-1 font-mono text-xs text-foreground '
  + 'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
const QUIET = 'text-xs text-muted-foreground hover:text-foreground hover:underline';

type Tested = { identity: string; readOnly: boolean };

/** Never rejects: a failed fetch is the outcome, in words. A POST answers what the server said; a DELETE, the name. */
async function send(method: 'POST', body: Record<string, unknown>): Promise<{ ok: true; body: Tested } | { ok: false; error: string }>;
async function send(method: 'DELETE', body: Record<string, unknown>): Promise<{ ok: true; body: { name: string } } | { ok: false; error: string }>;
async function send(method: 'POST' | 'DELETE', body: Record<string, unknown>): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/databases', {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return { ok: true, body: parsed };
    return { ok: false, error: typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function Databases({ databases, actionsOn, savedTo }: {
  databases: { name: string; source: 'env' | 'saved' }[];
  actionsOn: boolean;
  /** The file added databases are saved to. */
  savedTo: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const empty = databases.length === 0;
  // Into the name field: showModal alone focuses the first control, Close.
  const open = (): void => { dialog.current?.showModal(); dialog.current?.querySelector('input')?.focus(); };
  return (
    <>
      <button type="button" className={empty ? `${BUTTON} px-3 py-1 text-sm` : `${BUTTON} ml-auto`} onClick={open}>
        {empty ? 'Add a database' : 'Databases'}
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="databases-title"
        className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border bg-card p-0 text-[13px]/5 text-foreground backdrop:bg-black/40"
      >
        <div className="space-y-4 p-4">
          <div className="flex items-baseline">
            <h2 id="databases-title" className="text-base font-semibold">Databases</h2>
            <button type="button" className={`${QUIET} ml-auto`} onClick={() => dialog.current?.close()}>Close</button>
          </div>
          {empty ? null : <List databases={databases} />}
          <AddForm actionsOn={actionsOn} onAdded={() => dialog.current?.close()} />
          <p className="text-xs text-muted-foreground">Saved to <code className="break-all font-mono">{savedTo}</code>, readable by its owner only.</p>
        </div>
      </dialog>
    </>
  );
}

function List({ databases }: { databases: { name: string; source: 'env' | 'saved' }[] }) {
  return (
    <ul className="divide-y rounded-md border">
      {databases.map((d) => (
        <li key={d.name} className="flex flex-wrap items-baseline gap-2 px-3 py-1.5">
          <span className="font-mono">{d.name}</span>
          {d.source === 'env'
            ? <span className="ml-auto text-xs text-muted-foreground">set in the environment</span>
            : <Remove name={d.name} />}
        </li>
      ))}
    </ul>
  );
}

function Remove({ name }: { name: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (!asking) return <button type="button" className={`${QUIET} ml-auto`} onClick={() => setAsking(true)}>Remove</button>;
  const remove = (): void => startTransition(async () => {
    const r = await send('DELETE', { name });
    if (r.ok) router.refresh();
    else setError(r.error);
  });
  return (
    <span className="ml-auto flex flex-wrap items-baseline gap-2 text-xs">
      <span className="text-muted-foreground">pgops forgets it; nothing is sent to the database.</span>
      <button type="button" className={BUTTON} disabled={pending} onClick={remove}>Remove {name}</button>
      <button type="button" className={QUIET} onClick={() => { setAsking(false); setError(null); }}>Cancel</button>
      {error === null ? null : <span role="alert" className="basis-full text-critical-ink">{error}</span>}
    </span>
  );
}

function AddForm({ actionsOn, onAdded }: { actionsOn: boolean; onAdded: () => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [tested, setTested] = useState<Tested | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A test answers for the name and URL it was run on, so an edit voids it.
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value); setTested(null); setError(null);
  };
  const go = (save: boolean): void => startTransition(async () => {
    const r = await send('POST', { name, url, save });
    if (!r.ok) { setError(r.error); return; }
    if (!save) { setTested(r.body); return; }
    setName(''); setUrl(''); setTested(null);
    onAdded();
    router.refresh();
  });

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); go(false); }}>
      <h3 className="font-medium">Add a database</h3>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Name, as it appears in the console’s URLs</span>
        <input className={INPUT} value={name} onChange={edit(setName)} placeholder="prod" autoComplete="off" spellCheck={false} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">Connection URL</span>
        <input className={INPUT} value={url} onChange={edit(setUrl)} placeholder="postgres://user:password@host:5432/db" autoComplete="off" spellCheck={false} />
      </label>
      <div className="flex justify-end">
        <button type="submit" className={BUTTON} disabled={pending || name === '' || url === ''}>Test connection</button>
      </div>
      {error === null ? null : (
        <p role="alert" className="rounded-md border border-l-[3px] border-l-critical-ink bg-critical-surface px-3 py-2">{error}</p>
      )}
      {tested === null ? null : <Answer tested={tested} actionsOn={actionsOn} pending={pending} add={() => go(true)} name={name} />}
    </form>
  );
}

/** What the server answered, what pgops can and cannot do there, and the confirmation. */
function Answer({ tested, actionsOn, pending, add, name }: {
  tested: Tested; actionsOn: boolean; pending: boolean; add: () => void; name: string;
}) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p><span className="text-muted-foreground">Connected:</span> <span className="font-mono text-xs">{tested.identity}</span></p>
      {tested.readOnly ? (
        <>
          <p>
            <span className="font-medium">Read only.</span> The server reports <code className="font-mono text-xs">transaction_read_only = on</code>{' '}
            for pgops’s session. Every connection pgops opens here is read only, so the server refuses any change to a row or the schema.
          </p>
          <p className="text-muted-foreground">
            {actionsOn
              ? 'Actions are on (PGOPS_ALLOW_ACTIONS): pgops can terminate sessions, run ANALYZE and reset statistics here, each after a confirmation and with an audit record.'
              : 'Actions are off: pgops cannot terminate sessions, run ANALYZE or reset statistics here. They need PGOPS_ALLOW_ACTIONS=true.'}
          </p>
          <div className="flex justify-end">
            <button type="button" className={BUTTON} disabled={pending} onClick={add}>Add {name}</button>
          </div>
        </>
      ) : (
        <p role="alert" className="text-critical-ink">
          The server did not keep pgops’s session read only, so it cannot be added. A pooler can ignore the setting; connect to Postgres directly.
        </p>
      )}
    </div>
  );
}
