// effective_access = tenant membership + role permissions + factory scope
//                    + operational assignment scope + feature entitlement (architecture 5.3).
// WHAT (permissions) and WHERE (scope) are resolved separately; a role's code or name is never an
// input, only its stored permission set (catalogue header: "role codes ... never grant these").
// Browser-safe: no Node imports.
import { activeOn } from "./effective-dating.js";

const DENIED_SCOPE = Object.freeze({ all: false, factoryIds: Object.freeze([]) });

function inactive(tenantId, userId) {
  return Object.freeze({
    tenantId,
    userId,
    active: false,
    permissions: Object.freeze([]),
    factoryScope: DENIED_SCOPE,
    assignmentScoped: false,
    sectionShiftIds: Object.freeze([]),
  });
}

function normalizeScope(scope) {
  if (scope?.all === true) return Object.freeze({ all: true, factoryIds: Object.freeze([]) });
  const ids = Array.isArray(scope?.factoryIds) ? [...new Set(scope.factoryIds)].sort() : [];
  return Object.freeze({ all: false, factoryIds: Object.freeze(ids) });
}

// `platformRoles` is accepted but grants nothing here: platform principals reach tenant data only
// through an audited, reasoned, time-bounded support-access context (architecture 5.5, FR-TEN-010).
export function resolveAccess({
  tenantId,
  userId,
  asOf,
  permissionFeatures,
  entitlements,
  roles,
  memberships,
  assignments,
}) {
  const membership = memberships.find(
    (candidate) =>
      candidate.tenantId === tenantId &&
      candidate.userId === userId &&
      candidate.status === "active"
  );
  if (!membership) return inactive(tenantId, userId);

  const granted = new Set();
  for (const role of roles) {
    if (role.tenantId !== tenantId || !membership.roleIds?.includes(role.id)) continue;
    for (const permission of role.permissions ?? []) {
      if (!Object.hasOwn(permissionFeatures, permission)) continue;
      const feature = permissionFeatures[permission];
      if (feature === null || entitlements.includes(feature)) granted.add(permission);
    }
  }

  const assignmentScoped = membership.assignmentScoped === true;
  const sectionShiftIds = assignmentScoped
    ? [
        ...new Set(
          assignments
            .filter(
              (assignment) =>
                assignment.tenantId === tenantId &&
                assignment.userId === userId &&
                activeOn(assignment, asOf)
            )
            .map((assignment) => assignment.sectionShiftId)
        ),
      ].sort()
    : [];

  return Object.freeze({
    tenantId,
    userId,
    active: true,
    permissions: Object.freeze([...granted].sort()),
    factoryScope: normalizeScope(membership.factoryScope),
    assignmentScoped,
    sectionShiftIds: Object.freeze(sectionShiftIds),
  });
}

// Fail closed (decision D14): a resource must name the tenant, and the factory or SectionShift when
// the user is restricted by factory or by assignment.
export function canAccess(access, permission, resource) {
  if (!access?.active || !access.permissions.includes(permission)) return false;
  if (!resource || resource.tenantId !== access.tenantId) return false;
  if (!access.factoryScope.all && !access.factoryScope.factoryIds.includes(resource.factoryId)) {
    return false;
  }
  if (access.assignmentScoped && !access.sectionShiftIds.includes(resource.sectionShiftId)) {
    return false;
  }
  return true;
}
