// Permission catalogue (architecture 5.2) and seeded role templates (SRS 5.4, architecture 5.4).
// Permissions are the WHAT; scope (factory, assignment) is the WHERE and lives on the membership.
// A role's key or name never grants anything: only the stored permission list does (see
// domain/authorization.js). Platform permissions and tenant permissions are separate audiences, so
// a tenant role can never hold a platform permission and a platform role reaches tenant data only
// through an approved support-access grant (FR-TEN-010, decision D19).
// Browser-safe: no Node imports.

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Module entitlements (SRS 4.4, D17). A permission gated by a module disappears from effective
// access when the tenant does not hold that module.
export const FEATURES = Object.freeze([
  "production",
  "performance",
  "attendance",
  "orders",
  "procurement",
  "finance",
]);

const entry = (id, family, label, kind, feature = null, audience = "tenant") =>
  Object.freeze({ id, family, label, kind, feature, audience });

export const PERMISSIONS = Object.freeze([
  entry("dashboard.view", "Dashboard", "View dashboards", "read"),
  entry("scorecard.view_self", "Dashboard", "View own scorecard", "read", "performance"),
  entry("scorecard.view_all", "Dashboard", "View scorecards in scope", "read", "performance"),
  entry("score_config.manage", "Dashboard", "Manage score configuration", "write", "performance"),

  entry("production.view", "Production", "View production", "read", "production"),
  entry("production.enter", "Production", "Enter production", "write", "production"),
  entry("production.submit", "Production", "Submit production", "write", "production"),
  entry("production.approve", "Production", "Approve production", "write", "production"),
  entry("production.edit_approved", "Production", "Edit approved entries", "write", "production"),

  entry("factory.manage", "Organization", "Manage factories", "write"),
  entry("structure.manage", "Organization", "Manage sections, shifts and lines", "write"),
  entry("section_shift.manage", "Organization", "Manage section-shift bridges", "write"),

  entry("employee.manage", "Workforce", "Manage employees", "write"),
  entry("supervisor_assignment.manage", "Workforce", "Manage supervisor assignments", "write"),
  entry("attendance.manage", "Workforce", "Manage attendance", "write", "attendance"),

  entry("order.manage", "Orders / planning", "Manage orders", "write", "orders"),
  entry("planning.manage", "Orders / planning", "Manage planning", "write", "orders"),
  entry("approval.decide", "Orders / planning", "Decide approvals", "write", "orders"),
  entry("capacity.manage", "Orders / planning", "Manage capacity", "write", "orders"),
  entry("order.view", "Orders / planning", "View orders and planning", "read", "orders"),

  // Procurement, store and finance (S7, D83). The first four and the two finance writes were in the
  // catalogue from the start; S7 adds the two read permissions and the master-data and requisition ones.
  entry(
    "procurement.view",
    "Procurement / stock",
    "View procurement and stock",
    "read",
    "procurement"
  ),
  entry(
    "material.manage",
    "Procurement / stock",
    "Manage materials and suppliers",
    "write",
    "procurement"
  ),
  entry("rfq.manage", "Procurement / stock", "Manage RFQs", "write", "procurement"),
  entry("po.manage", "Procurement / stock", "Manage purchase orders", "write", "procurement"),
  entry("grn.post", "Procurement / stock", "Post goods receipts", "write", "procurement"),
  entry("stock.adjust", "Procurement / stock", "Adjust stock", "write", "procurement"),
  entry(
    "requisition.manage",
    "Procurement / stock",
    "Raise material requisitions",
    "write",
    "procurement"
  ),
  entry(
    "requisition.approve",
    "Procurement / stock",
    "Approve and issue requisitions",
    "write",
    "procurement"
  ),

  entry("finance.view", "Finance", "View invoices and payments", "read", "finance"),
  entry("invoice.issue", "Finance", "Issue invoices", "write", "finance"),
  entry("invoice.record_payment", "Finance", "Record payments", "write", "finance"),

  entry("user.manage", "Administration", "Manage users", "write"),
  entry("role.manage", "Administration", "Manage roles", "write"),
  entry("tenant_settings.manage", "Administration", "Manage company settings", "write"),
  entry("support_access.approve", "Administration", "Approve platform support access", "write"),
  entry("audit.view", "Administration", "View the audit log", "read"),

  // Platform services (S8, D109). Imports also need the write permission of the data they create.
  entry("integration.view", "Integrations / files", "View integrations", "read"),
  entry("integration.manage", "Integrations / files", "Manage integrations", "write"),
  entry("file.view", "Integrations / files", "View files and import history", "read"),
  entry("file.manage", "Integrations / files", "Register file metadata", "write"),
  entry("import.manage", "Integrations / files", "Run CSV imports", "write"),

  // Communication and reports (S5.2, D70). The real system may split these further.
  entry("comment.read", "Communication", "Read operational comments", "read", "production"),
  entry("comment.write", "Communication", "Write operational comments", "write", "production"),
  entry("notification_template.manage", "Communication", "Manage notification text", "write"),
  entry("delivery.view", "Communication", "View notification delivery history", "read"),
  entry("export.create", "Reports", "Export reports", "write"),
  entry("report_schedule.manage", "Reports", "Manage scheduled reports", "write"),

  entry("tenant_registry.manage", "Platform", "Manage tenants", "write", null, "platform"),
  entry(
    "feature_entitlement.manage",
    "Platform",
    "Manage feature entitlements",
    "write",
    null,
    "platform"
  ),
  entry(
    "platform_settings.manage",
    "Platform",
    "Manage platform settings",
    "write",
    null,
    "platform"
  ),
  entry(
    "support_access.request",
    "Platform",
    "Request tenant support access",
    "write",
    null,
    "platform"
  ),
]);

