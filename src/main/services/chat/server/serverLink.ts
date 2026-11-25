import type { ChatServerLink, ChatServerQueue } from "../../chatServerOps";
import type { ChatModules } from "../modules";

/** The link to the User's server, and where saves queue while none stands. */
export class ServerLink {
  /** The User's server, owner of every chat (agreements Д1–Д13): saves go
   *  there as operations, and members' turns wait for it. */
  current?: ChatServerLink;
  /** A link to the server was installed in this run: without one now, it is
   *  between two (never "no server", which answers could not wait on). */
  serverLinkInstalled = false;
  /** While no link stands after one did: where saves still queue what they
   *  change for the server, sent once a link starts again. */
  private parkedServerQueue?: ChatServerQueue;

  constructor(private readonly chat: Pick<ChatModules, "serverCardMirrors" | "serverCards" | "store">) {}

  /** Installs (or removes) the link to the User's server (Д1). Without a
   *  link, `parked` is where saves keep queuing what they change for it. */
  setServerLink(link: ChatServerLink | undefined, parked?: ChatServerQueue): void {
    this.current = link;
    this.parkedServerQueue = link ? undefined : parked;
    if (link) this.serverLinkInstalled = true;
    // Parked, what was last queued stays the base of the next diff: reading
    // each chat whole again would hold up a reply's save while the app quits.
    if (!this.parkedServerQueue) this.chat.store.chatChangeBaselines.clear();
    // The cards of another server (or none) are read again from it.
    this.chat.serverCards.book.reset();
    this.chat.serverCardMirrors.mirroredCardSeqs.clear();
  }

  /** Where this device's chat changes go for the server: the live link, or
   *  while it is stopped the queue it sends from once it starts again. */
  serverQueue(): ChatServerQueue | undefined {
    return this.current ?? this.parkedServerQueue;
  }
}
