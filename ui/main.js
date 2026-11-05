// Entry point: opens the saved data, then draws the page.
import { createApp } from "./app.js";
import { session } from "./session.js";
import { startApp } from "./shell.js";
import { applyTheme } from "./theme.js";

applyTheme();
session.init(createApp());
startApp(document.getElementById("root"));
