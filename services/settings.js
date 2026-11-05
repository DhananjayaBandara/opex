// Company profile, module entitlements and KPI targets (SRS 4.4, 10.4; FR-TEN-007, FR-SCR-002,
// UC-TEN-02; decisions D17, D23, D24).
//
// Every call resolves the tenant and the caller's access from the context, never from the payload.
// Reads need only an active membership (targets are limited to the caller's factories); writes need
// the permission (WHAT) and, for factory data, a factory scope that covers it (WHERE), failing closed.
// Entitlements are set by the platform, never by the tenant. Targets and entitlements are
// effective-dated versions: a version in effect is never rewritten, a scheduled one can be revised,
// and starting a new version ends its predecessor the day before (SRS 8.3). Each write is one
// transaction with its audit event, so a refused call leaves neither a row nor an event.
// Browser-safe: no Node imports.
import { resolveTargets } from "../domain/calculations.js";
import {
  DEFAULT_LOCALE,
  SYSTEM_TARGETS,
  entitledOn,
  validateProfilePatch,
  validateTargetValues,
} from "../domain/configuration.js";
import { replaceAssignment, validateRange } from "../domain/effective-dating.js";
import { FEATURES } from "../domain/permissions.js";
import { businessDate } from "../domain/time.js";
import { fail } from "./errors.js";

const MANAGE = "tenant_settings.manage";

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// A calendar date, refused with `invalid_range` when it is not a real one (or not even text).
const requireDate = (value) => validateRange({ effectiveFrom: value }).effectiveFrom;

const profileView = (row) =>
  Object.freeze({
    name: row.name,
    timeZone: row.timeZone,
    legalName: row.legalName ?? null,
    locale: row.locale ?? DEFAULT_LOCALE,
    currency: row.currency ?? null,
    primaryColor: row.primaryColor ?? null,
    logo: row.logo ?? null,
  });

const entitlementRow = (row) =>
  Object.freeze({
    feature: row.feature,
    enabled: row.enabled,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  });

// Every module of the catalogue, in catalogue order, with whether it is entitled on the date and the
// versions behind that answer.
function entitlementView(versions, asOf) {
  const entitled = entitledOn(versions, asOf);
  return Object.freeze(
    FEATURES.map((feature) =>
      Object.freeze({
        feature,
        entitled: entitled.includes(feature),
        history: Object.freeze(
          // Versions are only ever added after the last one, so storage order is chronological.
          versions
            .filter((version) => version.feature === feature)
            .map(({ enabled, effectiveFrom, effectiveTo }) =>
              Object.freeze({ enabled, effectiveFrom, effectiveTo })
            )
        ),
      })
    )
  );
}

const targetView = (row) =>
  Object.freeze({
    id: row.id,
    scope: row.scope,
    factoryId: row.factoryId,
    version: row.version,
    values: Object.freeze({ ...row.values }),
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  });

// Starts a new version of an effective-dated chain, or revises a scheduled one (decision D23).
//  - The start cannot be in the past: history is not rewritten.
//  - A version that already starts that day is revised in place while it is scheduled, and refused as
//    `version_in_effect` once it has started.
//  - Otherwise the new version is open-ended, so it must come after every existing version; the one it
//    follows ends the day before it starts.
export function writeVersion(tx, { collection, chain, today, start, fields, revise }) {
  if (start < today) {
    throw fail("past_effective_date", `a change cannot start before today (${today})`);
  }
  const same = chain.find((row) => row.effectiveFrom === start);
  if (same !== undefined) {
    if (same.effectiveFrom <= today) {
      throw fail("version_in_effect", "that version is already in effect and cannot be rewritten");
    }
    return tx.update(collection, same.id, revise);
  }
  if (chain.some((row) => row.effectiveFrom > start)) {
    throw fail(
      "overlap",
      "a later version is already scheduled; revise that one or start after it"
    );
  }
  const { ended } = replaceAssignment(
    chain,
    { effectiveFrom: start, effectiveTo: null },
    { sameSubject: () => true }
  );
  for (const row of ended) tx.update(collection, row.id, { effectiveTo: row.effectiveTo });
  return tx.insert(collection, { ...fields, effectiveFrom: start, effectiveTo: null });
}

