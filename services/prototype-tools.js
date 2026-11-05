// Prototype Tools: the simulated second factor and the simulated email outbox (decision D18, level S).
// A real deployment would send the code and the reset link to the person; the prototype shows them
// here so every flow can be walked through and tested. Nothing in this module is a security control.
// Browser-safe: no Node imports.
import { mfaCode } from "../domain/mfa.js";
import { normalizeEmail } from "../domain/tenancy.js";
import { fail } from "./errors.js";

export function createPrototypeTools({ store, clock }) {
  const reader = () => store.platformSession({ actorId: "prototype-tools" });
  return Object.freeze({
    // The current simulated code for an account.
    mfaCode(email) {
      const address = normalizeEmail(email);
      const user = reader().list("users", (row) => row.email === address)[0];
      if (!user) throw fail("not_found", "no such account");
      return mfaCode(user.mfaSecret, clock());
    },
    // Whether the store holds any accounts or organizations yet (the demo seed needs an empty one).
    status() {
      const session = reader();
      return Object.freeze({
        users: session.list("users").length,
        tenants: session.list("tenants").length,
      });
    },
    // Every message the system would have emailed, oldest first.
    outbox() {
      return reader().list("outbox");
    },
  });
}
