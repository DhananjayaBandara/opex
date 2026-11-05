// File metadata (decision D101): who registered which file, when, of what kind and size. The content
// is not kept (no binary is retained, no virus scan, no signed URL: those belong to the real
// system). An import keeps only its fingerprint and counts; an export's file is described here too.
// Browser-safe: no Node imports.
import {
  CATEGORIES,
  CONTENT_TYPES,
  requireOwnKey,
  sizeLabel,
  storageKeyOf,
  validateFile,
} from "../domain/files.js";
import { SYSTEM_ACTOR } from "./context.js";
import { fail } from "./errors.js";

const VIEW = "file.view";
const MANAGE = "file.manage";
const LIMIT = 200;

// Inserts a file's metadata row inside a transaction. Shared by registration and by CSV staging, which
// registers its source under its own permission.
export function insertFile(tx, { tenantId, userId, clock, newId }, input) {
  const fields = validateFile(input);
  const fileId = newId();
  const at = clock();
  const storageKey =
    input.storageKey === undefined
      ? storageKeyOf(tenantId, fields.category, fileId, fields.name, at)
      : requireOwnKey(tenantId, input.storageKey);
  return tx.insert("files", {
    ...fields,
    fileId,
    storageKey,
    registeredBy: userId,
    registeredAt: at,
    retained: false,
  });
}

export function createFiles({ store, gate, clock, newId }) {
  function reader(context, permission) {
    const resolved = gate.requireTenant(context, permission);
    gate.authorizeTenantWide(resolved, permission);
    const session = store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });
    return { resolved, session };
  }

  const names = () => {
    const platform = store.platformSession({ actorId: SYSTEM_ACTOR });
    const cache = new Map();
    return (userId) => {
      if (!cache.has(userId)) {
        const user = platform.get("users", userId);
        cache.set(userId, user === null ? userId : user.name);
      }
      return cache.get(userId);
    };
  };

  const view = (row, nameOf) =>
    Object.freeze({
      id: row.id,
      name: row.name,
      contentType: row.contentType,
      typeLabel: CONTENT_TYPES[row.contentType].label,
      category: row.category,
      categoryLabel: CATEGORIES[row.category].label,
      size: row.size,
      sizeLabel: sizeLabel(row.size),
      fingerprint: row.fingerprint,
      storageKey: row.storageKey,
      registeredBy: row.registeredBy,
      registeredByName: nameOf(row.registeredBy),
      registeredAt: row.registeredAt,
      retained: false,
      retention: "Metadata only: the content is not kept in this prototype",
    });

  return Object.freeze({
    register(context, input) {
      const { resolved, session } = reader(context, MANAGE);
      return session.transaction((tx) => {
        const row = insertFile(
          tx,
          { tenantId: resolved.tenant.id, userId: resolved.user.id, clock, newId },
          input
        );
        return view(row, names());
      });
    },

    list(context, filter = {}) {
      const { session } = reader(context, VIEW);
      const category = typeof filter === "object" && filter !== null ? filter.category : undefined;
      if (
        category !== undefined &&
        category !== null &&
        category !== "" &&
        !Object.hasOwn(CATEGORIES, category)
      ) {
        throw fail("invalid_filter", "category must be attachment, branding, import or export");
      }
      const nameOf = names();
      const rows = session.list("files", (row) => !category || row.category === category).reverse();
      return Object.freeze({
        items: Object.freeze(rows.slice(0, LIMIT).map((row) => view(row, nameOf))),
        total: rows.length,
      });
    },
  });
}
