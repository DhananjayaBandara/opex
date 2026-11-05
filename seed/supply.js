// The supply chain, stores and finance part of the demo world (D83 to D96): materials and suppliers,
// opening stock, requests for quotation at every stage, purchase orders in every status, goods receipts
// (posted, reversed, waiting), requisitions in every status, and customer and supplier invoices with
// payments.
//
// Everything goes through the services, exactly as a buyer, a storekeeper and an accounts clerk would
// do it, so the rules, the history and the audit trail are the real ones. The invoices reuse the
// buyers and orders the orders part created (seed/orders.js).
// Dates are days from the organization's own business date, so the world looks the same whenever it
// is created. Kept small: LocalStorage holds about 5 MB.
// Browser-safe: no Node imports.
import { addDays } from "../domain/effective-dating.js";

// Standard roles carry no supply chain or finance rights, so the demo adds four custom ones. Writing
// materials and suppliers needs a tenant-wide scope, so a factory-scoped officer works the documents
// of their own factory and leaves the master data to the administrator.
export const SUPPLY_ROLES = Object.freeze([
  {
    name: "Supply chain officer",
    permissions: [
      "procurement.view",
      "material.manage",
      "rfq.manage",
      "po.manage",
      "grn.post",
      "stock.adjust",
      "requisition.manage",
    ],
  },
  { name: "Requisition approver", permissions: ["procurement.view", "requisition.approve"] },
  {
    name: "Finance officer",
    permissions: ["finance.view", "invoice.issue", "invoice.record_payment"],
  },
  { name: "Supply viewer", permissions: ["procurement.view", "finance.view"] },
]);

const MATERIALS = {
  felix: [
    ["FAB-101", "Cotton jersey 180 gsm", "Fabric", "m", 800, 120, 1450],
    ["FAB-204", "Poly-cotton twill", "Fabric", "m", 600, 90, 990],
    ["TRM-010", "Polyester thread 5000 m", "Trims", "roll", 150, null, 410],
    ["TRM-022", "Woven main label", "Trims", "pcs", 8000, 900, 6.2],
    ["PKG-001", "Poly bag 12 x 16 in", "Packing", "pcs", 4000, 700, 11.5],
    ["PKG-010", "Export carton 5 ply", "Packing", "pcs", 300, 25, 182],
  ],
  orbit: [
    ["YRN-300", "Cotton yarn 30s", "Yarn", "kg", 600, 150, 520],
    ["YRN-410", "Acrylic yarn 2/28", "Yarn", "kg", 300, 60, 460],
    ["TRM-050", "Care label", "Trims", "pcs", 3000, 400, 2.8],
    ["PKG-020", "Export carton 3 ply", "Packing", "pcs", 150, 20, 52],
  ],
};

const SUPPLIERS = {
  felix: [
    ["SUP-LTM", "Lanka Textile Mills", "Net 30", "Nimal Perera", "sales@lankatextile.example"],
    ["SUP-CTP", "Ceylon Trims & Packaging", "Net 14", "Dilani Silva", "orders@ceylontrims.example"],
    ["SUP-GFL", "Global Fabrics Lanka", "Net 45", "Kasun Fernando", "quotes@globalfabrics.example"],
  ],
  orbit: [
    ["SUP-DYT", "Dhaka Yarn Traders", "Net 30", "Rafiq Ahmed", "sales@dhakayarn.example"],
    ["SUP-BPK", "Bengal Packaging", "Net 15", "Shirin Akter", "orders@bengalpack.example"],
  ],
};

// Opening stock, recorded 30 days back, before anything else moves (D89).
const OPENING = {
  felix: {
    KAT: { "FAB-101": 400, "TRM-010": 20, "TRM-022": 3000, "PKG-001": 500, "PKG-010": 80 },
    KAN: { "PKG-010": 60 },
  },
  orbit: { GAZ: { "YRN-300": 800, "YRN-410": 300, "TRM-050": 5000, "PKG-020": 200 } },
};

const OPENING_DAYS_BACK = 30;
const ratio = (value, share) => Math.round(value * share * 100) / 100;

