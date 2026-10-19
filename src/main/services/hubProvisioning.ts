// The one Terminal command that creates the User's hub server in her AWS
// account (Lightsail, the cheapest fixed-price server), and nothing else: no
// AWS key is minted and none reaches the app. It runs with her own AWS
// administrator sign-in, is safe to run again (it finds the server it made
// and lets this computer in), and prints one line for the app. Pure: no side
// effects here, so it is fully unit-testable.
import { HUB_SETUP_BLOB_PREFIX, isHubNonce, isHubRegion } from "../../shared/hubSetup";

export const HUB_INSTANCE_NAME = "accordagents-hub";
export const HUB_STATIC_IP_NAME = "accordagents-hub-ip";
/** 512 MB, 2 vCPU burst, 20 GB, 1 TB transfer, one public IPv4: $5/month. */
export const HUB_BUNDLE_ID = "nano_3_0";
export const HUB_BLUEPRINT_ID = "ubuntu_24_04";
export const HUB_SSH_USER = "ubuntu";
export const HUB_TAG = "accordagents-hub";

const SSH_PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/=]{40,120}(?: [A-Za-z0-9@._-]{1,64})?$/;

/**
 * The first boot only lets this computer in. Everything else (Node, sqlite3,
 * certbot, the hub) is installed by the app over SSH, where each step reports
 * progress and a failed one is retried.
 */
export function hubLaunchScript(publicKey: string): string {
  const key = assertPublicKey(publicKey);
  return [
    "#!/bin/bash",
    "set -e",
    `install -d -m 700 -o ${HUB_SSH_USER} -g ${HUB_SSH_USER} /home/${HUB_SSH_USER}/.ssh`,
    `grep -qxF '${key}' /home/${HUB_SSH_USER}/.ssh/authorized_keys 2>/dev/null || echo '${key}' >> /home/${HUB_SSH_USER}/.ssh/authorized_keys`,
    `chown ${HUB_SSH_USER}:${HUB_SSH_USER} /home/${HUB_SSH_USER}/.ssh/authorized_keys && chmod 600 /home/${HUB_SSH_USER}/.ssh/authorized_keys`,
    ""
  ].join("\n");
}

/**
 * The command shown in Settings, to paste into Terminal (zsh or bash).
 * `nonce` names this command, so the app takes back only the line it
 * printed. The server's host keys come from AWS's own answer (signed in as
 * the User), so neither this command nor the app has to trust the first key
 * a server presents.
 */
