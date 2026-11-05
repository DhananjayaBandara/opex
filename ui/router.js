// The route table and the hash router. A route is shown in the navigation only when the signed-in
// person can use it; that is a convenience, and every service call still authorizes on its own
// (a hidden page opened by typing its address shows the access-denied state).
import { session } from "./session.js";
import * as calendars from "./views/calendars.js";
import * as comments from "./views/comments.js";
import * as company from "./views/company.js";
import * as dashboardProduction from "./views/dashboard-production.js";
import * as dashboardTenant from "./views/dashboard-tenant.js";
import * as dashboardWorkforce from "./views/dashboard-workforce.js";
import * as factories from "./views/factories.js";
import * as financeInvoiceDetail from "./views/finance-invoice-detail.js";
import * as financeInvoices from "./views/finance-invoices.js";
import * as financePayments from "./views/finance-payments.js";
import * as home from "./views/home.js";
import * as audit from "./views/audit.js";
import * as files from "./views/files.js";
import * as integrationDetail from "./views/integration-detail.js";
import * as integrations from "./views/integrations.js";
import * as limits from "./views/limits.js";
import * as assignments from "./views/assignments.js";
import * as attendance from "./views/attendance.js";
import * as employees from "./views/employees.js";
import * as notificationSettings from "./views/notification-settings.js";
import * as notifications from "./views/notifications.js";
import * as ordersBuyers from "./views/orders-buyers.js";
import * as ordersDetail from "./views/orders-detail.js";
import * as ordersList from "./views/orders-list.js";
import * as ordersStyles from "./views/orders-styles.js";
import * as organization from "./views/organization.js";
import * as planningApprovals from "./views/planning-approvals.js";
import * as planningCapacity from "./views/planning-capacity.js";
import * as planningTna from "./views/planning-tna.js";
import * as platformFeatures from "./views/platform-features.js";
import * as platformSettings from "./views/platform-settings.js";
import * as platformTenants from "./views/platform-tenants.js";
import * as productionDashboard from "./views/production-dashboard.js";
import * as productionDay from "./views/production-day.js";
import * as productionPlans from "./views/production-plans.js";
import * as productionRecords from "./views/production-records.js";
import * as productionStyles from "./views/production-styles.js";
import * as reports from "./views/reports.js";
import * as roles from "./views/roles.js";
import * as schedules from "./views/schedules.js";
import * as scorecardBoard from "./views/scorecard-board.js";
import * as scorecardConfig from "./views/scorecard-config.js";
import * as scorecardExceptions from "./views/scorecard-exceptions.js";
import * as scorecardMine from "./views/scorecard-mine.js";
import * as scorecardSupervisor from "./views/scorecard-supervisor.js";
import * as supplyMaterials from "./views/supply-materials.js";
import * as supplyMovements from "./views/supply-movements.js";
import * as supplyPoDetail from "./views/supply-po-detail.js";
import * as supplyPos from "./views/supply-pos.js";
import * as supplyQuotations from "./views/supply-quotations.js";
import * as supplyReceiptDetail from "./views/supply-receipt-detail.js";
import * as supplyReceipts from "./views/supply-receipts.js";
import * as supplyRequisitionDetail from "./views/supply-requisition-detail.js";
import * as supplyRequisitions from "./views/supply-requisitions.js";
import * as supplyRfqDetail from "./views/supply-rfq-detail.js";
import * as supplyRfqs from "./views/supply-rfqs.js";
import * as supplyStock from "./views/supply-stock.js";
import * as supplySuppliers from "./views/supply-suppliers.js";
import * as tools from "./views/tools.js";
import * as users from "./views/users.js";

const holdsAny = (...permissions) => permissions.some((permission) => session.can(permission));

// The three shared dashboards are for management views: a member scoped to their own assignments uses
// the production screens instead (D54).
const management = () => !session.who?.assignmentScoped;

// Supply chain and finance pages (D83 to D96): every page lists for support access (the page itself
// hides the actions). A detail page opens from a list with its id in the address, so it has no menu entry.
const supplyRoute = (path, label, view, group = "SUPPLY CHAIN") => ({
  path,
  readOnly: true,
  label,
  view,
  kind: "tenant",
  group,
  allowed: () => session.can("procurement.view"),
});
const financeRoute = (path, label, view, group = "FINANCE") => ({
  path,
  readOnly: true,
  label,
  view,
  kind: "tenant",
  group,
  allowed: () => session.can("finance.view"),
});

