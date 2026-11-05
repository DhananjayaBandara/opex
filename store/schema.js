// Uniqueness rules for every collection the services write (SRS 6, FR-TEN-003). They are enforced by
// the store inside the same working copy as the write, so a duplicate leaves nothing behind. Each
// rule is scoped to one partition: a slug is unique across the platform registry, a role name only
// within its tenant.
// Browser-safe: no Node imports.
const rules = (...lists) => Object.freeze(lists.map((fields) => Object.freeze(fields)));

export const UNIQUES = Object.freeze({
  // platform partition
  tenants: Object.freeze([Object.freeze(["slug"])]),
  users: Object.freeze([Object.freeze(["email"])]),
  // tenant partitions
  memberships: Object.freeze([Object.freeze(["userId"])]),
  roles: rules(["name"], ["nameKey"]),
  settings: Object.freeze([Object.freeze(["kind"])]),
  // organization (SRS 6): codes are normalized and names compared by `nameKey`, so case never
  // makes a duplicate; every rule is scoped to the tenant by the store.
  factories: rules(["code"]),
  sections: rules(["factoryId", "code"], ["factoryId", "nameKey"]),
  shifts: rules(["factoryId", "code"], ["factoryId", "nameKey"]),
  sectionShifts: rules(["sectionId", "shiftId"]),
  lines: rules(["sectionId", "nameKey"]),
  designations: rules(["nameKey"]),
  calendars: rules(["factoryId", "nameKey"]),
  calendarExceptions: rules(["calendarId", "date"]),
  // workforce (SRS 6, 13.4): an employee code is unique across the organization (D5) and a user is
  // linked to at most one employee (D29); one attendance record per employee, date and shift (D33).
  employees: rules(["employeeCode"], ["userId"]),
  attendanceRecords: rules(["employeeId", "date", "shiftId"]),
  // production (SRS 8.4, 13.1; D34 to D38): a style code is unique across the organization; a plan
  // revision, a production day and an hour row are each numbered or keyed once.
  styles: rules(["code"]),
  productionPlans: rules(["lineId", "shiftId", "date", "revision"]),
  productionDays: rules(["lineId", "shiftId", "date"]),
  hourlyOutputs: rules(["productionDayId", "ordinalHour"]),
  // configuration (SRS 4.4, 10.4): a chain of versions is numbered once, and a module cannot have two
  // versions that start on the same day. `subject` is "tenant" or the factory id, because the store
  // ignores rules whose key fields are null.
  targetVersions: rules(["subject", "version"]),
  featureVersions: rules(["feature", "effectiveFrom"]),
  // scorecards (SRS 10.3, 10.4; D51, D52): the score configuration is one numbered chain of versions
  // that cannot start twice on a day, and a snapshot is stored once per supervisor, date and
  // configuration version (`key`), so taking it again cannot duplicate it.
  scoreConfigVersions: rules(["version"], ["effectiveFrom"]),
  scoreSnapshots: rules(["key"]),
  // communication and reports (S5.2; D62 to D69): one setting per member, type and channel; one
  // override per type and channel; one delivery per notification and channel; a comment's revisions
  // are numbered once; a requester's Idempotency-Key names one export job (scheduled runs have no key,
  // so the rule skips them); an export file has one storage key; a schedule name is unique.
  notificationPreferences: rules(["userId", "type", "channel"]),
  notificationTemplates: rules(["type", "channel"]),
  notificationDeliveries: rules(["notificationId", "channel"]),
  commentRevisions: rules(["commentId", "revision"]),
  exportJobs: rules(["requesterId", "idempotencyKey"]),
  exportFiles: rules(["key"]),
  reportSchedules: rules(["nameKey"]),
  // orders and planning (S6; D72 to D82): buyer code and name; our order reference across the
  // organization and a buyer's PO number per buyer (orders without a PO number are skipped); one line
  // per style on an order; template names, a template's milestone codes, an order's milestone codes,
  // approval-type names and codes; an approval's decisions are numbered once.
  buyers: rules(["code"], ["nameKey"]),
  buyerOrders: rules(["reference"], ["buyerId", "buyerPoKey"]),
  buyerOrderLines: rules(["orderId", "styleId"]),
  tnaTemplates: rules(["nameKey"]),
  milestoneDefinitions: rules(["templateId", "code"]),
  orderMilestones: rules(["orderId", "code"]),
  buyerApprovalTypes: rules(["code"], ["nameKey"]),
  buyerApprovalDecisions: rules(["approvalId", "sequence"]),
  // procurement, stock and finance (S7; D84 to D93): material and supplier codes and names; a document
  // number across the organization (O15 stays open, D85); one material once per document; one
  // quotation per RFQ and supplier; a supplier's own invoice number once per supplier (customer
  // invoices carry a null supplier key, so the rule skips them); a payment's Idempotency-Key once per
  // invoice (a payment without a key is skipped).
  materials: rules(["code"], ["nameKey"]),
  suppliers: rules(["code"], ["nameKey"]),
  rfqs: rules(["number"]),
  rfqLines: rules(["rfqId", "materialId"]),
  quotations: rules(["rfqId", "supplierId"]),
  quotationLines: rules(["quotationId", "rfqLineId"]),
  purchaseOrders: rules(["number"]),
  purchaseOrderLines: rules(["poId", "materialId"]),
  goodsReceipts: rules(["number"]),
  goodsReceiptLines: rules(["receiptId", "poLineId"]),
  requisitions: rules(["number"]),
  requisitionLines: rules(["requisitionId", "materialId"]),
  invoices: rules(["number"], ["supplierId", "supplierKey"]),
  invoicePayments: rules(["invoiceId", "idempotencyKey"]),
  // platform services (S8; D98 to D103): a connection name once per organization; a run's
  // Idempotency-Key and an accepted delivery id once per connection (both skipped when null); a
  // record is mapped once per connection and an external id names one record; the platform registry
  // routes an endpoint key to exactly one connection.
  integrations: rules(["nameKey"], ["endpointKey"]),
  integrationRuns: rules(["integrationId", "idempotencyKey"], ["integrationId", "deliveryId"]),
  integrationMappings: rules(
    ["integrationId", "entityType", "entityId"],
    ["integrationId", "externalId"]
  ),
  webhookEndpoints: rules(["endpointKey"]),
  // file metadata (D101): a storage key names one file.
  files: rules(["storageKey"]),
  // CSV imports (D104): a row is numbered once within its import.
  importRows: rules(["jobId", "number"]),
});
