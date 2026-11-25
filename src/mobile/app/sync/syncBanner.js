// "Nothing new" and "still looking" must not look the same. The banner waits
// a moment so an ordinary fast poll does not blink it, and stays up long
// enough to be read once it is there.
const SYNC_BANNER_DELAY_MS = 350;

const SYNC_BANNER_MIN_MS = 700;
let syncDepth = 0;
let syncBannerTimer;
let syncBannerHideTimer;
let syncBannerShownAt = 0;

function setSyncBanner(visible) {
  const node = document.getElementById("timeline-syncing");
  if (!node) return;
  if (visible && node.hidden) {
    syncBannerShownAt = Date.now();
  }
  node.hidden = !visible;
}

/** Runs a sync that could bring messages in, with the banner saying so. */
export async function whileLookingForMessages(run) {
  syncDepth += 1;
  if (syncDepth === 1 && !syncBannerTimer) {
    clearTimeout(syncBannerHideTimer);
    syncBannerHideTimer = undefined;
    syncBannerTimer = setTimeout(function () {
      syncBannerTimer = undefined;
      if (syncDepth > 0) setSyncBanner(true);
    }, SYNC_BANNER_DELAY_MS);
  }
  try {
    return await run();
  } finally {
    syncDepth = Math.max(0, syncDepth - 1);
    if (syncDepth === 0) {
      clearTimeout(syncBannerTimer);
      syncBannerTimer = undefined;
      const node = document.getElementById("timeline-syncing");
      if (node && !node.hidden) {
        const left = Math.max(0, SYNC_BANNER_MIN_MS - (Date.now() - syncBannerShownAt));
        clearTimeout(syncBannerHideTimer);
        syncBannerHideTimer = setTimeout(function () {
          syncBannerHideTimer = undefined;
          if (syncDepth === 0) setSyncBanner(false);
        }, left);
      }
    }
  }
}
