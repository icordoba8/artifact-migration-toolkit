import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createOperatorSigner, openSignerStore } from "../../src/operator-signer.mjs";
import { createSoftwareAuthenticator } from "./software-authenticator.mjs";

export const ORIGIN = "https://operator-decision.localhost:44321";
export const RP_ID = "operator-decision.localhost";

export const newStoreDirectory = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amt-signer-"));
  await chmod(directory, 0o700);
  return directory;
};

/** An isolated protected store with one admin-enrolled test-only credential. */
export const enrolledSigner = async ({ now, directory, allowCounterless = false, authenticator, origin = ORIGIN } = {}) => {
  const storeDirectory = directory ?? (await newStoreDirectory());
  const rpID = new URL(origin).hostname;
  const store = await openSignerStore({ directory: storeDirectory, origin, rpID });
  const signer = createOperatorSigner(store, now ? { now } : {});
  const auth = authenticator ?? createSoftwareAuthenticator({ origin, rpID });
  const options = await signer.beginEnrollment({ operator: "operator-a", actor: "admin-a", reason: "test enrollment" });
  await signer.finishEnrollment({ challenge: options.challenge, response: auth.register(options), actor: "admin-a", allowCounterless });
  return {
    directory: storeDirectory, store, signer, auth,
    cleanup: async () => { if (store.db.isOpen) store.db.close(); await rm(storeDirectory, { recursive: true, force: true }); },
  };
};
