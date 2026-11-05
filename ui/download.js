// Hands a text file to the browser as a download (the prototype has no file server, so the export
// content comes back from the service and is saved from here), and tells the page that the count of
// unread notifications may have changed. Browser-only.

export function saveText(fileName, content, contentType = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type: contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const NOTIFICATIONS_CHANGED = "opex-notifications-changed";

// Raised after a notification was read or an event that creates one happened, so the sidebar badge
// can be refreshed without redrawing the page (and losing what is typed in it).
export const notificationsChanged = () =>
  document.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED));
