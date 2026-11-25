/** A one-time code a phone pairs with the User's server by. */
export interface CreatePhoneInviteRequest {
  /** The phone app's address, when it is not the usual one. */
  staticOriginUrl?: string;
}

export interface CreatePhoneInviteResult {
  inviteId: string;
  expiresAt: string;
  /** The phone app's address with the server, the token and its id in the
   *  fragment: what the QR code shows. */
  pwaUrl: string;
  qrPayload: string;
}

export interface RevokePhoneInviteResult {
  revoked: boolean;
  inviteId: string;
  deviceId?: string;
}
