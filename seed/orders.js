// The orders and planning part of the demo world (D72 to D82): buyers linked to the styles the
// production part created, Time and Action templates, buyer orders in every status, buyer approvals
// in every state and capacity bookings that show a healthy line, a nearly full one, an overloaded one
// and two bookings that clash.
//
// Everything goes through the services, exactly as a planner and the approval desk would do it, so
// the rules, the history and the audit trail are the real ones. The order references match the
// references in the production plans (seed/production.js), so the approved production days count as
// pieces made against each order line (D76).
// Dates are days from the organization's own business date, so the world looks the same whenever it
// is created. Kept small: LocalStorage holds about 5 MB.
// Browser-safe: no Node imports.
import { addDays } from "../domain/effective-dating.js";

// Standard roles carry no order rights, so the demo adds two custom ones (the approval desk is the
// tenant administrator, who alone may record a buyer's decision).
export const ORDER_ROLES = Object.freeze([
  {
    name: "Order planner",
    permissions: ["order.view", "order.manage", "planning.manage", "capacity.manage"],
  },
  { name: "Order viewer", permissions: ["order.view"] },
]);

const APPROVAL_TYPES = [
  {
    code: "LAB",
    name: "Lab dip and fabric",
    blocking: true,
    description: "Colour and fabric match the buyer's swatch",
  },
  {
    code: "PPS",
    name: "Pre-production sample",
    blocking: true,
    description: "Buyer signs off the sample before bulk starts",
  },
  {
    code: "FIT",
    name: "Fit sample",
    blocking: false,
    description: "Fit and measurements on the buyer's block",
  },
  {
    code: "WSH",
    name: "Wash and shrinkage test",
    blocking: false,
    description: "Shrinkage and colour fastness results",
  },
  {
    code: "PKG",
    name: "Packing and labelling",
    blocking: false,
    description: "Cartons, labels and hang tags",
  },
];

// [code, milestone, days after the order date, blocks production, responsible role]
const TEMPLATES = {
  felix: [
    {
      name: "Standard export order",
      description: "Cut-and-sew bulk order for an export buyer",
      lines: [
        ["LAB", "Lab dip and fabric approved", 5, true, "Merchandiser"],
        ["PPS", "Pre-production sample approved", 12, true, "Merchandiser"],
        ["FABIN", "Fabric in house", 14, true, "Stores"],
        ["CUT", "Cutting starts", 18, false, "Cutting manager"],
        ["SEW", "Sewing starts", 20, false, "Production manager"],
        ["INLN", "In-line inspection", 32, false, "Quality manager"],
        ["FINL", "Final inspection", 42, false, "Quality manager"],
        ["EXF", "Ex-factory", 48, false, "Shipping"],
      ],
    },
    {
      name: "Sample and development order",
      description: "Samples sent to a buyer for comment",
      lines: [
        ["SMP", "Sample sent", 7, false, "Merchandiser"],
        ["CMT", "Buyer comments received", 14, false, "Merchandiser"],
        ["REV", "Revised sample sent", 21, false, "Merchandiser"],
      ],
    },
  ],
  orbit: [
    {
      name: "Knitwear bulk order",
      description: "Knitted garments from yarn to dispatch",
      lines: [
        ["YARN", "Yarn in house", 4, true, "Stores"],
        ["PPS", "Pre-production sample approved", 10, true, "Merchandiser"],
        ["KNIT", "Knitting starts", 14, false, "Knitting manager"],
        ["LINK", "Linking starts", 21, false, "Production manager"],
        ["FINL", "Final inspection", 30, false, "Quality manager"],
        ["EXF", "Ex-factory", 35, false, "Shipping"],
      ],
    },
  ],
};

