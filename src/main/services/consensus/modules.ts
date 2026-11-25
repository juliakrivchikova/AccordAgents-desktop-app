import type { ConsensusDependencies } from "./dependencies";
import { ConversationSaves } from "./runs/conversationSaves";
import { Debate } from "./points/debate";
import { ImplementationPlans } from "./plans/implementationPlans";
import { ParticipantRuns } from "./runs/participantRuns";
import { PlanDecisions } from "./plans/planDecisions";
import { PlanRevisions } from "./plans/planRevisions";
import { Reviews } from "./reviews/reviews";

/** The review service's parts. Each names the ones it uses in its constructor. */
export interface ConsensusModules {
  readonly reviews: Reviews;
  readonly planDecisions: PlanDecisions;
  readonly implementationPlans: ImplementationPlans;
  readonly planRevisions: PlanRevisions;
  readonly debate: Debate;
  readonly participantRuns: ParticipantRuns;
  readonly conversationSaves: ConversationSaves;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createConsensusModules(deps: ConsensusDependencies): ConsensusModules {
  const modules = {} as { -readonly [Key in keyof ConsensusModules]: ConsensusModules[Key] };
  modules.reviews = new Reviews(modules, deps);
  modules.planDecisions = new PlanDecisions(modules, deps);
  modules.implementationPlans = new ImplementationPlans(modules, deps);
  modules.planRevisions = new PlanRevisions(modules, deps);
  modules.debate = new Debate(modules);
  modules.participantRuns = new ParticipantRuns(deps);
  modules.conversationSaves = new ConversationSaves(deps);
  return modules;
}
