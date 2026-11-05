// Composition root of the prototype's services. The browser passes LocalStorage and the system
// clock; tests pass memory storage and a controllable clock. Everything a service needs is injected,
// so nothing here reads a global, and a context issued by one application is not valid in another.
// Browser-safe: no Node imports.
import { createStore } from "../store/store.js";
import { UNIQUES } from "../store/schema.js";
import { randomUuid } from "../store/ids.js";
import { createAdministration } from "./administration.js";
import { createAssignments } from "./assignments.js";
import { createAttendance } from "./attendance.js";
import { createAudit } from "./audit.js";
import { createComments } from "./comments.js";
import { createGate } from "./context.js";
import { createDashboards } from "./dashboards.js";
import { createEmployees } from "./employees.js";
import { createErrorReporter } from "./errors.js";
import { createFiles } from "./files.js";
import { createFinance } from "./finance.js";
import { createIdentity } from "./identity.js";
import { createImports } from "./imports.js";
import { createIntegrations } from "./integrations.js";
import { createInventory } from "./inventory.js";
import { createNotifications } from "./notifications.js";
import { createNotifier } from "./notifier.js";
import { createOrders } from "./orders.js";
import { createOrganization } from "./organization.js";
import { createProcurement } from "./procurement.js";
import { createProduction } from "./production.js";
import { createPrototypeTools } from "./prototype-tools.js";
import { createReports } from "./reports.js";
import { createScorecards } from "./scorecards.js";
import { createSettings } from "./settings.js";
import { createSupport } from "./support.js";
import { createTenancy } from "./tenancy.js";

export function createServices({
  storage,
  clock = () => new Date().toISOString(),
  newId = randomUuid,
  newToken = randomUuid,
  baseDomain = "localhost",
} = {}) {
  const store = createStore({ storage, clock, newId, uniques: UNIQUES });
  // Only the reports service may act as another member (a scheduled report runs with its owner's
  // authority); every other service gets the gate without that.
  const { runAs, ...gate } = createGate({ store, clock });
  const notifier = createNotifier({ store, gate, clock });
  const scorecards = createScorecards({ store, gate, clock });
  const dashboards = createDashboards({ store, gate, scorecards });
  const employees = createEmployees({ store, gate });
  const orders = createOrders({ store, gate, clock });
  const procurement = createProcurement({ store, gate, clock });
  const inventory = createInventory({ store, gate, clock });
  const finance = createFinance({ store, gate, clock });
  return Object.freeze({
    identity: createIdentity({ store, gate, clock, newToken, baseDomain }),
    tenancy: createTenancy({ store, gate, clock, newToken }),
    organization: createOrganization({ store, gate }),
    settings: createSettings({ store, gate, clock }),
    administration: createAdministration({ store, gate, newToken }),
    support: createSupport({ store, gate, clock, notifier }),
    employees,
    assignments: createAssignments({ store, gate }),
    attendance: createAttendance({ store, gate, clock }),
    production: createProduction({ store, gate, clock, notifier }),
    orders,
    procurement,
    inventory,
    finance,
    scorecards,
    dashboards,
    notifications: createNotifications({ store, gate, clock }),
    comments: createComments({ store, gate, clock }),
    reports: createReports({
      store,
      gate: { ...gate, runAs },
      clock,
      notifier,
      sources: { dashboards, scorecards, orders, procurement, inventory, finance },
    }),
    audit: createAudit({ store, gate }),
    integrations: createIntegrations({ store, gate, clock, newId, newToken }),
    files: createFiles({ store, gate, clock, newId }),
    imports: createImports({ store, gate, clock, newId, orders, procurement, employees }),
    // Turns any thrown error into the API error envelope with a request reference (D105).
    errors: createErrorReporter({ newId }),
    prototypeTools: createPrototypeTools({ store, clock }),
    // Set when stored data was unreadable and has been quarantined (persistence recovery).
    recovery: store.recovery,
    // For tests and the demo seed only: direct access to the store, bypassing the services.
    internals: Object.freeze({ store }),
  });
}