const BUYERS = {
  felix: [
    {
      code: "HARBOR",
      name: "Harbor Brands",
      country: "United States",
      contactName: "Dana Whitfield",
      contactEmail: "dana@harbor-brands.example",
      styles: ["ST-4501", "ST-4510"],
    },
    {
      code: "MEADOW",
      name: "Meadow Retail",
      country: "United Kingdom",
      contactName: "Owen Marsh",
      contactEmail: "owen@meadow-retail.example",
      styles: ["ST-4502"],
    },
    {
      code: "ALPINE",
      name: "Alpine Outfitters",
      country: "Germany",
      contactName: "Greta Brandt",
      contactEmail: "greta@alpine-outfitters.example",
      styles: ["ST-4520"],
    },
    {
      code: "COAST",
      name: "Coastline Apparel",
      country: "Australia",
      contactName: "Mia Tran",
      contactEmail: "mia@coastline.example",
      styles: [],
    },
  ],
  orbit: [
    {
      code: "NORDIC",
      name: "Nordic Knits",
      country: "Sweden",
      contactName: "Elin Berg",
      contactEmail: "elin@nordic-knits.example",
      styles: ["KN-210", "KN-225"],
    },
    {
      code: "LAKE",
      name: "Lakeside Co",
      country: "Canada",
      contactName: "Noah Clarke",
      contactEmail: "noah@lakeside.example",
      styles: ["KN-240"],
    },
  ],
};

const approved = (remarks) => ({ decision: "approved", remarks });

