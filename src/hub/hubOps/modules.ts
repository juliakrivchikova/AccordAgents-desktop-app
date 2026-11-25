import type { HubOpsDependencies } from "./dependencies";
import { ArtifactViews } from "./artifactViews";
import { Cards } from "./cards";
import { ChatCache } from "./chatCache";
import { ChatPages } from "./chatPages";
import { Feed } from "./feed";
import { Imports } from "./imports";
import { MemberRules } from "./memberRules";
import { Operations } from "./operations";
import { Turns } from "./turns";

/** The operations' parts. Each names the ones it uses in its constructor. */
export interface HubOpsModules {
  readonly operations: Operations;
  readonly turns: Turns;
  readonly cards: Cards;
  readonly imports: Imports;
  readonly memberRules: MemberRules;
  readonly feed: Feed;
  readonly artifactViews: ArtifactViews;
  readonly chatPages: ChatPages;
  readonly chatCache: ChatCache;
}

/** Builds every part around one registry: parts call each other only once all of them exist. */
export function createHubOpsModules(deps: HubOpsDependencies): HubOpsModules {
  const modules = {} as { -readonly [Key in keyof HubOpsModules]: HubOpsModules[Key] };
  modules.operations = new Operations(modules, deps);
  modules.turns = new Turns(modules, deps);
  modules.cards = new Cards(modules, deps);
  modules.imports = new Imports(modules, deps);
  modules.memberRules = new MemberRules(deps);
  modules.feed = new Feed(deps);
  modules.artifactViews = new ArtifactViews(modules, deps);
  modules.chatPages = new ChatPages(modules, deps);
  modules.chatCache = new ChatCache(deps);
  return modules;
}
