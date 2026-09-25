import { IS_PLATFORM } from '../constants/config';

import { api, authenticatedFetch, getStoredAuthToken, hasNativeViewerTransport } from './api';

const fileNameFromPath = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || 'download';

export const projectFileDownloadUrl = (projectId: string, filePath: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/files/content?path=${encodeURIComponent(filePath)}&download=1`;

const clickAnchor = (href: string, fileName: string) => {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};

/**
 * Download a project file's real bytes.
 *
 * The browser streams the response straight into its own download manager, so
 * a large file shows up as a download immediately instead of being buffered
 * into a Blob first (which gave no feedback for tens of seconds and made users
 * click again). A HEAD preflight through the authenticated client turns
 * 403/404 into an error the caller can show, rather than a failed download
 * entry. Browser auth rides the manager session cookie; single-user mode adds
 * the stored token as `?token=`, which the auth middleware already accepts.
 */
export async function downloadProjectFile(
  projectId: string,
  filePath: string,
  fileName: string = fileNameFromPath(filePath),
): Promise<void> {
  if (hasNativeViewerTransport()) {
    // The native viewer has no browser session; keep the in-memory path there.
    const response = await api.readFileBlob(projectId, filePath);
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const url = URL.createObjectURL(await response.blob());
    clickAnchor(url, fileName);
    // Revoking synchronously can cancel the download in Firefox/Safari.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }

  const url = projectFileDownloadUrl(projectId, filePath);
  const preflight = await authenticatedFetch(url, { method: 'HEAD' });
  if (!preflight.ok) {
    throw new Error(preflight.status === 404 ? 'File not found' : `Download failed (${preflight.status})`);
  }

  const token = IS_PLATFORM ? null : getStoredAuthToken();
  clickAnchor(token ? `${url}&token=${encodeURIComponent(token)}` : url, fileName);
}