// `ordered` and `ship` are days from today. `done` are the milestone codes completed, in template
// order; `status` is where the order ends up, walked one step at a time. `by` is who plans it.
const ORDERS = {
  felix: [
    {
      ref: "PO-7781",
      factory: "KAT",
      buyer: "HARBOR",
      po: "HB-55102",
      ordered: -30,
      ship: 24,
      currency: "USD",
      lines: [["ST-4501", 18000, 6.85]],
      template: "Standard export order",
      done: ["LAB", "PPS", "FABIN", "CUT", "SEW"],
      status: "in_production",
      progress: { INLN: "in_progress" },
      revise: { FINL: [12, "Buyer moved the final inspection"] },
      approvals: [
        { type: "LAB", due: -26, steps: [approved("Lab dip matches the swatch")] },
        {
          type: "PPS",
          due: -18,
          note: "First sample couriered",
          steps: [
            { decision: "revision_requested", remarks: "Waistband to be 1 cm wider" },
            { resubmit: -12, note: "Revised sample couriered" },
            approved("Revised sample accepted"),
          ],
        },
        { type: "FIT", due: -14, steps: [approved("Fit is fine on the block")] },
      ],
      bookings: [
        {
          line: "KAT/SEW/Line 1",
          from: -24,
          to: 1,
          operators: 28,
          efficiency: 78,
          hours: 9,
          status: "confirmed",
        },
      ],
    },
    {
      ref: "PO-7790",
      factory: "KAT",
      buyer: "MEADOW",
      po: "MR-2207",
      ordered: -28,
      ship: 18,
      currency: "USD",
      lines: [["ST-4502", 15000, 3.1]],
      template: "Standard export order",
      done: ["LAB", "PPS", "FABIN", "CUT", "SEW"],
      status: "in_production",
      approvals: [
        { type: "LAB", due: -24, steps: [approved("Colour approved")] },
        { type: "PPS", due: -16, steps: [approved("Sample approved")] },
        { type: "WSH", due: -2, note: "Results due from the buyer's lab" },
      ],
      bookings: [
        {
          line: "KAT/SEW/Line 2",
          from: -8,
          to: 6,
          operators: 30,
          efficiency: 80,
          hours: 9,
          status: "confirmed",
        },
      ],
    },
    {
      ref: "PO-7802",
      factory: "KAT",
      buyer: "HARBOR",
      po: "HB-55140",
      ordered: -26,
      ship: 20,
      currency: "USD",
      lines: [["ST-4510", 9000, 7.4]],
      template: "Standard export order",
      done: ["LAB", "PPS", "FABIN", "CUT"],
      status: "in_production",
      progress: { SEW: "in_progress" },
      approvals: [
        { type: "LAB", due: -22, steps: [approved("Approved")] },
        { type: "PPS", due: -14, steps: [approved("Approved with the comments in the email")] },
        {
          type: "FIT",
          due: -6,
          steps: [{ decision: "rejected", remarks: "Sleeve length is 1 cm short" }],
        },
        { type: "FIT", due: 4, note: "Corrected sleeve pattern" },
      ],
      bookings: [
        {
          line: "KAT/SEW/Line 3",
          from: -2,
          to: 9,
          operators: 26,
          efficiency: 74,
          hours: 9,
          status: "confirmed",
        },
      ],
    },
    {
      ref: "PO-7830",
      factory: "KAT",
      buyer: "HARBOR",
      po: "HB-55188",
      ordered: -9,
      ship: 40,
      currency: "USD",
      lines: [["ST-4510", 6000, 7.55]],
      template: "Standard export order",
      done: ["LAB"],
      status: "confirmed",
      progress: { FABIN: "blocked" },
      approvals: [
        { type: "LAB", due: -4, steps: [approved("Approved")] },
        { type: "PPS", due: 3, note: "Sample sent by courier" },
      ],
      bookings: [
        {
          line: "KAT/SEW/Line 1",
          from: 2,
          to: 16,
          operators: 28,
          efficiency: 78,
          hours: 9,
          status: "planned",
        },
      ],
    },
    {
      ref: "PO-7845",
      factory: "KAT",
      buyer: "MEADOW",
      po: null,
      ordered: 0,
      ship: 55,
      currency: "USD",
      lines: [["ST-4502", 8000, 3.25]],
      note: "Spring programme, waiting for the buyer's PO",
      status: "draft",
      bookings: [
        {
          line: "KAT/SEW/Line 1",
          from: 3,
          to: 8,
          operators: 28,
          efficiency: 78,
          hours: 9,
          status: "cancelled",
        },
        {
          line: "KAT/SEW/Line 3",
          from: 5,
          to: 12,
          operators: 26,
          efficiency: 74,
          hours: 9,
          status: "planned",
        },
      ],
    },
    {
      ref: "PO-7710",
      factory: "KAT",
      buyer: "HARBOR",
      po: "HB-54870",
      ordered: -80,
      ship: -30,
      currency: "USD",
      lines: [["ST-4501", 6000, 6.6, "completed"]],
      template: "Standard export order",
      done: ["LAB", "PPS", "FABIN", "CUT", "SEW", "INLN", "FINL", "EXF"],
      status: "closed",
      approvals: [
        { type: "LAB", due: -75, steps: [approved("Approved")] },
        { type: "PPS", due: -68, steps: [approved("Approved")] },
      ],
    },
    {
      ref: "PO-7699",
      factory: "KAT",
      buyer: "MEADOW",
      po: "MR-2144",
      ordered: -40,
      ship: -5,
      currency: "USD",
      lines: [["ST-4502", 4000, 3]],
      status: "cancelled",
      reason: "The buyer cancelled the season's programme",
    },
    {
      ref: "PO-7815",
      factory: "KAN",
      buyer: "MEADOW",
      po: "MR-2231",
      ordered: -20,
      ship: 21,
      currency: "USD",
      lines: [["ST-4502", 10000, 3.15]],
      template: "Standard export order",
      done: ["LAB", "PPS", "FABIN", "CUT"],
      status: "in_production",
      progress: { SEW: "in_progress" },
      approvals: [
        { type: "LAB", due: -16, steps: [approved("Approved")] },
        { type: "PPS", due: -9, steps: [approved("Approved")] },
        {
          type: "PKG",
          due: 5,
          steps: [
            { decision: "revision_requested", remarks: "Carton marks must carry the PO number" },
          ],
        },
      ],
      bookings: [
        {
          line: "KAN/SEW/Line 1",
          from: -10,
          to: 9,
          operators: 22,
          efficiency: 76,
          hours: 9,
          status: "confirmed",
        },
      ],
    },
    {
      ref: "PO-7820",
      factory: "KAN",
      buyer: "ALPINE",
      po: "AO-9012",
      ordered: -14,
      ship: 30,
      currency: "USD",
      lines: [["ST-4520", 5000, 14.2]],
      template: "Standard export order",
      done: ["LAB", "PPS", "FABIN"],
      status: "in_production",
      approvals: [
        { type: "LAB", due: -9, steps: [approved("Approved")] },
        { type: "PPS", due: -2, steps: [approved("Approved")] },
      ],
      bookings: [
        {
          line: "KAN/SEW/Line 2",
          from: 1,
          to: 20,
          operators: 20,
          efficiency: 70,
          hours: 9,
          status: "planned",
        },
      ],
    },
    {
      ref: "PO-7825",
      factory: "KAN",
      buyer: "ALPINE",
      po: null,
      ordered: 0,
      ship: 60,
      currency: "USD",
      lines: [["ST-4520", 3000, 14]],
      template: "Sample and development order",
      status: "draft",
    },
  ],
  orbit: [
    {
      ref: "PO-B-410",
      factory: "GAZ",
      buyer: "NORDIC",
      po: "NK-3301",
      ordered: -25,
      ship: 20,
      currency: "USD",
      lines: [["KN-210", 20000, 11.4]],
      template: "Knitwear bulk order",
      done: ["YARN", "PPS", "KNIT"],
      status: "in_production",
      approvals: [
        { type: "LAB", due: -22, steps: [approved("Yarn colour approved")] },
        { type: "PPS", due: -14, steps: [approved("Sample approved")] },
        { type: "WSH", due: -8, steps: [approved("Shrinkage within tolerance")] },
      ],
      bookings: [
        {
          line: "GAZ/KNT/Knit Hall 1",
          from: -14,
          to: 14,
          operators: 40,
          efficiency: 70,
          hours: 24,
          status: "confirmed",
        },
      ],
    },
    {
      ref: "PO-B-415",
      factory: "GAZ",
      buyer: "NORDIC",
      po: "NK-3318",
      ordered: -18,
      ship: 26,
      currency: "USD",
      lines: [["KN-225", 14000, 13.1]],
      template: "Knitwear bulk order",
      done: ["YARN", "PPS"],
      status: "in_production",
      progress: { KNIT: "in_progress" },
      approvals: [
        { type: "LAB", due: -15, steps: [approved("Approved")] },
        { type: "PPS", due: -8, steps: [approved("Approved")] },
      ],
      bookings: [
        {
          line: "GAZ/KNT/Knit Hall 2",
          from: -10,
          to: 16,
          operators: 36,
          efficiency: 68,
          hours: 24,
          status: "confirmed",
        },
      ],
    },
    {
      ref: "PO-B-422",
      factory: "GAZ",
      buyer: "LAKE",
      po: "LC-770",
      ordered: -12,
      ship: 22,
      currency: "USD",
      lines: [["KN-240", 15000, 7.2]],
      template: "Knitwear bulk order",
      done: ["YARN", "PPS"],
      status: "in_production",
      approvals: [{ type: "PPS", due: -4, steps: [approved("Approved")] }],
      bookings: [
        {
          line: "GAZ/LNK/Linking Floor",
          from: -8,
          to: 14,
          operators: 24,
          efficiency: 72,
          hours: 16,
          status: "confirmed",
        },
      ],
    },
    {
      ref: "PO-B-430",
      factory: "GAZ",
      buyer: "LAKE",
      po: "LC-784",
      ordered: -3,
      ship: 45,
      currency: "USD",
      lines: [["KN-240", 12000, 7.35]],
      template: "Knitwear bulk order",
      done: ["YARN"],
      status: "confirmed",
      approvals: [{ type: "PPS", due: 6, note: "Sample to follow" }],
    },
    {
      ref: "PO-B-435",
      factory: "GAZ",
      buyer: "NORDIC",
      po: null,
      ordered: 0,
      ship: 70,
      currency: "USD",
      lines: [["KN-210", 8000, 11.6]],
      status: "draft",
    },
  ],
};

