// Exports (C128; D68): a report as a CSV file. A request is a job with a result; the same key never
// makes a second job, and a person gets a few requests an hour. The file is kept by the service and
// checked again at every download.
import { h } from "../dom.js";
import { notificationsChanged, saveText } from "../download.js";
import {
  attempt,
  badge,
  button,
  card,
  emptyState,
  formatInstant,
  mount,
  pageHeader,
} from "../kit.js";
import { dataTable } from "../table.js";
import {
  dateControl,
  option,
  plural,
  queryValue,
  reportService,
  selectControl,
} from "./communication-common.js";
import { control } from "./production-common.js";

const FILTER_LABELS = { kind: "Kind", status: "Status", method: "Method" };

const TONES = { completed: "good", failed: "bad", queued: "info", running: "info" };

const newKey = () => `export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const periodText = (period) =>
  period.from === period.to ? period.from : `${period.from} to ${period.to}`;

const sizeText = (bytes) =>
  bytes === null || bytes === undefined
    ? "—"
    : bytes < 1024
      ? `${bytes} B`
      : `${(bytes / 1024).toFixed(1)} KB`;

function download(job) {
  const file = attempt(() => reportService((s, ctx) => s.download(ctx, job.id)));
  if (file !== undefined) saveText(file.fileName, file.content, file.contentType);
}

// The request form and the list of exports. The Exports page shows it under its own heading; the Files
// page shows it as one of its tabs, so the heading is optional.
function exportsPanel(withHeading) {
  const root = h("div");
  const highlighted = queryValue("job");
  const state = { report: "", factoryId: "", choices: {}, from: "", to: "", key: newKey() };
  mount(root, (redraw) => {
    const catalogue = reportService((s, ctx) => s.catalogue(ctx));
    const jobs = reportService((s, ctx) => s.jobs(ctx));
    const reports = catalogue.reports;
    if (reports.length === 0) {
      return h(
        "div",
        {},
        withHeading ? pageHeader("Exports") : null,
        emptyState({
          title: "No report available to you",
          body: "An export needs the export permission and access to the figures in the report.",
        })
      );
    }
    const chosen = reports.find((report) => report.key === state.report) ?? reports[0];
    state.report = chosen.key;
    const factoryName = (id) =>
      catalogue.factories.find((factory) => factory.id === id)?.name ?? id;
    const choicesOf = (key) => catalogue.filterChoices?.[key] ?? null;
    const filtersOf = () => {
      const filters = {};
      for (const key of chosen.filters) {
        if (key === "factoryId" && state.factoryId !== "") filters.factoryId = state.factoryId;
        else if (choicesOf(key) !== null && (state.choices[key] ?? "") !== "") {
          filters[key] = state.choices[key];
        }
      }
      return filters;
    };
    // The filters of a job as words: a factory by name, a fixed choice by its label.
    const filterText = (filters) => {
      const parts = [];
      for (const [key, value] of Object.entries(filters)) {
        if (key === "factoryId") parts.push(factoryName(value));
        else parts.push(choicesOf(key)?.find((choice) => choice.value === value)?.label ?? value);
      }
      return parts.length === 0 ? "No filter" : parts.join(" · ");
    };
    const request = () => {
      const job = attempt(
        () =>
          reportService((s, ctx) =>
            s.request(ctx, {
              report: chosen.key,
              from: state.from,
              to: state.to,
              filters: filtersOf(),
              idempotencyKey: state.key,
            })
          ),
        "Export requested"
      );
      if (job !== undefined) {
        state.key = newKey();
        notificationsChanged();
        redraw();
      }
    };
    const limits = `At most ${catalogue.perHour} requests an hour; a report of more than ${catalogue.maxRows.toLocaleString("en-US")} rows is refused, so narrow the period or the filters.`;
    return h(
      "div",
      {},
      withHeading
        ? pageHeader("Exports", `A CSV file of a report for a period of up to a year. ${limits}`)
        : null,
      card(
        "Request an export",
        h(
          "div",
          { class: "table-tools" },
          control(
            "ex-report",
            "Report",
            h(
              "select",
              {
                id: "ex-report",
                onchange: (event) => {
                  state.report = event.target.value;
                  redraw();
                },
              },
              reports.map((report) => option(report.key, report.label, report.key === chosen.key))
            )
          ),
          chosen.filters.includes("factoryId")
            ? selectControl(
                "ex-factory",
                "Factory",
                catalogue.factories,
                state.factoryId,
                (value) => (state.factoryId = value),
                "All my factories"
              )
            : null,
          chosen.filters
            .filter((key) => choicesOf(key) !== null)
            .map((key) =>
              selectControl(
                `ex-${key}`,
                FILTER_LABELS[key] ?? key,
                choicesOf(key).map((choice) => ({ id: choice.value, name: choice.label })),
                state.choices[key] ?? "",
                (value) => (state.choices[key] = value),
                "Any"
              )
            ),
          dateControl(
            "ex-from",
            "From",
            state.from,
            catalogue.today,
            (value) => (state.from = value)
          ),
          dateControl("ex-to", "To", state.to, catalogue.today, (value) => (state.to = value)),
          button("Request export", request, { kind: "primary" })
        ),
        h("p", { class: "muted" }, chosen.description),
        chosen.asAt
          ? h(
              "p",
              { class: "muted" },
              "This report is as at the day it is made; the period is only recorded on the request."
            )
          : null,
        withHeading ? null : h("p", { class: "muted" }, limits)
      ),
      card(
        "Your exports",
        jobs.length === 0
          ? emptyState({
              title: "No exports yet",
              body: "Request one above. It appears here with its result, ready to download.",
            })
          : dataTable({
              caption: "Exports",
              pageSize: 10,
              rows: jobs,
              searchText: (job) =>
                `${job.reportLabel} ${job.requester.name} ${job.scheduleName ?? ""}`,
              rowClass: (job) => (job.id === highlighted ? "row-highlight" : ""),
              columns: [
                {
                  key: "report",
                  label: "Report",
                  sort: (job) => job.reportLabel,
                  render: (job) =>
                    h(
                      "div",
                      {},
                      h("strong", {}, job.reportLabel),
                      h("div", { class: "muted" }, filterText(job.filters))
                    ),
                },
                {
                  key: "period",
                  label: "Period",
                  sort: (job) => job.period.from,
                  render: (job) => periodText(job.period),
                },
                {
                  key: "by",
                  label: "Requested by",
                  sort: (job) => job.requester.name ?? "",
                  render: (job) =>
                    job.scheduleName
                      ? h("span", {}, `Schedule: ${job.scheduleName}`)
                      : job.mine
                        ? "You"
                        : (job.requester.name ?? "Someone"),
                },
                {
                  key: "createdAt",
                  label: "Requested",
                  sort: (job) => job.createdAt,
                  render: (job) => formatInstant(job.createdAt),
                },
                {
                  key: "status",
                  label: "Result",
                  sort: (job) => job.status,
                  render: (job) =>
                    h(
                      "div",
                      {},
                      badge(job.status, TONES[job.status] ?? "neutral"),
                      job.status === "completed"
                        ? h(
                            "div",
                            { class: "muted" },
                            `${plural(job.rowCount, "row")} · ${sizeText(job.bytes)}`
                          )
                        : null,
                      job.failureText ? h("div", { class: "muted" }, job.failureText) : null
                    ),
                },
                {
                  key: "actions",
                  label: "File",
                  render: (job) =>
                    job.canDownload
                      ? button("Download", () => download(job), {
                          kind: "secondary",
                          title: job.fileName,
                        })
                      : h("span", { class: "muted" }, "—"),
                },
              ],
            })
      )
    );
  });
  return root;
}

export const render = () => exportsPanel(true);
export const panel = () => exportsPanel(false);
