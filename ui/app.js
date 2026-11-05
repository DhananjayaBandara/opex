// Creates the services over the browser's LocalStorage (decision: static, build-free prototype).
import { createServices } from "../services/index.js";

export const createApp = () => createServices({ storage: window.localStorage });
