// Force-save a file to disk instead of navigating to it. Attachment URLs are
// cross-origin (S3/CloudFront), and browsers IGNORE the HTML `download`
// attribute on cross-origin <a> links — so a plain `<a href download>` just
// navigates (new tab in the browser, or the Electron window with no back).
// Fetching the bytes as a blob and clicking a same-origin object-URL anchor
// makes `download` honored again. Falls back to opening the URL if the fetch
// fails (CORS, offline), where the user can still right-click → Save As.
export async function downloadFile(url: string, name: string): Promise<void> {
  let objectUrl: string | null = null;
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    window.open(url, "_blank", "noopener"); // fallback: user can right-click → Save As
  } finally {
    // Revoke AFTER a tick, not synchronously: Firefox/Safari process the download
    // asynchronously and revoking right after click() can cancel it. The `finally`
    // also guarantees we don't leak the object URL if the click path threw.
    if (objectUrl) {
      const u = objectUrl;
      setTimeout(() => URL.revokeObjectURL(u), 1000);
    }
  }
}