// Labels follow the parity manifest (tests/parity-manifest.json).
export const ROUTES = Object.freeze([
  { path: "home", label: "Home", view: home, kind: "any", group: null },
  { path: "tools", label: "Prototype tools", view: tools, kind: "public", group: null },
  // The member's own notifications: a link of its own in the menu (with the unread count), not a group.
  {
    path: "notifications",
    label: "Notifications",
    view: notifications,
    kind: "tenant",
    group: null,
  },

  {
    path: "dashboard/tenant",
    readOnly: true,
    label: "Tenant administrator overview",
    view: dashboardTenant,
    kind: "tenant",
    group: "DASHBOARDS",
    allowed: () => session.can("dashboard.view") && management(),
  },
  {
    path: "dashboard/production",
    readOnly: true,
    label: "Production & line performance",
    view: dashboardProduction,
    kind: "tenant",
    group: "DASHBOARDS",
    allowed: () => session.can("dashboard.view") && session.can("production.view") && management(),
  },
  // Attendance is a write permission, so support access (read-only) never reaches this page (D54).
  {
    path: "dashboard/workforce",
    label: "Supervisor & workforce",
    view: dashboardWorkforce,
    kind: "tenant",
    group: "DASHBOARDS",
    allowed: () =>
      session.can("dashboard.view") && session.can("attendance.manage") && management(),
  },

  {
    path: "production/dashboard",
    readOnly: true,
    label: "Production dashboard",
    view: productionDashboard,
    kind: "tenant",
    group: "PRODUCTION",
    allowed: () => session.can("dashboard.view") && session.can("production.view"),
  },
  {
    path: "production/plans",
    readOnly: true,
    label: "Production plans",
    view: productionPlans,
    kind: "tenant",
    group: "PRODUCTION",
    allowed: () => session.can("production.view"),
  },
  {
    path: "production/records",
    readOnly: true,
    label: "Daily records",
    view: productionRecords,
    kind: "tenant",
    group: "PRODUCTION",
    allowed: () => session.can("production.view"),
  },
  {
    path: "production/styles",
    readOnly: true,
    label: "Style master",
    view: productionStyles,
    kind: "tenant",
    group: "PRODUCTION",
    allowed: () => session.can("production.view"),
  },
  {
    path: "production/comments",
    readOnly: true,
    label: "Operational comments",
    view: comments,
    kind: "tenant",
    group: "PRODUCTION",
    allowed: () => session.can("comment.read"),
  },
  // Opened from the dashboard and the lists, with the day's id in the address; not in the menu.
  {
    path: "production/day",
    label: "Production day",
    view: productionDay,
    kind: "tenant",
    group: null,
  },

  {
    path: "orders/buyers",
    readOnly: true,
    label: "Buyers",
    view: ordersBuyers,
    kind: "tenant",
    group: "ORDERS & PLANNING",
    allowed: () => session.can("order.view"),
  },
  {
    path: "orders/styles",
    readOnly: true,
    label: "Styles & SMV",
    view: ordersStyles,
    kind: "tenant",
    group: "ORDERS & PLANNING",
    allowed: () => session.can("order.view"),
  },
  {
    path: "orders/list",
    readOnly: true,
    label: "Buyer orders",
    view: ordersList,
    kind: "tenant",
    group: "ORDERS & PLANNING",
    allowed: () => session.can("order.view"),
  },
  // Opened from the lists and the board, with the order's id in the address; not in the menu.
  {
    path: "orders/detail",
    readOnly: true,
    label: "Buyer order",
    view: ordersDetail,
    kind: "tenant",
    group: null,
    allowed: () => session.can("order.view"),
  },
  {
    path: "planning/tna",
    readOnly: true,
    label: "Time & Action",
    view: planningTna,
    kind: "tenant",
    group: "ORDERS & PLANNING",
    allowed: () => session.can("order.view"),
  },
  {
    path: "planning/approvals",
    readOnly: true,
    label: "Buyer approvals",
    view: planningApprovals,
    kind: "tenant",
    group: "ORDERS & PLANNING",
    allowed: () => session.can("order.view"),
  },
  {
    path: "planning/capacity",
    readOnly: true,
    label: "Capacity & loading",
    view: planningCapacity,
    kind: "tenant",
    group: "ORDERS & PLANNING",
    allowed: () => session.can("order.view"),
  },

  supplyRoute("supply/materials", "Materials", supplyMaterials),
  supplyRoute("supply/suppliers", "Suppliers", supplySuppliers),
  supplyRoute("supply/rfqs", "RFQs", supplyRfqs),
  supplyRoute("supply/quotations", "Quotations", supplyQuotations),
  supplyRoute("supply/purchase-orders", "Purchase orders", supplyPos),
  supplyRoute("supply/receipts", "Goods receipts", supplyReceipts),
  supplyRoute("supply/stock", "Store & stock", supplyStock),
  supplyRoute("supply/movements", "Stock movements", supplyMovements),
  supplyRoute("supply/requisitions", "Material requisitions", supplyRequisitions),
  supplyRoute("supply/rfq", "RFQ", supplyRfqDetail, null),
  supplyRoute("supply/purchase-order", "Purchase order", supplyPoDetail, null),
  supplyRoute("supply/receipt", "Goods receipt", supplyReceiptDetail, null),
  supplyRoute("supply/requisition", "Material requisition", supplyRequisitionDetail, null),

  financeRoute("finance/invoices", "Invoices", financeInvoices),
  financeRoute("finance/payments", "Payments", financePayments),
  financeRoute("finance/invoice", "Invoice", financeInvoiceDetail, null),

  {
    path: "scorecard/mine",
    label: "My scorecard",
    view: scorecardMine,
    kind: "tenant",
    group: "PERFORMANCE",
    allowed: () => session.can("scorecard.view_self"),
  },
  {
    path: "scorecard/board",
    readOnly: true,
    label: "Management scorecard",
    view: scorecardBoard,
    kind: "tenant",
    group: "PERFORMANCE",
    allowed: () => session.can("scorecard.view_all"),
  },
  {
    path: "scorecard/exceptions",
    readOnly: true,
    label: "Score exceptions",
    view: scorecardExceptions,
    kind: "tenant",
    group: "PERFORMANCE",
    allowed: () => session.can("scorecard.view_all"),
  },
  {
    path: "scorecard/config",
    readOnly: true,
    label: "Score configuration",
    view: scorecardConfig,
    kind: "tenant",
    group: "PERFORMANCE",
    allowed: () => holdsAny("score_config.manage", "scorecard.view_all"),
  },
  // Opened from the management scorecard, with the employee and period in the address; not in the menu.
  {
    path: "scorecard/supervisor",
    label: "Supervisor scorecard",
    view: scorecardSupervisor,
    kind: "tenant",
    group: null,
  },

  {
    path: "reports/exports",
    label: "Exports",
    view: reports,
    kind: "tenant",
    group: "REPORTS",
    allowed: () => session.can("export.create"),
  },
  {
    path: "reports/schedules",
    label: "Scheduled reports",
    view: schedules,
    kind: "tenant",
    group: "REPORTS",
    allowed: () => session.can("report_schedule.manage"),
  },

  {
    path: "admin/company",
    readOnly: true,
    label: "Company settings",
    view: company,
    kind: "tenant",
    group: "ADMINISTRATION",
    allowed: () => session.can("tenant_settings.manage"),
  },
  {
    path: "admin/factories",
    readOnly: true,
    label: "Factories",
    view: factories,
    kind: "tenant",
    group: "ADMINISTRATION",
    allowed: () => session.can("factory.manage"),
  },
  {
    path: "admin/organization",
    readOnly: true,
    label: "Organization structure",
    view: organization,
    kind: "tenant",
    group: "ADMINISTRATION",
    allowed: () => holdsAny("structure.manage", "section_shift.manage", "employee.manage"),
  },
  {
    path: "admin/calendars",
    readOnly: true,
    label: "Working calendars",
    view: calendars,
    kind: "tenant",
    group: "ADMINISTRATION",
    allowed: () => session.can("structure.manage"),
  },
  {
    path: "admin/users",
    label: "Users & memberships",
    view: users,
    kind: "tenant",
    group: "ADMINISTRATION",
    allowed: () => session.can("user.manage"),
  },
  {
    path: "admin/roles",
    label: "Roles & permissions",
    view: roles,
    kind: "tenant",
    group: "ADMINISTRATION",
    allowed: () => session.can("role.manage"),
  },
  {
    path: "admin/notifications",
    label: "Notification settings",
    view: notificationSettings,
    kind: "tenant",
    group: "ADMINISTRATION",
    allowed: () => holdsAny("notification_template.manage", "delivery.view"),
  },
  // Platform services (D97 to D109). Every page lists for support access (the pages hide the actions).
  // The connection page opens from the list with its id in the address, so it has no menu entry.
  {
    path: "admin/integrations",
    readOnly: true,
    label: "Integrations",
    view: integrations,
    kind: "tenant",
    group: "ADMINISTRATION",
    allowed: () => holdsAny("integration.view", "integration.manage"),
  },
  {
    path: "admin/integration",
    readOnly: true,
    label: "Integration",
    view: integrationDetail,
    kind: "tenant",
    group: null,
    allowed: () => holdsAny("integration.view", "integration.manage"),
  },
  {
    path: "admin/files",
    readOnly: true,
    label: "Files / imports / exports",
    view: files,
    kind: "tenant",
    group: "ADMINISTRATION",
    allowed: () => holdsAny("file.view", "import.manage", "export.create"),
  },
  {
    path: "admin/audit",
    readOnly: true,
    label: "Audit log",
    view: audit,
    kind: "tenant",
    group: "ADMINISTRATION",
    allowed: () => session.can("audit.view"),
  },

  {
    path: "workforce/employees",
    label: "Employees",
    view: employees,
    kind: "tenant",
    group: "WORKFORCE",
    allowed: () => session.can("employee.manage"),
  },
  {
    path: "workforce/assignments",
    label: "Supervisor assignments",
    view: assignments,
    kind: "tenant",
    group: "WORKFORCE",
    allowed: () => session.can("supervisor_assignment.manage"),
  },
  {
    path: "workforce/attendance",
    label: "Attendance",
    view: attendance,
    kind: "tenant",
    group: "WORKFORCE",
    allowed: () => session.can("attendance.manage"),
  },

  {
    path: "platform/tenants",
    label: "Tenants",
    view: platformTenants,
    kind: "platform",
    group: "PLATFORM",
    allowed: () => session.can("tenant_registry.manage"),
  },
  {
    path: "platform/features",
    label: "Tenant features",
    view: platformFeatures,
    kind: "platform",
    group: "PLATFORM",
    allowed: () => session.can("feature_entitlement.manage"),
  },
  {
    path: "platform/settings",
    label: "Platform administration",
    view: platformSettings,
    kind: "platform",
    group: "PLATFORM",
    allowed: () => holdsAny("platform_settings.manage", "support_access.request"),
  },

  // Readable without signing in, and listed under HELP for everyone who is inside (D108).
  {
    path: "limits",
    readOnly: true,
    label: "Limits of this prototype",
    view: limits,
    kind: "public",
    group: "HELP",
  },
]);