export function seedSupply({ app, admin, plan, structure, today, signIn }) {
  const slug = plan.spec.slug;
  const day = (offset) => addDays(today, offset);
  const acting = new Map();
  const contextOf = (email) => {
    if (!acting.has(email)) acting.set(email, app.identity.enterTenant(signIn(email), { slug }));
    return acting.get(email);
  };
  const { procurement, inventory, finance } = app;
  const factory = (code) => structure.factories.get(code).id;

  // ---- Master data and opening stock ---------------------------------------------------------
  const materials = new Map();
  for (const [code, name, category, unit, reorderLevel, dailyUse, standardCost] of MATERIALS[
    slug
  ]) {
    materials.set(
      code,
      procurement.createMaterial(admin, {
        code,
        name,
        category,
        unit,
        reorderLevel,
        dailyUse: dailyUse ?? undefined,
        standardCost,
      })
    );
  }
  const suppliers = new Map();
  for (const [code, name, paymentTerms, contactName, email] of SUPPLIERS[slug]) {
    suppliers.set(
      code,
      procurement.createSupplier(admin, { code, name, paymentTerms, contactName, email })
    );
  }
  const mat = (code) => materials.get(code).id;
  const sup = (code) => suppliers.get(code).id;

  for (const [factoryCode, quantities] of Object.entries(OPENING[slug])) {
    for (const [code, quantity] of Object.entries(quantities)) {
      inventory.recordMovement(admin, {
        factoryId: factory(factoryCode),
        materialId: mat(code),
        type: "opening",
        quantity,
        date: day(-OPENING_DAYS_BACK),
        reason: "Opening balance from the stock count",
      });
    }
  }

  // Small helpers that follow a document through its steps.
  const receive = (ctx, poId, receiptDate, lines, challan) => {
    const detail = procurement.purchaseOrder(ctx, poId);
    const receipt = procurement.createReceipt(ctx, {
      poId,
      receiptDate,
      challan,
      lines: lines.map(([code, received, rejected, rejectionReason]) => ({
        poLineId: detail.lines.find((line) => line.materialCode === code).id,
        received,
        rejected,
        rejectionReason,
      })),
    });
    procurement.receiveReceipt(ctx, receipt.id);
    return receipt;
  };
  const directPo = (ctx, spec) => {
    const po = procurement.createPurchaseOrder(ctx, {
      factoryId: factory(spec.factory),
      supplierId: sup(spec.supplier),
      orderDate: day(spec.ordered),
      expectedDate: day(spec.expected),
      note: spec.note,
      lines: spec.lines.map(([code, quantity, unitPrice]) => ({
        materialId: mat(code),
        quantity,
        unitPrice,
      })),
    });
    return po;
  };

  if (slug === "felix") seedFelix();
  else seedOrbit();

  // ================================================================================================
  // Felix: Katunayake works the requests, orders and stores; Kandy has an order on the way.
  // ================================================================================================
  function seedFelix() {
    const buyer = contextOf("manager@felix.example");
    const approver = contextOf("engineer@felix.example");
    const kat = factory("KAT");
    const kan = factory("KAN");

    // RFQ-0001: two suppliers quoted, one awarded, the order issued and part of it delivered.
    const rfq1 = procurement.createRfq(buyer, {
      factoryId: kat,
      requestDate: day(-28),
      dueDate: day(-21),
      supplierIds: [sup("SUP-LTM"), sup("SUP-GFL")],
      note: "Fabric for the December export orders",
      lines: [
        { materialId: mat("FAB-101"), quantity: 3000 },
        { materialId: mat("FAB-204"), quantity: 2000 },
      ],
    });
    procurement.sendRfq(buyer, rfq1.id);
    const lines1 = procurement.rfq(buyer, rfq1.id).lines;
    const line1 = (code) => lines1.find((line) => line.materialCode === code).id;
    const quoted = procurement.recordQuotation(buyer, rfq1.id, {
      supplierId: sup("SUP-LTM"),
      date: day(-25),
      validUntil: day(30),
      lines: [
        { rfqLineId: line1("FAB-101"), quantity: 3000, unitPrice: 1450, leadDays: 14 },
        { rfqLineId: line1("FAB-204"), quantity: 2000, unitPrice: 990, leadDays: 14 },
      ],
    });
    procurement.recordQuotation(buyer, rfq1.id, {
      supplierId: sup("SUP-GFL"),
      date: day(-24),
      validUntil: day(20),
      lines: [
        { rfqLineId: line1("FAB-101"), quantity: 3000, unitPrice: 1420, leadDays: 21 },
        { rfqLineId: line1("FAB-204"), quantity: 2000, unitPrice: 1010, leadDays: 21 },
      ],
    });
    const awarded = procurement.awardQuotation(buyer, quoted.id);
    const po1 = awarded.purchaseOrder;
    procurement.issuePurchaseOrder(buyer, po1.id);
    const grn1 = receive(
      buyer,
      po1.id,
      today,
      [
        ["FAB-101", 1500, 40, "Shade variation against the swatch"],
        ["FAB-204", 1000],
      ],
      "LTM-CH-5521"
    );
    procurement.postReceipt(buyer, grn1.id);
    // The next delivery is still on the dock, not yet posted to stock.
    receive(buyer, po1.id, today, [["FAB-204", 600]], "LTM-CH-5530");

    // RFQ-0002: sent, one quotation in, nothing awarded yet.
    const rfq2 = procurement.createRfq(buyer, {
      factoryId: kat,
      requestDate: day(-6),
      dueDate: day(3),
      supplierIds: [sup("SUP-CTP"), sup("SUP-GFL")],
      note: "Trims for the next shipment",
      lines: [
        { materialId: mat("TRM-010"), quantity: 400 },
        { materialId: mat("TRM-022"), quantity: 20000 },
      ],
    });
    procurement.sendRfq(buyer, rfq2.id);
    const lines2 = procurement.rfq(buyer, rfq2.id).lines;
    procurement.recordQuotation(buyer, rfq2.id, {
      supplierId: sup("SUP-CTP"),
      date: day(-3),
      validUntil: day(25),
      lines: lines2.map((line) => ({
        rfqLineId: line.id,
        quantity: line.quantity,
        unitPrice: line.materialCode === "TRM-010" ? 415 : 6.1,
        leadDays: 7,
      })),
    });

    // RFQ-0003: a draft for Kandy. RFQ-0004: sent and then cancelled.
    procurement.createRfq(admin, {
      factoryId: kan,
      requestDate: day(0),
      dueDate: day(7),
      supplierIds: [sup("SUP-CTP")],
      note: "Packing for the Kandy orders",
      lines: [
        { materialId: mat("PKG-001"), quantity: 5000 },
        { materialId: mat("PKG-010"), quantity: 300 },
      ],
    });
    const rfq4 = procurement.createRfq(buyer, {
      factoryId: kat,
      requestDate: day(-15),
      dueDate: day(-9),
      supplierIds: [sup("SUP-GFL")],
      lines: [{ materialId: mat("FAB-101"), quantity: 800 }],
    });
    procurement.sendRfq(buyer, rfq4.id);
    procurement.cancelRfq(buyer, rfq4.id, { reason: "The buyer reduced the order quantity" });

    // Direct orders: a complete delivery, a delivery counted wrongly and put right, one waiting for
    // goods, a draft and a cancelled one.
    const po2 = directPo(buyer, {
      factory: "KAT",
      supplier: "SUP-CTP",
      ordered: -12,
      expected: -4,
      note: "Standard trims and packing",
      lines: [
        ["TRM-010", 300, 410],
        ["TRM-022", 15000, 6.2],
        ["PKG-001", 8000, 11.5],
      ],
    });
    procurement.issuePurchaseOrder(buyer, po2.id);
    const grn2 = receive(
      buyer,
      po2.id,
      day(-4),
      [
        ["TRM-010", 300],
        ["TRM-022", 15000],
        ["PKG-001", 8000],
      ],
      "CTP-CH-3302"
    );
    procurement.postReceipt(buyer, grn2.id);

    const po3 = directPo(buyer, {
      factory: "KAT",
      supplier: "SUP-CTP",
      ordered: -9,
      expected: -2,
      lines: [["PKG-010", 400, 182]],
    });
    procurement.issuePurchaseOrder(buyer, po3.id);
    const wrong = receive(buyer, po3.id, day(-2), [["PKG-010", 400]], "CTP-CH-3318");
    procurement.postReceipt(buyer, wrong.id);
    procurement.reverseReceipt(buyer, wrong.id, { reason: "Counted against the wrong order" });
    const grn4 = receive(
      buyer,
      po3.id,
      day(-1),
      [["PKG-010", 250, 10, "Crushed corners"]],
      "CTP-CH-3325"
    );
    procurement.postReceipt(buyer, grn4.id);

    const po4 = directPo(admin, {
      factory: "KAN",
      supplier: "SUP-GFL",
      ordered: -5,
      expected: 10,
      note: "Twill for the Kandy line",
      lines: [["FAB-204", 1200, 1005]],
    });
    procurement.issuePurchaseOrder(admin, po4.id);
    directPo(admin, {
      factory: "KAN",
      supplier: "SUP-CTP",
      ordered: 0,
      expected: 14,
      lines: [["PKG-001", 3000, 11.8]],
    });
    const cancelled = directPo(buyer, {
      factory: "KAT",
      supplier: "SUP-LTM",
      ordered: -3,
      expected: 12,
      lines: [["FAB-101", 500, 1460]],
    });
    procurement.cancelPurchaseOrder(buyer, cancelled.id, { reason: "Replaced by the RFQ award" });

    // Stores: packing out, a count correction, and the production requisitions.
    inventory.recordMovement(buyer, {
      factoryId: kat,
      materialId: mat("PKG-001"),
      type: "issue",
      quantity: 5200,
      date: day(-1),
      reason: "Issued to the packing section",
    });
    inventory.recordMovement(buyer, {
      factoryId: kat,
      materialId: mat("FAB-101"),
      type: "adjustment_out",
      quantity: 25,
      date: day(-3),
      reason: "Cutting room count came short",
    });
    inventory.recordMovement(admin, {
      factoryId: kan,
      materialId: mat("PKG-010"),
      type: "issue",
      quantity: 60,
      date: day(-2),
      reason: "Issued for the Kandy shipment",
    });

    const requisition = (ctx, factoryId, neededBy, lines, note) =>
      inventory.createRequisition(ctx, {
        factoryId,
        neededBy: day(neededBy),
        note,
        lines: lines.map(([code, quantity]) => ({ materialId: mat(code), quantity })),
      });
    const issued = requisition(buyer, kat, -1, [["FAB-204", 450]], "Cutting for PO-7781");
    inventory.submitRequisition(buyer, issued.id);
    inventory.approveRequisition(approver, issued.id);
    inventory.issueRequisition(approver, issued.id);
    const approved = requisition(
      buyer,
      kat,
      2,
      [
        ["PKG-010", 40],
        ["TRM-022", 2000],
      ],
      "Packing for PO-7790"
    );
    inventory.submitRequisition(buyer, approved.id);
    inventory.approveRequisition(approver, approved.id);
    const submitted = requisition(buyer, kat, 3, [["TRM-010", 30]], "Thread for the next style");
    inventory.submitRequisition(buyer, submitted.id);
    requisition(buyer, kat, 6, [["FAB-101", 200]], "Sample yardage");
    const rejected = requisition(buyer, kat, 1, [["PKG-001", 9000]], "Packing for the month");
    inventory.submitRequisition(buyer, rejected.id);
    inventory.rejectRequisition(approver, rejected.id, {
      reason: "Exceeds the weekly packing plan; raise one per order",
    });
    const dropped = requisition(admin, kan, 5, [["PKG-010", 10]], "Spare cartons");
    inventory.cancelRequisition(admin, dropped.id, { reason: "No longer needed" });

    seedFelixFinance({ po1, grn1, po2, grn2, po3, grn4 });
  }

  function seedFelixFinance({ po1, grn1, po2, grn2, po3, grn4 }) {
    const accounts = contextOf("finance@felix.example");
    const parties = finance.parties(accounts);
    const buyerId = (code) => parties.buyers.find((row) => row.code === code).id;
    const orderId = (buyerCode, reference) =>
      finance
        .sources(accounts, { buyerId: buyerId(buyerCode) })
        .orders.find((row) => row.reference === reference).id;
    const customer = (buyerCode, reference, fields) =>
      finance.createInvoice(accounts, {
        kind: "customer",
        buyerId: buyerId(buyerCode),
        orderId: reference === undefined ? undefined : orderId(buyerCode, reference),
        ...fields,
      });
    const issueFilled = (invoice) => {
      finance.fillInvoice(accounts, invoice.id);
      finance.issueInvoice(accounts, invoice.id);
    };
    const pay = (invoice, share, daysBack, method, reference) => {
      const total = finance.invoice(accounts, invoice.id).invoice.balance;
      return finance.recordPayment(accounts, invoice.id, {
        amount: share === 1 ? total : ratio(total, share),
        date: day(daysBack),
        method,
        reference,
        idempotencyKey: `seed-${invoice.id}-${daysBack}`,
      });
    };

    // A closed order, billed and paid in two instalments.
    const settled = customer("HARBOR", "PO-7710", { invoiceDate: day(-34), dueDate: day(-4) });
    issueFilled(settled);
    pay(settled, 0.4, -22, "bank_transfer", "TT-2231");
    pay(settled, 1, -6, "bank_transfer", "TT-2290");

    // An order in production, billed and part paid.
    const partial = customer("HARBOR", "PO-7781", { invoiceDate: day(-10), dueDate: day(20) });
    issueFilled(partial);
    pay(partial, 0.3, -3, "cheque", "CHQ-448812");

    // Past its due date with nothing paid.
    const overdue = customer("MEADOW", "PO-7790", { invoiceDate: day(-30), dueDate: day(-6) });
    issueFilled(overdue);

    // A draft not yet issued, and one cancelled before it was.
    const draft = customer("MEADOW", "PO-7815", { invoiceDate: day(0), dueDate: day(30) });
    finance.fillInvoice(accounts, draft.id);
    const mistaken = customer("ALPINE", undefined, {
      invoiceDate: day(-2),
      dueDate: day(28),
      lines: [{ description: "Sample charges", quantity: 1, unitPrice: 18500 }],
    });
    finance.cancelInvoice(accounts, mistaken.id, { reason: "Raised against the wrong buyer" });

    // Supplier invoices: traced to the receipts they bill.
    const supplier = (code, number, fields) =>
      finance.createInvoice(accounts, {
        kind: "supplier",
        supplierId: parties.suppliers.find((row) => row.code === code).id,
        supplierNumber: number,
        ...fields,
      });
    const fabric = supplier("SUP-LTM", "LTM/2211", {
      poId: po1.id,
      receiptId: grn1.id,
      invoiceDate: day(0),
      dueDate: day(30),
    });
    issueFilled(fabric);
    pay(fabric, 0.5, 0, "bank_transfer", "TT-2311");

    const trims = supplier("SUP-CTP", "CTP-20931", {
      poId: po2.id,
      receiptId: grn2.id,
      invoiceDate: day(-4),
      dueDate: day(10),
    });
    issueFilled(trims);
    pay(trims, 1, -1, "bank_transfer", "TT-2305");

    const cartons = supplier("SUP-CTP", "CTP-20977", {
      poId: po3.id,
      receiptId: grn4.id,
      invoiceDate: day(-1),
      dueDate: day(13),
    });
    finance.fillInvoice(accounts, cartons.id);

    const swatches = supplier("SUP-GFL", "GFL-77", {
      invoiceDate: day(-8),
      dueDate: day(-1),
      lines: [{ description: "Fabric swatch charges", quantity: 1, unitPrice: 6400 }],
    });
    finance.issueInvoice(accounts, swatches.id);
  }

  // ================================================================================================
  // Orbit: one factory, one request awarded, one direct order, one requisition, two invoices.
  // ================================================================================================
  function seedOrbit() {
    const buyer = contextOf("manager@orbit.example");
    const gaz = factory("GAZ");

    const rfq = procurement.createRfq(buyer, {
      factoryId: gaz,
      requestDate: day(-20),
      dueDate: day(-14),
      supplierIds: [sup("SUP-DYT"), sup("SUP-BPK")],
      note: "Yarn for the winter knitwear programme",
      lines: [
        { materialId: mat("YRN-300"), quantity: 2500 },
        { materialId: mat("YRN-410"), quantity: 1200 },
      ],
    });
    procurement.sendRfq(buyer, rfq.id);
    const lines = procurement.rfq(buyer, rfq.id).lines;
    const line = (code) => lines.find((row) => row.materialCode === code).id;
    const best = procurement.recordQuotation(buyer, rfq.id, {
      supplierId: sup("SUP-DYT"),
      date: day(-17),
      validUntil: day(30),
      lines: [
        { rfqLineId: line("YRN-300"), quantity: 2500, unitPrice: 520, leadDays: 10 },
        { rfqLineId: line("YRN-410"), quantity: 1200, unitPrice: 460, leadDays: 12 },
      ],
    });
    procurement.recordQuotation(buyer, rfq.id, {
      supplierId: sup("SUP-BPK"),
      date: day(-16),
      lines: [{ rfqLineId: line("YRN-300"), quantity: 2500, unitPrice: 545, leadDays: 8 }],
    });
    const po1 = procurement.awardQuotation(buyer, best.id).purchaseOrder;
    procurement.issuePurchaseOrder(buyer, po1.id);
    const grn1 = receive(
      buyer,
      po1.id,
      today,
      [
        ["YRN-300", 2500],
        ["YRN-410", 1100, 100, "Moisture above tolerance"],
      ],
      "DYT-CH-880"
    );
    procurement.postReceipt(buyer, grn1.id);

    const po2 = directPo(buyer, {
      factory: "GAZ",
      supplier: "SUP-BPK",
      ordered: -6,
      expected: -1,
      lines: [["PKG-020", 300, 52]],
    });
    procurement.issuePurchaseOrder(buyer, po2.id);
    const grn2 = receive(buyer, po2.id, day(-1), [["PKG-020", 300]], "BPK-CH-114");
    procurement.postReceipt(buyer, grn2.id);

    const req = inventory.createRequisition(buyer, {
      factoryId: gaz,
      neededBy: day(-1),
      note: "Knit Hall 1 programme",
      lines: [{ materialId: mat("YRN-300"), quantity: 600 }],
    });
    inventory.submitRequisition(buyer, req.id);
    inventory.approveRequisition(admin, req.id);
    inventory.issueRequisition(admin, req.id);
    const waiting = inventory.createRequisition(buyer, {
      factoryId: gaz,
      neededBy: day(2),
      lines: [{ materialId: mat("TRM-050"), quantity: 1500 }],
    });
    inventory.submitRequisition(buyer, waiting.id);

    const parties = finance.parties(admin);
    const nordic = parties.buyers.find((row) => row.code === "NORDIC").id;
    const orders = finance.sources(admin, { buyerId: nordic }).orders;
    const invoice = finance.createInvoice(admin, {
      kind: "customer",
      buyerId: nordic,
      orderId: orders.find((row) => row.reference === "PO-B-410").id,
      invoiceDate: day(-9),
      dueDate: day(21),
    });
    finance.fillInvoice(admin, invoice.id);
    finance.issueInvoice(admin, invoice.id);
    const balance = finance.invoice(admin, invoice.id).invoice.balance;
    finance.recordPayment(admin, invoice.id, {
      amount: ratio(balance, 0.5),
      date: day(-2),
      method: "bank_transfer",
      reference: "BEFTN-5581",
      idempotencyKey: `seed-${invoice.id}`,
    });
    const supplierInvoice = finance.createInvoice(admin, {
      kind: "supplier",
      supplierId: parties.suppliers.find((row) => row.code === "SUP-DYT").id,
      supplierNumber: "DYT-5521",
      poId: po1.id,
      receiptId: grn1.id,
      invoiceDate: day(0),
      dueDate: day(30),
    });
    finance.fillInvoice(admin, supplierInvoice.id);
    finance.issueInvoice(admin, supplierInvoice.id);
  }
}
