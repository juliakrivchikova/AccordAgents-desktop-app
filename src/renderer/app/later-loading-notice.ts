import { toast } from "sonner";

/** How long work may take before it says it is on its way: below this it
 *  feels instant, and a notice that flashes by is noise. */
export const LOADING_NOTICE_DELAY_MS = 150;

/** A loading toast shown only if the work outlasts `delayMs`; `end` takes it
 *  away (or keeps it from showing). */
export function laterLoadingNotice(text: string, delayMs = LOADING_NOTICE_DELAY_MS): { end: () => void } {
  let id: string | number | undefined;
  const timer = setTimeout(() => { id = toast.loading(text); }, delayMs);
  return {
    end: () => {
      clearTimeout(timer);
      if (id !== undefined) toast.dismiss(id);
      id = undefined;
    }
  };
}
