import { rm } from "node:fs/promises";

export async function removeBrowserProfile(profile) {
  // Chrome descendants can finish profile writes after the parent exits.
  // Retry transient removal errors; persistent failures still reject the run.
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
