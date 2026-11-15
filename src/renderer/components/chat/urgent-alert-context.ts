import { createContext } from "react";

// Lets an urgent alert's card open Settings → Alerts (its "Set up alerts"
// button), and Settings → Alerts open the server's settings ("Set up your
// server"), without every component between passing it on.
export interface UrgentAlertActionsValue {
  openAlertSettings: () => void;
  openServerSettings: () => void;
}

export const UrgentAlertActionsContext = createContext<UrgentAlertActionsValue | undefined>(undefined);