// "#/admin/users?x=1" -> "admin/users"; an empty hash is the home page.
export function parse(hash) {
  const path = String(hash ?? "")
    .replace(/^#\/?/, "")
    .split("?")[0]
    .replace(/\/+$/, "");
  return path === "" ? "home" : path;
}

const fits = (route) =>
  route.kind === "any" || route.kind === "public" || route.kind === session.kind;

// The routes of the current context the person can use, for the navigation.
export function navigation() {
  if (!session.inside) return [];
  // Support access is read-only: its permissions never include the "manage" ones that gate these
  // pages, but the pages do show their data read-only, so they are listed for it.
  const usable = (route) =>
    session.supporting ? route.readOnly === true : (route.allowed?.() ?? true);
  return ROUTES.filter((route) => route.group !== null && fits(route) && usable(route));
}

// The route to draw for a path: the route, or why there is none.
export function resolve(path) {
  const route = ROUTES.find((candidate) => candidate.path === path);
  if (!route) return { route: null, reason: "not_found" };
  if (route.kind === "public") return { route };
  if (!session.inside) return { route: null, reason: "not_inside" };
  if (!fits(route)) return { route, reason: "wrong_context" };
  return { route };
}

export const homeLinks = () =>
  navigation().map((route) => ({ path: route.path, title: route.label }));
