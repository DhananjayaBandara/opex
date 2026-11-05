// The platform services part of the demo world (S8; D97 to D109): integration connections in every
// status with their runs, retries, mappings and webhook outcomes, file metadata, CSV imports that
// were committed, staged with errors and cancelled, and two CSV exports.
//
// Everything goes through the services, exactly as an administrator and a data steward would do it,
// so the rules, the history and the audit trail are the real ones. Kept small: LocalStorage holds
// about 5 MB, and every write also adds an audit event.
// Browser-safe: no Node imports.
import { simulatedSignature } from "../domain/fingerprint.js";
import { addDays } from "../domain/effective-dating.js";

// A steward keeps master data, files, imports and exports. Employees are left to HR (no
// employee.manage), so an employee import is refused for this person and works for the administrator.
export const PLATFORM_ROLES = Object.freeze([
  {
    name: "Data steward",
    permissions: [
      "file.view",
      "file.manage",
      "import.manage",
      "export.create",
      "integration.view",
      "order.view",
      "order.manage",
      "material.manage",
      "procurement.view",
      "finance.view",
    ],
  },
]);

const ENDPOINT = "https://erp.example.com/api/v2";

const FILES = [
  { name: "company-logo.png", contentType: "image/png", category: "branding", size: 18_432 },
  {
    name: "factory-layout-katunayake.pdf",
    contentType: "application/pdf",
    category: "attachment",
    size: 244_000,
  },
  {
    name: "sewing-sop-v3.pdf",
    contentType: "application/pdf",
    category: "attachment",
    size: 1_310_000,
  },
];

const BUYERS_CSV =
  "code,name,country,contact name,contact email\r\n" +
  "NORDIC,Nordic Outdoor AB,Sweden,Elin Berg,elin@nordic-outdoor.example\r\n" +
  "MERIDIAN,Meridian Apparel Group,Canada,Owen Clarke,owen@meridian-apparel.example\r\n" +
  "ALPINE,Alpine Outfitters Duplicate,Germany,,\r\n";

const MATERIALS_CSV =
  "code,name,category,unit,reorder level,daily use,standard cost\r\n" +
  "ELS-010,Elastic 25 mm,Trims,m,2000,300,18.5\r\n" +
  "FAB-900,Denim 12 oz,Fabric,yard,500,60,1800\r\n" +
  "ZIP-014,Zip 14 cm,Trims,pcs,abc,,45\r\n" +
  "FAB-101,Cotton jersey again,Fabric,m,100,,\r\n";

const SUPPLIERS_CSV =
  "code,name,contact name,email,phone,payment terms\r\n" +
  "SUP-ELA,Elastic House,Ruwan Perera,orders@elastichouse.example,+94 11 555 0101,Net 30\r\n" +
  "SUP-ZIP,Zip & Button Co,Chathu Silva,sales@zipbutton.example,+94 11 555 0102,Net 14\r\n";

export function seedPlatform({ app, admin, plan, today, signIn }) {
  const slug = plan.spec.slug;
  if (slug === "orbit") {
    seedOrbit(app, admin);
    return;
  }

  // ---- Connections ---------------------------------------------------------------------------------
  const make = (name, type, direction, extra = {}) =>
    app.integrations.create(admin, { name, type, endpoint: ENDPOINT, direction, ...extra });
  const enable = (connection) => app.integrations.transition(admin, connection.id, "enable");

  // 1. Accounting: healthy, with synced mappings, one failed run that a retry recovered, and one that
  //    ran out of attempts.
  const books = make("Books ERP", "accounting_erp", "both", { schedule: "Every night at 02:00" });
  enable(books);
  app.integrations.runSync(admin, books.id, { idempotencyKey: "seed-books-1" });
  const failed = app.integrations.runSync(admin, books.id, { simulateFailure: true });
  app.integrations.retry(admin, failed.id);
  const doomed = app.integrations.runSync(admin, books.id, { simulateFailure: true });
  const second = app.integrations.retry(admin, doomed.id, { simulateFailure: true });
  app.integrations.retry(admin, second.id, { simulateFailure: true });
  app.integrations.rotateCredential(admin, books.id);

  // 2. Supplier portal: inbound deliveries, a duplicate, and a rejected one with a bad signature.
  const portal = make("Supplier portal", "supplier", "inbound");
  enable(portal);
  const body = JSON.stringify({
    event: "po.acknowledged",
    tenant: "some-other-organization",
    events: [
      { po: "PO-0001", status: "acknowledged" },
      { po: "PO-0002", status: "acknowledged" },
    ],
  });
  const deliver = (deliveryId, signature = simulatedSignature(portal.endpointKey, body)) =>
    app.integrations.receiveWebhook({
      endpointKey: portal.endpointKey,
      deliveryId,
      signature,
      body,
    });
  deliver("portal-0001");
  deliver("portal-0001");
  deliver("portal-0002", "sim-0000000000000000");
  app.integrations.sendTestWebhook(admin, portal.id);

  // 3. Payroll: paused, never run. 4. Shop floor: disabled with a reason. 5. Email relay: active.
  make("Payroll export", "hr_payroll", "outbound", { schedule: "Monthly, last working day" });
  const terminals = make("Shop-floor terminals", "shop_floor", "inbound");
  enable(terminals);
  app.integrations.transition(admin, terminals.id, "disable", {
    reason: "Terminals are being replaced; re-enable after the new firmware is installed",
  });
  const mail = make("Mail relay", "email", "outbound");
  enable(mail);
  app.integrations.runSync(admin, mail.id);

  // ---- Files, imports and exports, as the data steward ------------------------------------------------
  const steward = app.identity.enterTenant(signIn("steward@felix.example"), { slug });
  for (const file of FILES) app.files.register(steward, file);

  const committed = app.imports.stage(steward, {
    kind: "buyers",
    fileName: "new-buyers.csv",
    content: BUYERS_CSV,
  });
  app.imports.commit(steward, committed.id);
  app.imports.stage(steward, {
    kind: "materials",
    fileName: "materials-q4.csv",
    content: MATERIALS_CSV,
  });
  const cancelled = app.imports.stage(steward, {
    kind: "suppliers",
    fileName: "suppliers-draft.csv",
    content: SUPPLIERS_CSV,
  });
  app.imports.cancel(steward, cancelled.id);

  const from = addDays(today, -29);
  app.reports.request(steward, {
    report: "buyers",
    from,
    to: today,
    idempotencyKey: "seed-steward-buyers",
  });
  app.reports.request(steward, {
    report: "stock_by_material",
    from,
    to: today,
    idempotencyKey: "seed-steward-stock",
  });
}

// A second organization with its own data, to show that the two never mix.
function seedOrbit(app, admin) {
  const connection = app.integrations.create(admin, {
    name: "Orbit accounting",
    type: "accounting_erp",
    endpoint: "https://books.orbit.example/api",
    direction: "both",
  });
  app.integrations.transition(admin, connection.id, "enable");
  app.integrations.runSync(admin, connection.id);
  app.files.register(admin, {
    name: "orbit-brand.png",
    contentType: "image/png",
    category: "branding",
    size: 9_216,
  });
}
