// Detects whether the *client* (this browser) is running on a macOS desktop.
// Used to gate the "Open in desktop Terminal" button: it only makes sense when
// you are physically at the host Mac, since the server launches Terminal.app on
// its own machine. iPadOS Safari in desktop mode also reports a Mac platform,
// so we exclude touch devices via maxTouchPoints to keep this to real desktops.
export function isMacOsDesktop(): boolean {
  if (typeof navigator === 'undefined') return false;

  const uaDataPlatform = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;

  const platform = uaDataPlatform || navigator.platform || '';
  const isMac = /mac/i.test(platform) || /Mac OS X/i.test(navigator.userAgent);
  const isTouch = (navigator.maxTouchPoints ?? 0) > 1;

  return isMac && !isTouch;
}
