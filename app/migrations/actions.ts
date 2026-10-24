"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import {
  cancelRollout,
  createRollout,
  releaseRollout,
  requestSchemaScan,
  retryStep,
} from "@/lib/actions/rollouts";

// Form actions for the Migrations screen: each does its work through the
// guarded functions in lib/actions/rollouts.ts and returns to the page with
// ?ok=<code> or ?error=<text>.

function message(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((i) => i.message).join(" ");
  return error instanceof Error ? error.message : "Something went wrong.";
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "");

async function respond(work: () => Promise<unknown>, ok: string) {
  try {
    await work();
  } catch (error) {
    redirect(`/migrations?error=${encodeURIComponent(message(error))}`);
  }
  revalidatePath("/migrations");
  revalidatePath("/");
  redirect(`/migrations?ok=${ok}`);
}

export async function createRolloutAction(formData: FormData) {
  await respond(
    () =>
      createRollout(
        text(formData, "releaseId"),
        formData.get("batchSize"),
        // a checked box is the only way to skip; anything else backs up first
        formData.get("skipBackup") === "on" ? "skip_if_expand_only" : "required"
      ),
    "created"
  );
}

export async function releaseAction(formData: FormData) {
  await respond(
    () =>
      releaseRollout(
        text(formData, "rolloutId"),
        text(formData, "target"),
        formData.get("confirm")
      ),
    "released"
  );
}

export async function retryStepAction(formData: FormData) {
  await respond(() => retryStep(text(formData, "stepId")), "retried");
}

export async function cancelRolloutAction(formData: FormData) {
  await respond(
    () => cancelRollout(text(formData, "rolloutId"), formData.get("confirm")),
    "cancelled"
  );
}

export async function scanAction() {
  await respond(() => requestSchemaScan(null), "scanning");
}
