import { addSigningKeyAction, revokeSigningKeyAction } from "@/app/billing/actions";

type Key = { id: string; public_key: string; created_at: string; revoked_at: string | null };

// The public keys a school's payment claims are checked against. Only public keys
// live here, so nothing on this screen can be used to forge a claim. To rotate,
// add the new key, switch the school over, then revoke the old one.
export function SigningKeys({ schoolId, keys }: { schoolId: string; keys: Key[] }) {
  const active = keys.filter((k) => !k.revoked_at);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-600">
        {active.length === 0
          ? "No key yet, so this school cannot send payment claims."
          : `${active.length} active key${active.length === 1 ? "" : "s"}.`}{" "}
        The school generates a key pair; paste only the <strong>public</strong> key here.
      </p>
      {keys.length > 0 && (
        <ul className="space-y-1">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-slate-100 px-2 py-0.5 text-xs">{k.public_key}</code>
              <span className="text-xs text-slate-500">
                added {new Date(k.created_at).toLocaleDateString("en-GB")}
              </span>
              {k.revoked_at ? (
                <span className="text-xs text-red-700">revoked</span>
              ) : (
                <form action={revokeSigningKeyAction}>
                  <input type="hidden" name="schoolId" value={schoolId} />
                  <input type="hidden" name="keyId" value={k.id} />
                  <button className="text-xs text-red-700 underline">Revoke</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <form action={addSigningKeyAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="schoolId" value={schoolId} />
        <label className="block">
          <span className="mb-1 block text-slate-700">Public key</span>
          <input
            name="publicKey"
            autoComplete="off"
            spellCheck={false}
            className="w-96 rounded border border-slate-300 px-2 py-1 font-mono text-xs"
          />
        </label>
        <button className="rounded bg-slate-900 px-4 py-1.5 text-white hover:bg-slate-700">
          Add key
        </button>
      </form>
    </div>
  );
}