const STEPS = ["confirmed", "in_production", "shipped", "closed"];

export function seedOrders({ app, admin, plan, structure, today, signIn }) {
  const slug = plan.spec.slug;
  const orders = app.orders;
  const acting = new Map();
  const contextOf = (email) => {
    if (!acting.has(email)) acting.set(email, app.identity.enterTenant(signIn(email), { slug }));
    return acting.get(email);
  };
  // The Felix planner works the Katunayake orders; everything else is planned by the administrator.
  const plannerOf = (spec) =>
    slug === "felix" && spec.factory === "KAT"
      ? contextOf("manager@felix.example")
      : slug === "orbit" && spec.factory === "GAZ"
        ? contextOf("manager@orbit.example")
        : admin;

  // ---- Buyers, and the styles they own -------------------------------------------------------
  const buyers = new Map();
  const styleIds = new Map(orders.styles(admin).map((style) => [style.code, style.id]));
  for (const { styles, ...spec } of BUYERS[slug]) {
    const buyer = orders.createBuyer(admin, spec);
    buyers.set(spec.code, buyer);
    for (const code of styles) orders.updateStyle(admin, styleIds.get(code), { buyerId: buyer.id });
  }

  // ---- Approval types and Time and Action templates -----------------------------------------
  const types = new Map();
  for (const spec of APPROVAL_TYPES) types.set(spec.code, orders.createApprovalType(admin, spec));
  const templates = new Map();
  for (const spec of TEMPLATES[slug]) {
    const template = orders.createTemplate(admin, {
      name: spec.name,
      description: spec.description,
    });
    spec.lines.forEach(([code, name, offsetDays, blocking, responsibleRole], index) => {
      orders.addDefinition(admin, template.id, {
        code,
        name,
        offsetDays,
        blocking,
        responsibleRole,
        sequence: (index + 1) * 10,
      });
    });
    templates.set(spec.name, template);
  }

  // ---- Orders --------------------------------------------------------------------------------
  for (const spec of ORDERS[slug]) {
    const planner = plannerOf(spec);
    const order = orders.createOrder(planner, {
      factoryId: structure.factories.get(spec.factory).id,
      buyerId: buyers.get(spec.buyer).id,
      reference: spec.ref,
      buyerPo: spec.po ?? undefined,
      orderDate: addDays(today, spec.ordered),
      shipDate: addDays(today, spec.ship),
      currency: spec.currency,
      note: spec.note,
    });

    const lines = spec.lines.map(([style, quantity, unitPrice, state]) => ({
      row: orders.addLine(planner, order.id, { styleId: styleIds.get(style), quantity, unitPrice }),
      state,
    }));

    if (spec.template !== undefined) {
      orders.applyTemplate(planner, order.id, templates.get(spec.template).id);
    }
    const milestones = () =>
      new Map(orders.milestones(planner, { orderId: order.id }).map((row) => [row.code, row]));

    // Approvals first: a request is refused once the order has shipped.
    for (const request of spec.approvals ?? []) {
      let row = orders.requestApproval(planner, order.id, {
        typeId: types.get(request.type).id,
        dueDate: addDays(today, request.due),
        note: request.note,
      });
      for (const step of request.steps ?? []) {
        row =
          step.resubmit === undefined
            ? orders.decideApproval(admin, row.id, step)
            : orders.resubmitApproval(planner, row.id, {
                dueDate: addDays(today, step.resubmit),
                note: step.note,
              });
      }
    }

    for (const code of spec.done ?? []) {
      const milestone = milestones().get(code);
      const planned = milestone.plannedDate;
      orders.completeMilestone(planner, milestone.id, {
        actualDate: planned > today ? today : planned,
      });
    }
    for (const [code, status] of Object.entries(spec.progress ?? {})) {
      orders.setMilestoneStatus(planner, milestones().get(code).id, { status });
    }
    for (const [code, [days, reason]] of Object.entries(spec.revise ?? {})) {
      orders.reviseMilestone(planner, milestones().get(code).id, {
        revisedDate: addDays(today, days),
        reason,
      });
    }

    for (const booking of spec.bookings ?? []) {
      const productionLineId = structure.lines.get(booking.line).id;
      const factoryId = structure.factories.get(spec.factory).id;
      const options = orders.planningOptions(planner, { factoryId });
      const made = orders.createBooking(planner, {
        orderId: order.id,
        lineId: lines[0].row.id,
        productionLineId,
        calendarId: options.calendars[0].id,
        startDate: addDays(today, booking.from),
        endDate: addDays(today, booking.to),
        operators: booking.operators,
        efficiency: booking.efficiency,
        hoursPerDay: booking.hours,
      });
      if (booking.status !== "planned") {
        orders.setBookingStatus(planner, made.id, { status: booking.status });
      }
    }

    // Lines that finished before the order shipped.
    for (const line of lines) {
      if (line.state !== undefined && spec.status !== "cancelled") {
        orders.setLineStatus(planner, line.row.id, { status: line.state });
      }
    }

    if (spec.status === "cancelled") {
      orders.setOrderStatus(planner, order.id, { status: "cancelled", reason: spec.reason });
    } else {
      for (const step of STEPS.slice(0, STEPS.indexOf(spec.status) + 1)) {
        orders.setOrderStatus(planner, order.id, { status: step });
      }
    }
  }
}