export function buildHubSetupCommand(region: string, publicKey: string, nonce: string): string {
  if (!isHubRegion(region)) throw new Error("Choose an AWS region such as us-east-1.");
  if (!isHubNonce(nonce)) throw new Error("Invalid setup label.");
  const key = assertPublicKey(publicKey);
  const user = HUB_SSH_USER;
  const script = [
    "set -euo pipefail",
    `REGION=${region}`,
    `NAME=${HUB_INSTANCE_NAME}`,
    `IP_NAME=${HUB_STATIC_IP_NAME}`,
    `NONCE=${nonce}`,
    `KEY='${key}'`,
    'L() { aws lightsail --region "$REGION" "$@"; }',
    'say() { printf "%s\\n" "$*" >&2; }',
    'TMP=$(mktemp -d); trap \'rm -rf "$TMP"\' EXIT',
    "umask 077",
    'if ! L get-instance --instance-name "$NAME" >/dev/null 2>&1; then',
    '  ZONE=$(aws lightsail get-regions --region "$REGION" --include-availability-zones --query "regions[?name==\'$REGION\'].availabilityZones[0].zoneName | [0]" --output text)',
    '  say "Creating the server ${NAME} in ${ZONE}..."',
    `  L create-instances --instance-names "$NAME" --availability-zone "$ZONE" --blueprint-id ${HUB_BLUEPRINT_ID} --bundle-id ${HUB_BUNDLE_ID} --user-data "$(cat <<'BOOT'`,
    hubLaunchScript(key).trimEnd(),
    "BOOT",
    `)" --tags key=${HUB_TAG},value=1 >/dev/null`,
    "  NEW=1",
    "else",
    "  NEW=",
    '  say "Found the server ${NAME}."',
    "fi",
    // A server that was stopped (or is stopping) is started again, once.
    "STARTED=",
    "for _ in $(seq 1 90); do",
    '  STATE=$(L get-instance --instance-name "$NAME" --query instance.state.name --output text)',
    '  [ "$STATE" = running ] && break',
    '  if [ "$STATE" = stopped ] && [ -z "$STARTED" ]; then say "Starting the server ${NAME}..."; L start-instance --instance-name "$NAME" >/dev/null; STARTED=1; fi',
    "  sleep 5",
    "done",
    '[ "$(L get-instance --instance-name "$NAME" --query instance.state.name --output text)" = running ] || { say "The server did not start; run the command again."; exit 1; }',
    'L get-static-ip --static-ip-name "$IP_NAME" >/dev/null 2>&1 || L allocate-static-ip --static-ip-name "$IP_NAME" >/dev/null',
    '[ "$(L get-static-ip --static-ip-name "$IP_NAME" --query staticIp.attachedTo --output text)" = "$NAME" ] || L attach-static-ip --static-ip-name "$IP_NAME" --instance-name "$NAME" >/dev/null',
    'IP=$(L get-static-ip --static-ip-name "$IP_NAME" --query staticIp.ipAddress --output text)',
    // SSH for setup and updates, 80 for the certificate check, 443 for the app.
    'L put-instance-public-ports --instance-name "$NAME" --port-infos fromPort=22,toPort=22,protocol=tcp fromPort=80,toPort=80,protocol=tcp fromPort=443,toPort=443,protocol=tcp >/dev/null',
    // One request: each issues a new key and certificate (a pair that logs
    // in only together) and reports the server's host keys, which a server
    // just made reports a while after it starts (its first boot). perl ships
    // with macOS and Linux.
    'TRIES=$([ -n "$NEW" ] && echo 120 || echo 24)',
    'for _ in $(seq 1 "$TRIES"); do',
    '  L get-instance-access-details --instance-name "$NAME" --protocol ssh --query accessDetails --output json > "$TMP/access.json"',
    '  [ "$(perl -MJSON::PP -0777 -ne \'my $d = decode_json($_); print scalar @{$d->{hostKeys} || []}\' "$TMP/access.json")" != 0 ] && break',
    '  sleep 5',
    'done',
    // IP is a shell variable: perl sees only what it is handed.
    'IP="$IP" perl -MJSON::PP -0777 -ne \'my $d = decode_json($_); print map { "$ENV{IP} $_->{algorithm} $_->{publicKey}\\n" } @{$d->{hostKeys} || []}\' "$TMP/access.json" > "$TMP/known_hosts"',
    // Without them neither this command nor the app could tell the server
    // from whatever else answers at its address.
    '[ -s "$TMP/known_hosts" ] || { say "AWS has not reported the keys of the server yet. Run the command again in a few minutes."; exit 1; }',
    'if [ -z "$NEW" ]; then',
    // A server made before (from another computer, or a key since lost): this
    // computer's key is added with the short-lived access AWS gives its owner.
    '  perl -MJSON::PP -0777 -ne \'my $d = decode_json($_); print $d->{privateKey}\' "$TMP/access.json" > "$TMP/key"',
    '  perl -MJSON::PP -0777 -ne \'my $d = decode_json($_); print $d->{certKey}\' "$TMP/access.json" > "$TMP/key-cert.pub"',
    // -n: the script itself arrives on stdin (pasted as a here-document), and
    // ssh would read the rest of it.
    '  ssh -n -i "$TMP/key" -o CertificateFile="$TMP/key-cert.pub" -o IdentitiesOnly=yes -o UserKnownHostsFile="$TMP/known_hosts" ' +
      '-o StrictHostKeyChecking=yes -o LogLevel=ERROR -o ConnectTimeout=20 ' +
      `"${user}@$IP" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && (grep -qxF '$KEY' ~/.ssh/authorized_keys 2>/dev/null || echo '$KEY' >> ~/.ssh/authorized_keys) && chmod 600 ~/.ssh/authorized_keys"`,
    "fi",
    `BLOB=$(REGION="$REGION" NAME="$NAME" IP="$IP" NONCE="$NONCE" perl -MJSON::PP -MMIME::Base64 -0777 -ne 'my $d = decode_json($_); my @k = map { "$_->{algorithm} $_->{publicKey}" } @{$d->{hostKeys} || []}; print encode_base64(encode_json({ version => 1, region => $ENV{REGION}, instanceName => $ENV{NAME}, ip => $ENV{IP}, user => "${user}", nonce => $ENV{NONCE}, hostKeys => [@k] }), "")' "$TMP/access.json")`,
    'say ""',
    'say "Done. Paste this line into AccordAgents:"',
    `printf '%s\\n' "${HUB_SETUP_BLOB_PREFIX}$BLOB"`
  ].join("\n");
  // ASCII only: bash reads a non-ASCII character after a variable name as
  // part of the name. A here-document: pasted into zsh or bash alike.
  if (!/^[\x09\x0a\x20-\x7e]*$/.test(script)) throw new Error("The setup command must be plain ASCII.");
  return `bash <<'ACCORDAGENTS_HUB'\n${script}\nACCORDAGENTS_HUB`;
}

function assertPublicKey(publicKey: string): string {
  const key = publicKey.trim();
  if (!SSH_PUBLIC_KEY.test(key)) throw new Error("The setup key of this computer is not readable.");
  return key;
}