const byId = new Map(PERMISSIONS.map((permission) => [permission.id, permission]));
const AUDIENCES = ["tenant", "platform"];

export function permissionFeatures() {
  return Object.freeze(Object.fromEntries(PERMISSIONS.map((p) => [p.id, p.feature])));
}

// Normalizes a role's permission list: known ids only, only for the role's audience.
export function validatePermissions(permissionIds, audience) {
  if (!AUDIENCES.includes(audience)) {
    throw fail("invalid_audience", `audience must be one of ${AUDIENCES.join(", ")}`);
  }
  if (!Array.isArray(permissionIds)) {
    throw fail("invalid_permissions", "permissions must be a list of permission ids");
  }
  for (const id of permissionIds) {
    const permission = byId.get(id);
    if (!permission) throw fail("unknown_permission", `${String(id)} is not a permission`);
    if (permission.audience !== audience) {
      throw fail("wrong_audience", `${id} is a ${permission.audience} permission`);
    }
  }
  return [...new Set(permissionIds)].sort();
}

// Support access is read-only (D19): keep the tenant permissions that only view.
export function readOnly(permissionIds) {
  return validatePermissions(permissionIds, "tenant").filter((id) => byId.get(id).kind === "read");
}

const tenantPermissions = PERMISSIONS.filter((p) => p.audience === "tenant").map((p) => p.id);

const template = (key, label, audience, defaultScope, requiresMfa, permissions) =>
  Object.freeze({
    key,
    label,
    audience,
    defaultScope,
    requiresMfa,
    permissions: Object.freeze([...permissions].sort()),
  });

// SRS 5.4: "Yes", "Assigned factories" and "Own assignment scope" are granted (the scope is a
// separate dimension); "Optional/configurable" and "No by default" are left for a custom role.
export const ROLE_TEMPLATES = Object.freeze([
  template("tenant_admin", "Tenant Administrator", "tenant", "tenant", true, tenantPermissions),
  template("factory_manager", "Factory Manager", "tenant", "factories", false, [
    "dashboard.view",
    "scorecard.view_all",
    "production.view",
    "production.enter",
    "production.submit",
    "production.approve",
    "comment.read",
    "comment.write",
    "export.create",
    "report_schedule.manage",
  ]),
  template("supervisor", "Production Supervisor", "tenant", "assignment", false, [
    "dashboard.view",
    "scorecard.view_self",
    "production.view",
    "production.enter",
    "production.submit",
    "comment.read",
    "comment.write",
  ]),
  template("industrial_engineer", "Industrial Engineer", "tenant", "factories", false, [
    "dashboard.view",
    "production.view",
    "production.enter",
    "production.submit",
    "comment.read",
    "comment.write",
  ]),
  template("viewer", "Viewer / Management", "tenant", "factories", false, [
    "dashboard.view",
    "scorecard.view_all",
    "production.view",
    "comment.read",
    "export.create",
  ]),
  template("platform_admin", "Platform Administrator", "platform", "platform", true, [
    "tenant_registry.manage",
    "feature_entitlement.manage",
    "platform_settings.manage",
    "support_access.request",
  ]),
  template("support_engineer", "Support Engineer", "platform", "platform", true, [
    "support_access.request",
  ]),
]);

export function roleTemplate(key) {
  const found = ROLE_TEMPLATES.find((candidate) => candidate.key === key);
  if (!found) throw fail("unknown_template", `${String(key)} is not a role template`);
  return found;
}
