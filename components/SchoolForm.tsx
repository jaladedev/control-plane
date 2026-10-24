import { HOSTING_PLANS, ROLLOUT_GROUPS } from "@/lib/schools";

type Defaults = Partial<{
  slug: string;
  name: string;
  hostnames: string[];
  included_students: number;
  hosting_plan: string;
  rollout_group: string;
  billing_contact_name: string | null;
  billing_contact_email: string | null;
  region: string | null;
  supabase_project_ref: string | null;
  supabase_account_email: string | null;
  cloudflare_account_email: string | null;
  r2_bucket: string | null;
  container_name: string | null;
}>;

const input = "w-full rounded border border-slate-300 px-2 py-1";

function Field({
  label,
  name,
  defaultValue,
  type = "text",
  hint,
  required,
}: {
  label: string;
  name: string;
  defaultValue?: string | number | null;
  type?: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-slate-700">{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue ?? ""}
        required={required}
        className={input}
      />
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

// The create and edit forms share this. The slug can be set once, at creation.
export function SchoolForm({
  action,
  defaults = {},
  schoolId,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  defaults?: Defaults;
  schoolId?: string;
  submitLabel: string;
}) {
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      {schoolId && <input type="hidden" name="schoolId" value={schoolId} />}
      {schoolId ? (
        <div className="text-sm">
          <span className="mb-1 block text-slate-700">Slug</span>
          <p className="py-1 font-mono">{defaults.slug}</p>
          <span className="block text-xs text-slate-500">
            Fixed. It must match the school&apos;s SCHOOL_SLUG setting.
          </span>
        </div>
      ) : (
        <Field
          label="Slug"
          name="slug"
          required
          hint="Lowercase letters, digits and hyphens. Cannot be changed later."
        />
      )}
      <Field label="Name" name="name" defaultValue={defaults.name} required />
      <Field
        label="Hostnames"
        name="hostnames"
        defaultValue={defaults.hostnames?.join(", ")}
        hint="Public names, comma separated. The first is health-checked at /api/health."
      />
      <Field
        label="Included students"
        name="included_students"
        type="number"
        defaultValue={defaults.included_students ?? 0}
        required
      />
      <label className="block text-sm">
        <span className="mb-1 block text-slate-700">Hosting plan</span>
        <select
          name="hosting_plan"
          defaultValue={defaults.hosting_plan ?? "free"}
          className={input}
        >
          {HOSTING_PLANS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-slate-700">Rollout group</span>
        <select
          name="rollout_group"
          defaultValue={defaults.rollout_group ?? "standard"}
          className={input}
        >
          {ROLLOUT_GROUPS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-slate-500">
          Releases reach test schools first, then pilot, then the rest.
        </span>
      </label>
      <Field label="Region" name="region" defaultValue={defaults.region} />
      <Field
        label="Billing contact name"
        name="billing_contact_name"
        defaultValue={defaults.billing_contact_name}
      />
      <Field
        label="Billing contact email"
        name="billing_contact_email"
        type="email"
        defaultValue={defaults.billing_contact_email}
      />
      <Field
        label="Supabase project ref"
        name="supabase_project_ref"
        defaultValue={defaults.supabase_project_ref}
        hint="The ref only. Never paste keys or connection strings."
      />
      <Field
        label="Supabase account email"
        name="supabase_account_email"
        type="email"
        defaultValue={defaults.supabase_account_email}
      />
      <Field
        label="Cloudflare account email"
        name="cloudflare_account_email"
        type="email"
        defaultValue={defaults.cloudflare_account_email}
      />
      <Field label="R2 bucket" name="r2_bucket" defaultValue={defaults.r2_bucket} />
      <Field label="Container name" name="container_name" defaultValue={defaults.container_name} />
      <div className="sm:col-span-2">
        <button className="rounded bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
