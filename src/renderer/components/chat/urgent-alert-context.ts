import { createContext } from "react";

// Lets an urgent alert's card open Settings → Alerts (its "Set up alerts"
// button) without every list between the app and the card passing it on.
export interface UrgentAlertActionsValue {
  openAlertSettings: () => void;
}

export const UrgentAlertActionsContext = createContext<UrgentAlertActionsValue | undefined>(undefined);
