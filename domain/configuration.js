// Tenant configuration rules (SRS 4.4, 10.4; FR-TEN-007, FR-SCR-002; decisions D17, D23, D24):
// which modules a tenant is entitled to on a date, the KPI targets and their system defaults, and the
// company profile and branding. Pure validation; orchestration (authorization, versions, audit)
// lives in services/settings.js. Browser-safe: no Node imports.
import { activeOn } from "./effective-dating.js";
import { FEATURES } from "./permissions.js";
import { validateName } from "./tenancy.js";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// ---- Module entitlements -------------------------------------------------------------------

// A module is entitled on a date while exactly the enabled versions cover it. Two versions covering
// the same date cannot be told apart, so if any of them is disabled the module is not entitled (fail
// closed). The answer follows the catalogue order of the modules; unknown modules are ignored.
export function entitledOn(versions, isoDate) {
  const byFeature = new Map();
  for (const version of versions) {
    if (!FEATURES.includes(version.feature) || !activeOn(version, isoDate)) continue;
    byFeature.set(
      version.feature,
      (byFeature.get(version.feature) ?? true) && version.enabled === true
    );
  }
  return FEATURES.filter((feature) => byFeature.get(feature) === true);
}

// ---- KPI targets ---------------------------------------------------------------------------

// The targets that the supervisor score reads (SRS 10.3), each a percentage above 0 and at most 100.
// For the defect rate the target is the maximum acceptable rate.
export const TARGET_KEYS = Object.freeze(["efficiency", "firstHour", "defectRate", "qco"]);

// Version 1 of the chain, valid on every business date (SRS 10.4: System default -> Tenant default ->
// Factory override). The numbers are the legacy prototype's defaults (decision D23, PROPOSED).
export const SYSTEM_TARGETS = Object.freeze([
  Object.freeze({
    version: 1,
    effectiveFrom: "2000-01-01",
    effectiveTo: null,
    values: Object.freeze({ efficiency: 75, firstHour: 85, defectRate: 3, qco: 90 }),
  }),
]);

// A version states the targets it changes; every key it leaves out falls through to the level above.
export function validateTargetValues(values) {
  const entries = isObject(values) ? Object.entries(values) : [];
  if (entries.length === 0) {
    throw fail("invalid_target", `state at least one target of: ${TARGET_KEYS.join(", ")}`);
  }
  for (const [key, value] of entries) {
    if (!TARGET_KEYS.includes(key)) throw fail("invalid_target", `${key} is not a known target`);
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
      throw fail("invalid_target", `${key} is a percentage above 0 and at most 100`);
    }
  }
  return Object.fromEntries(entries);
}

// ---- Company profile and branding ----------------------------------------------------------

const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
// The prototype keeps the logo inside the tenant data, so it is small, and only raster formats are
// accepted (an SVG can carry script).
const LOGO = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
export const MAX_LOGO_LENGTH = 65_536;
export const DEFAULT_LOCALE = "en";

const optionalText = (value, label) => {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 120) {
    throw fail("invalid_field", `${label} must be text of at most 120 characters`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

// The editable fields of the profile. A field that is absent is not touched; unknown fields are
// ignored. Optional branding is cleared by stating null. The time zone is not here: it is fixed at
// provisioning (decision D24).
export function validateProfilePatch(patch) {
  const input = isObject(patch) ? patch : {};
  const out = {};
  const given = (field) => input[field] !== undefined;

  if (given("name")) out.name = validateName(input.name, "the company name");
  if (given("legalName")) out.legalName = optionalText(input.legalName, "the legal name");
  if (given("locale")) {
    if (typeof input.locale !== "string" || !LOCALE.test(input.locale)) {
      throw fail("invalid_locale", "a locale is a language such as en, or en-LK");
    }
    out.locale = input.locale;
  }
  if (given("currency")) {
    const currency =
      typeof input.currency === "string" ? input.currency.trim().toUpperCase() : null;
    if (input.currency === null) out.currency = null;
    else if (currency !== null && CURRENCY.test(currency)) out.currency = currency;
    else throw fail("invalid_currency", "a currency is a three-letter code such as LKR");
  }
  if (given("primaryColor")) {
    if (input.primaryColor === null) out.primaryColor = null;
    else if (typeof input.primaryColor === "string" && COLOR.test(input.primaryColor)) {
      out.primaryColor = input.primaryColor.toLowerCase();
    } else throw fail("invalid_color", "a colour is written #rrggbb");
  }
  if (given("logo")) {
    if (input.logo === null) out.logo = null;
    else if (
      typeof input.logo === "string" &&
      input.logo.length <= MAX_LOGO_LENGTH &&
      LOGO.test(input.logo)
    ) {
      out.logo = input.logo;
    } else {
      throw fail("invalid_logo", "the logo is a PNG or JPEG image of at most 64 KB");
    }
  }
  return out;
}
