import { env } from "@/lib/env";
import { proofStoreFrom } from "@/lib/storage/proofs";

/** The proof store from the web app's settings, or null when none is set up. */
export const proofStore = proofStoreFrom(
  env.PROOF_R2_ENDPOINT &&
    env.PROOF_R2_BUCKET &&
    env.PROOF_R2_ACCESS_KEY_ID &&
    env.PROOF_R2_SECRET_ACCESS_KEY
    ? {
        endpoint: env.PROOF_R2_ENDPOINT,
        bucket: env.PROOF_R2_BUCKET,
        accessKeyId: env.PROOF_R2_ACCESS_KEY_ID,
        secretAccessKey: env.PROOF_R2_SECRET_ACCESS_KEY,
      }
    : null
);
