import Link from "next/link";
import { requirePage } from "@/lib/auth/guards";
import { SchoolForm } from "@/components/SchoolForm";
import { createSchoolAction } from "@/app/schools/actions";

export default async function NewSchoolPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requirePage(["owner"]);
  const { error } = await searchParams;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-slate-500 hover:underline">
          ← Schools
        </Link>
        <h1 className="mt-1 text-xl font-semibold">Add school</h1>
      </div>
      {error && (
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      <SchoolForm action={createSchoolAction} submitLabel="Register school" />
    </div>
  );
}
