export interface ImplementationPlanSynthesis {
  fullPlan: string;
  debateSummary: string;
  combined: string;
  source: "arbiter" | "fallback";
}
