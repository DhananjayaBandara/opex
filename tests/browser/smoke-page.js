// Exposes the S0 domain and store API on window.opex so the browser smoke test can drive the real
// modules against the browser's real LocalStorage. No application UI lives here.
import { createStore } from "../../store/store.js";
import { resolveAccess, canAccess } from "../../domain/authorization.js";
import {
  calculateProductionDay,
  calculateSupervisorScore,
  resolveTargets,
} from "../../domain/calculations.js";
import { replaceAssignment } from "../../domain/effective-dating.js";

window.opex = {
  ready: true,
  storage: window.localStorage,
  createStore,
  resolveAccess,
  canAccess,
  calculateProductionDay,
  calculateSupervisorScore,
  resolveTargets,
  replaceAssignment,
};
