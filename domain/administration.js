// Administration rules (SRS 5.2, 5.3; FR-TEN-003, FR-TEN-004; decisions D16, D25): who counts as an
// administrator, what a factory scope may look like, and which permissions a person cannot hand on.
// Pure functions; no storage. Browser-safe: no Node imports.

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// The permissions a member holds through their roles, ignoring role ids that no longer exist.
function heldBy(membership, roles) {
  const held = new Set();
  for (const roleId of membership.roleIds ?? []) {
    const role = roles.find((candidate) => candidate.id === roleId);
    for (const id of role?.permissions ?? []) held.add(id);
  }
  return held;
}

// An administrator can manage both users and roles for the whole organization: an active member
// holding both permissions, covering every factory and not limited to their own assignments
// (D16, D25). Members with a narrower scope cannot administer organization-wide data, so they are not
// counted; a missing scope fails closed. Returns the user ids, sorted.
export function administrators({ roles, memberships }) {
  const ids = [];
  for (const membership of memberships) {
    if (membership.status !== "active") continue;
    if (membership.factoryScope?.all !== true || membership.assignmentScoped === true) continue;
    const held = heldBy(membership, roles);
    if (held.has("user.manage") && held.has("role.manage")) ids.push(membership.userId);
  }
  return ids.sort();
}

// A factory scope is every factory, or a non-empty list of named factories - never both, never neither.
export function validateScope(scope) {
  const bad = () => fail("invalid_scope", "choose every factory or a list of factories");
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) throw bad();
  const { all, factoryIds } = scope;
  if (all !== undefined && typeof all !== "boolean") throw bad();
  if (all === true) {
    if (factoryIds !== undefined) throw bad();
    return { all: true };
  }
  if (!Array.isArray(factoryIds) || factoryIds.length === 0) throw bad();
  if (factoryIds.some((id) => typeof id !== "string" || id.length === 0)) throw bad();
  return { factoryIds: [...new Set(factoryIds)].sort() };
}

// The wanted permissions that the person does not hold, sorted.
export function missingPermissions(held, wanted) {
  const have = new Set(held);
  return [...new Set(wanted)].filter((id) => !have.has(id)).sort();
}
