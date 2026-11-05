# OPEX+ prototype

Rebuild of the OPEX+ (Operational Performance Excellence System) demonstration prototype, built from
scratch against the requirements documents. It replaced the earlier `felix-erp-prototype/` after the
parity gate in `docs/engineering/plans/prototype-rebuild.md` (section 7) passed and the user approved the
removal on 2026-11-05. The earlier prototype was removed from the working tree after commit `0b4283e`
and stays in git history. See [Parity gate](#parity-gate).

The prototype is a static, build-free application (vanilla ES modules, LocalStorage, hash routing). It
is independent of the Django/DRF and React production application and does not prove that production
features exist.

## Status

Slices **S0** (foundation and test harness), **S1.1** (tenancy, identity and organization services),
**S1.2** (the first screens: sign-in, entry chooser, tenant administration and platform
administration), **S2** (workforce: employees, supervisor assignments and attendance), **S3**
(production core and the supervisor experience: style master, plans with revisions, the production
dashboard, hourly entry, events, Daily Close, submit, approve, return and privileged correction) and
**S4** (KPIs and scorecards: My Scorecard, the Management Scorecard with supervisor drill-down, score
exceptions, versioned score configuration with KPI target history, and snapshots) are built, and so is
**S5.1** (the three dashboards: Tenant administrator overview, Production and line performance, and
Supervisor and workforce, with a date and factory filter row, inline SVG charts and a table view of
every chart). **S5.2** adds communication and reports: a notification centre with preferences and an
unread count in the menu, operational comments with employee tags, CSV exports, scheduled reports,
and, for administrators, notification text and the delivery history. Email is only simulated: a
delivery is recorded as sandboxed and nothing leaves the browser. **S6** adds orders and planning,
under an ORDERS & PLANNING group: buyers, styles with SMV, buyer orders (an order page holds lines with
production progress, milestones, approvals and capacity bookings), time-and-action templates, buyer
approvals with a decision history, and capacity and loading with overload and clash warnings; the tenant
dashboard's orders card shows live figures. **S7** adds supply chain and finance: under SUPPLY CHAIN,
materials, suppliers, requisitions, RFQs, quotations, purchase orders, goods receipts, store and stock,
and stock movements; under FINANCE, invoices and payments; RFQs, purchase orders, receipts,
requisitions and invoices each have a detail page. A supplier is asked for a price on an RFQ, a
quotation is recorded and one is awarded, the award makes a draft purchase order, goods are received,
inspected and posted to the store, and stock is only ever the sum of its movements (a posted receipt is
undone by a reversal, never by an edit). A requisition is approved and then issued from stock. Customer
and supplier invoices take payments and show their balance, with a comparison to the order, purchase
order or receipt they relate to (traceability only, never a payment block). The tenant dashboard has
live stock and invoice cards. **S8** adds the platform services and the quality attributes. Under
ADMINISTRATION: an Audit log page (filter by action, person and date, with a details dialog for each event),
Integrations (a list of connections and a page for each one) and Files / imports / exports (three tabs: a
register of files, CSV import with a check before anything is written, and the CSV exports). Integrations
are simulated: a sync, a retry or a webhook delivery is recorded as the real system would record it (an
attempt counter, an idempotency key, a signature check, a duplicate delivery caught by its body fingerprint),
and a connection holds only a reference to its secret, never the secret. A public Limits page (linked in the
header, also reachable signed out) lists what is simulated and what a browser cannot show, each with its
source. Every refusal now carries a reference that can be quoted to support, and times are shown in the
organization's time zone. A Data steward role is seeded for the CSV imports. **S9** ran the parity
gate and prepared the removal proposal; it changed no screen.
S1.2, S2, S3, S4, S5.1, S5.2, S6, S7 and S8 were smoke-checked in Node with jsdom. A pass in real Chrome
on 2026-11-04 swept all 47 sidebar routes in light and dark mode for errors, overflow, empty columns and
contrast, tried the support-access flow and an 816 px tablet-width frame, and looked at about 15 screens;
it found and fixed five empty table columns, small touch targets and a stranded page after support
access. Most S3 to S7 screens beyond those sweeps, the Attendance page, the workforce dialogs and the S8
dialogs are still unviewed (see `TEST_EVIDENCE.md`). The browser runner has never been run.

If a browser already holds demo data from before S8, the stored roles lack the S5.2, S6, S7 and S8 permissions
(for example `integration.view`, `file.view` and `import.manage`) and the Data steward role, so the new pages stay
hidden, and "Load the demo world" refuses a store that already has users. Delete the
`opex-prototype:v1` entry from the page's Local Storage (browser developer tools, Application tab) or
clear the site's data, reload, and choose "Load the demo world" again. There is no reset button in the
prototype yet.

| Area             | File                                                                                          | What it provides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effective dating | `domain/effective-dating.js`                                                                  | Overlap, adjacency, end-dating, replacement and version lookup (architecture 7.2-7.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Calculations     | `domain/calculations.js`                                                                      | One library for SRS 10.1-10.4: production day, scores, rolling window, target inheritance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Authorization    | `domain/authorization.js`                                                                     | `effective_access` and `canAccess` (architecture 5.3), fail-closed (decision D14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Store            | `store/store.js`                                                                              | Tenant-scoped, transactional rows with an audit event atomic with every mutation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Tenancy rules    | `domain/tenancy.js`, `time.js`                                                                | Tenant lifecycle, provisioning input, business date in the tenant's timezone (D15, D20)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Organization     | `domain/organization.js`                                                                      | Factory, section, shift, line, calendar and designation rules (D21, D22)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Configuration    | `domain/configuration.js`                                                                     | Module entitlements, effective-dated KPI targets, company profile (D17, D23, D24)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Administration   | `domain/administration.js`                                                                    | Administrator count, factory scope, no-escalation check (D16, D25)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Gate             | `services/context.js`                                                                         | The only issuer of contexts; re-resolves session, user, tenant and membership on every call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Workforce rules  | `domain/workforce.js`                                                                         | Employee status, assignment overlap and history, attendance minutes, correction diffs (D27, D31 to D33)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Production rules | `domain/production.js`                                                                        | Styles, plan revisions, hourly output, events, the day status machine, Daily Close and the day's figures (D34 to D42)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Scoring rules    | `domain/scoring.js`                                                                           | Attribution of days to supervisors, aggregation, score readings and targets, exceptions, score configuration rules, snapshot keys (D43 to D52)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Communication    | `domain/notifications.js`, `comments.js`, `reports.js`                                        | Notification types, templates and masking; comment and tag rules; the export catalogue, CSV with formula escaping and recurrence (D61 to D70)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Order rules      | `domain/orders.js`                                                                            | Buyers, orders and lines, time-and-action templates and milestones, approvals and their decisions, capacity bookings, loading and the dashboard figures (D72 to D82)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Supply rules     | `domain/procurement.js`, `inventory.js`, `finance.js`                                         | Materials, suppliers, RFQs, quotations and award, purchase orders, receipts and inspection, stock as the sum of movements, requisitions, invoices, payments and balances (D83 to D96)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Platform rules   | `domain/audit.js`, `integrations.js`, `files.js`, `imports.js`, `limits.js`, `fingerprint.js` | Audit filters, paging and redaction; connection, run and webhook rules; file metadata; CSV staging, validation and commit; the Limits page content; the body fingerprint and simulated signature (D97 to D109)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Services         | `services/*.js`                                                                               | Identity, tenancy, organization, settings, administration, support access, employees, assignments, attendance, production, scorecards, dashboards, orders, procurement, inventory, finance, notifications, comments, reports, audit, integrations, files, imports, prototype tools                                                                                                                                                                                                                                                                                                                                                       |
| Demo world       | `seed/demo.js`                                                                                | Platform team, two organizations and one sign-in per persona, built only through the services                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Decisions        | `DECISIONS.md`                                                                                | Carried legacy decisions (C, P, O) and the rebuild defaults (D1 to D110), all with statuses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Parity manifest  | `tests/parity-manifest.json`                                                                  | Every legacy route, README capability and baseline row with its slice, level, the screens that deliver it and its evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Page             | `index.html`, `ui/main.js`                                                                    | Loads the stylesheet and starts the app over the browser's LocalStorage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Session          | `ui/session.js`                                                                               | Holds the contexts the services issue; turns "session over" refusals into sign-out or chooser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Router and shell | `ui/router.js`, `ui/shell.js`                                                                 | Hash routes, navigation limited to usable routes, header, banners, theme toggle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Shared UI        | `ui/kit.js`, `table.js`, `dialog.js`, `dom.js`, `theme.js`, `styles.css`                      | Tables, dialogs, toasts, empty states, light/dark/automatic theme                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Views            | `ui/views/*.js`                                                                               | Sign-in, chooser, Prototype Tools, home, company, factories, organization, calendars, users, roles, employees, supervisor assignments, attendance, production dashboard, production day, daily records, production plans, style master, my scorecard, management scorecard, supervisor scorecard, score exceptions, score configuration, tenant overview, production and line performance, workforce dashboard, notifications, operational comments, exports, scheduled reports, notification settings, audit log, integrations, a connection page, files / imports / exports, limits, tenants, tenant features, platform administration |

### Open the prototype

`index.html` loads ES modules, which browsers refuse to load from `file://`, so serve the folder with
any static server, for example `python3 -m http.server 8080 --directory opex-prototype`, and open
`http://127.0.0.1:8080/`. On the sign-in page, "Load the demo world" fills the browser's LocalStorage
and then one click signs in as any persona. Data lives only in that browser; the Prototype Tools page
(available signed out) resets it. A real-Chrome pass over the S2 to S8 screens was made on 2026-11-04
(light and dark, and a tablet-width frame); `TEST_EVIDENCE.md` lists what it covered and what is still
unviewed.

`python3 -m http.server` sends no cache headers, so Chrome may keep serving an edited module or
stylesheet from its cache. After editing under a browser, hard-reload (or open DevTools with "Disable
cache" ticked). Reloading also signs you out, because the session is held in memory only; the data in
LocalStorage stays.

### Demo accounts

`seedDemo(app)` (from `seed/demo.js`) fills an empty store once and refuses a second run with
`already_seeded`. Sign-in is an email; a person who needs a second factor gets the simulated code from
`app.prototypeTools.mfaCode(email)` (decision D18). The accounts are listed in `DEMO_ACCOUNTS`:
platform admin and support engineer; and for the organizations `felix` and `orbit` a tenant admin,
a factory manager, a viewer, and (Felix only) an assignment-scoped supervisor, an industrial engineer and
a finance viewer (`finance@felix.example`, who holds the Finance officer role and sees only the invoice and
payment pages). Four supply roles are seeded for every organization: Supply chain officer, Requisition
approver, Finance officer and Supply viewer (the demo manager holds Supply chain officer, the engineer Requisition
approver and the viewer Supply viewer).
The Felix supervisor is linked to an employee record, so their scope is the section-shifts of that
employee's current assignments (decision D29). Workforce pages need the `employee.manage`,
`supervisor_assignment.manage` and `attendance.manage` permissions (D28). The tenant administrator
holds all three, the demo manager also holds the custom role "Workforce coordinator" (all three), and
the demo supervisor the custom role "Team attendance" (attendance only, for their own section-shifts).

## Rules for the code

- `domain/` and `store/` are browser-safe: no `node:` imports, no `require`. Storage, clock and id
  generation are injected so tests are deterministic.
- Business rules live in `domain/`, never in the UI. Calculations keep full precision; rounding is a
  presentation step (architecture 8.3). "No reading" is `null`, never zero.
- The tenant comes from the session, never from a payload. A role's code or name is never an input to
  authorization, only its stored permissions and scope.
- Every feature is shown at one of three levels: **D** works in the UI, **S** is simulated and
  labelled, **N** cannot be demonstrated and is listed with its source on the Limits page. Only the S0
  foundation and AC-1.1 to AC-1.5 have executed tests; every other slice is smoke-checked, and
  `TEST_EVIDENCE.md` says which.

## Run the tests

The S0 and S1.1 (AC-1.1 to AC-1.5) suites below are kept. From AC-1.6 onward the prototype has no
automated tests by decision of the user (it is a demonstration wireframe; the production system carries
the real tests), and its code is only smoke-checked; see `TEST_EVIDENCE.md`.

All commands run from the repository root.

| Purpose        | Command                                                                        | Needs                                        |
| -------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| Contract tests | `npm run test:opex-prototype` (or `node opex-prototype/tests/<file>.test.mjs`) | Node 22, no install                          |
| Browser tests  | `npm run test:opex-prototype:browser`                                          | Chrome or Chromium, `python3`, local sockets |
| Formatting     | `node_modules/.bin/prettier --check opex-prototype`                            | `npm ci`                                     |
| Syntax         | `rg --files opex-prototype -g '*.js' -g '*.mjs' \| xargs -n 1 node --check`    | `rg`                                         |
| Whitespace     | `git diff --check`                                                             |                                              |

The browser runner starts a static server and a headless Chrome with a disposable profile, both bound
to `127.0.0.1`, and removes the profile afterwards. Set `OPEX_CHROME_BINARY` or `OPEX_PYTHON_BINARY`
if the defaults are not on `PATH`.

`tests/harness.test.mjs` proves the harness itself first: a missing module and a missing import inside
an existing module must be told apart, so that a skipped test or an environment fault is never
mistaken for the expected failure.

## Evidence

`TEST_EVIDENCE.md` records, per slice, what was executed with commands, working directory and results:
the failure observed before implementation and the passing runs for S0 and AC-1.1 to AC-1.5, and the
smoke checks for every later slice. Anything not executed is listed there as a validation gap. Smoke
checks are never reported as passing tests.

## Parity gate

`tests/parity-manifest.json` maps every legacy route (42), README capability (23) and requirement
baseline row (63) to the screens that deliver it and to the section of `TEST_EVIDENCE.md` that records
the checks. At S9, 127 of the 128 entries are covered and one is dropped: the legacy "Production event
types" page, because decision D38 fixes the event codes (D110); the user approved that drop on
2026-11-05. The contract suites (208 tests) and the browser suite (6 tests, S0 modules only) were GREEN
on the delivered revision, and the user approved the removal of the legacy prototype. The inventory of
references to `felix-erp-prototype/` and the change set are in
[`docs/engineering/plans/prototype-removal-proposal.md`](../docs/engineering/plans/prototype-removal-proposal.md).
The legacy files are in git history at commit `0b4283e` (`git show 0b4283e:felix-erp-prototype/README.md`).
Two tests keep working without the directory because they read frozen copies of its navigation catalogue
and decision log in `tests/fixtures/`.
