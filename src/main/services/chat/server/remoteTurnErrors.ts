/** A member elsewhere could not be asked: its machine or its project could
 *  not be made ready on this device. */
export class RemoteTurnNotStartedError extends Error {}

/** The server refused to give this device a turn asked of its member (no such
 *  message, a machine not on its roster): offered again, it is refused again. */
export class TurnClaimRefusedError extends Error {}