export function createSettings({ store, gate, clock }) {
  const sessionFor = (resolved) =>
    store.session({ tenantId: resolved.tenant.id, actorId: resolved.user.id });

  function profileRow(session) {
    const row = session.list("settings", (candidate) => candidate.kind === "profile")[0];
    if (row === undefined) throw fail("not_found", "the company profile was not found");
    return row;
  }

  // The factory a target belongs to (null for the tenant level). A factory of another tenant does not
  // exist here, so it is `not_found` like any unknown id.
  function factoryRow(tx, factoryId) {
    if (factoryId === undefined || factoryId === null) return null;
    const row = typeof factoryId === "string" ? tx.get("factories", factoryId) : null;
    if (row === null) throw fail("not_found", "that factory was not found");
    return row;
  }

  const subjectOf = (factory) => (factory === null ? "tenant" : factory.id);

  function entitlementsOf(session, resolvedDate, options) {
    const input = isObject(options) ? options : {};
    const asOf = input.asOf === undefined ? resolvedDate : requireDate(input.asOf);
    return entitlementView(session.list("featureVersions"), asOf);
  }

  return Object.freeze({
    // ---- Company profile and branding ---------------------------------------------------------

    profile(context) {
      const resolved = gate.requireTenant(context);
      return profileView(profileRow(sessionFor(resolved)));
    },

    // Company data belongs to the whole organization, so changing it needs every factory. The time
    // zone is fixed at provisioning (D24). The name is also kept in the platform registry, in the
    // same unit of work, so the two never disagree.
    updateProfile(context, patch) {
      const resolved = gate.requireTenant(context, MANAGE);
      gate.authorizeTenantWide(resolved, MANAGE);
      const input = isObject(patch) ? patch : {};
      if (input.timeZone !== undefined) {
        throw fail(
          "immutable_field",
          "the time zone is fixed when the organization is provisioned"
        );
      }
      const changes = validateProfilePatch(input);
      return store.unitOfWork({ actorId: resolved.user.id }, ({ platform, tenant }) => {
        const inTenant = tenant(resolved.tenant.id);
        const row = profileRow(inTenant);
        const updated = inTenant.update("settings", row.id, changes);
        if (changes.name !== undefined) {
          platform.update("tenants", resolved.tenant.id, { name: changes.name });
        }
        return profileView(updated);
      });
    },

    // ---- Module entitlements ------------------------------------------------------------------

    // What the organization is entitled to (D17). Visible to every member: the permissions they hold
    // already depend on it. Only the platform changes it.
    entitlements(context, options) {
      const resolved = gate.requireTenant(context);
      return entitlementsOf(sessionFor(resolved), resolved.today, options);
    },

    tenantEntitlements(context, tenantId, options) {
      const actor = gate.requirePlatform(context, "feature_entitlement.manage");
      const registry = store.platformSession({ actorId: actor.user.id });
      const tenant = typeof tenantId === "string" ? registry.get("tenants", tenantId) : null;
      if (tenant === null) throw fail("not_found", "that tenant was not found");
      const session = store.session({ tenantId: tenant.id, actorId: actor.user.id });
      return entitlementsOf(session, businessDate(clock(), tenant.timeZone), options);
    },

    setEntitlement(context, tenantId, input) {
      const actor = gate.requirePlatform(context, "feature_entitlement.manage");
      const { feature, enabled, effectiveFrom } = isObject(input) ? input : {};
      if (!FEATURES.includes(feature)) {
        throw fail("unknown_feature", `${String(feature)} is not a module`);
      }
      if (typeof enabled !== "boolean")
        throw fail("invalid_field", "enabled must be true or false");
      const registry = store.platformSession({ actorId: actor.user.id });
      const tenant = typeof tenantId === "string" ? registry.get("tenants", tenantId) : null;
      if (tenant === null) throw fail("not_found", "that tenant was not found");
      const today = businessDate(clock(), tenant.timeZone);
      const start = effectiveFrom === undefined ? today : requireDate(effectiveFrom);
      return store.session({ tenantId: tenant.id, actorId: actor.user.id }).transaction((tx) =>
        entitlementRow(
          writeVersion(tx, {
            collection: "featureVersions",
            chain: tx.list("featureVersions", (row) => row.feature === feature),
            today,
            start,
            fields: { feature, enabled },
            revise: { enabled },
          })
        )
      );
    },

    // ---- KPI targets --------------------------------------------------------------------------

    // The targets in force on a date for the tenant, or for one factory, each value with the level
    // and version it came from (SRS 10.4). The tenant level is open to every member; a factory's
    // answer only to someone whose scope covers it.
    targets(context, options) {
      const resolved = gate.requireTenant(context);
      const input = isObject(options) ? options : {};
      const asOf = input.asOf === undefined ? resolved.today : requireDate(input.asOf);
      const session = sessionFor(resolved);
      const factory = factoryRow(session, input.factoryId);
      if (factory !== null && !gate.inFactoryScope(resolved, factory.id)) {
        throw fail("forbidden", "you do not have access to that");
      }
      const versions = session.list("targetVersions");
      const { values, sources } = resolveTargets(
        {
          system: SYSTEM_TARGETS,
          tenant: versions.filter((row) => row.subject === "tenant"),
          factory: factory === null ? [] : versions.filter((row) => row.subject === factory.id),
        },
        asOf
      );
      return Object.freeze({
        asOf,
        factoryId: factory?.id ?? null,
        values: Object.freeze(values),
        sources: Object.freeze(sources),
      });
    },

    targetVersions(context, options) {
      const resolved = gate.requireTenant(context);
      const input = isObject(options) ? options : {};
      const session = sessionFor(resolved);
      const factory = factoryRow(session, input.factoryId);
      if (factory !== null && !gate.inFactoryScope(resolved, factory.id)) {
        throw fail("forbidden", "you do not have access to that");
      }
      return Object.freeze(
        session
          .list("targetVersions", (row) => row.subject === subjectOf(factory))
          .sort((a, b) => a.version - b.version)
          .map(targetView)
      );
    },

    // The tenant default is tenant-wide data; a factory override needs the permission for that
    // factory (decision D23). The dedicated score-configuration permission arrives with the scoring
    // slice.
    setTargets(context, input) {
      const resolved = gate.requireTenant(context, MANAGE);
      const request = isObject(input) ? input : {};
      return sessionFor(resolved).transaction((tx) => {
        const factory = factoryRow(tx, request.factoryId);
        if (factory === null) gate.authorizeTenantWide(resolved, MANAGE);
        else gate.authorize(resolved, MANAGE, { factoryId: factory.id });

        const values = validateTargetValues(request.values);
        const start =
          request.effectiveFrom === undefined ? resolved.today : requireDate(request.effectiveFrom);
        if (factory?.active === false) throw fail("inactive_parent", "that factory is inactive");

        const subject = subjectOf(factory);
        const chain = tx.list("targetVersions", (row) => row.subject === subject);
        return targetView(
          writeVersion(tx, {
            collection: "targetVersions",
            chain,
            today: resolved.today,
            start,
            fields: {
              subject,
              scope: factory === null ? "tenant" : "factory",
              factoryId: factory?.id ?? null,
              version: Math.max(0, ...chain.map((row) => row.version)) + 1,
              values,
            },
            revise: { values },
          })
        );
      });
    },
  });
}
