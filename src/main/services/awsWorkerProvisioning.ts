// Pure helpers for the AWS-managed Cloud Runs worker: the one-shot bootstrap
// command the user runs with their own AWS auth, the paste-blob it produces,
// and the instance-launch spec. No AWS SDK and no side effects live here so
// this is fully unit-testable; awsWorkerLifecycle.ts drives the real EC2 calls.
import { normalizeAwsRootVolumeSizeGb } from "../../shared/cloudRuns";
import { machinePowerPolicy, machineWakePolicy } from "../../shared/machinePower";

export const AWS_WORKER_TAG_KEY = "accordagents-worker";
export const AWS_WORKER_TAG_VALUE = "1";
export const AWS_WORKER_BLOB_PREFIX = "accord-aws-v1:";
// Ubuntu 24.04 LTS canonical owner; the AMI is resolved per-region by the
// lifecycle service via DescribeImages so we never hardcode a stale AMI id.
export const UBUNTU_2404_OWNER = "099720109477";
export const UBUNTU_2404_NAME_PATTERN = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*";
export const DEFAULT_AWS_WORKER_INSTANCE_TYPE = "t3.small";

export interface AwsWorkerCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** The machine's own stop key (`machinePowerPolicy`): it can only read,
   *  start and stop app-tagged instances in `region`. Minted by the same setup
   *  command as the worker key, so there is one terminal step, not two. The
   *  app never calls AWS with it; it is handed to the machine on the instance. */
  power?: AwsMachinePowerKey;
  /** The phone's key (`machineWakePolicy`): it can only start app-tagged
   *  instances in `region`. Minted once and kept, so a phone is paired with it
   *  once; it reaches a phone only inside the pairing link. */
  wake?: AwsMachinePowerKey;
}

export interface AwsMachinePowerKey {
  accessKeyId: string;
  secretAccessKey: string;
}

/** The inline policy name on the stop-key user. */
export const AWS_MACHINE_POWER_POLICY_NAME = "accordagents-machine-power";
/** The inline policy name on the phone's start-key user. */
export const AWS_MACHINE_WAKE_POLICY_NAME = "accordagents-machine-wake";

// A minimal IAM policy scoped to one region and to instances carrying the
// accordagents-worker tag. RunInstances is allowed in-region and must tag the
// instance; start/stop/terminate are limited to already-tagged instances.
// Read-only describes are region-wide (they carry no resource ARNs). This caps
// the blast radius: whoever holds these keys can manage only AccordAgents
// worker instances in the chosen region, nothing else in the account.
export function buildScopedWorkerPolicy(region: string): unknown {
  const regionCondition = { StringEquals: { "aws:RequestedRegion": region } };
  const regionArn = `arn:aws:ec2:${region}:*`;
  const requiredWorkerTags = {
    StringEquals: {
      "aws:RequestedRegion": region,
      [`aws:RequestTag/${AWS_WORKER_TAG_KEY}`]: AWS_WORKER_TAG_VALUE
    },
    "ForAllValues:StringEquals": {
      "aws:TagKeys": [AWS_WORKER_TAG_KEY, "Name"]
    }
  };
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DiscoverWorkers",
        Effect: "Allow",
        Action: [
          "ec2:DescribeRegions",
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceStatus",
          "ec2:DescribeInstanceTypes",
          "ec2:DescribeImages",
          "ec2:DescribeVolumes",
          "ec2:DescribeVolumesModifications",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets",
          "ec2:DescribeVpcs",
          "ec2:DescribeKeyPairs"
        ],
        Resource: "*"
      },
      {
        Sid: "RunTaggedWorkerResources",
        Effect: "Allow",
        Action: ["ec2:RunInstances"],
        Resource: [
          `${regionArn}:instance/*`,
          `${regionArn}:volume/*`
        ],
        Condition: requiredWorkerTags
      },
      {
        Sid: "UseWorkerLaunchDependencies",
        Effect: "Allow",
        Action: ["ec2:RunInstances"],
        Resource: [
          `${regionArn}:image/*`,
          `${regionArn}:subnet/*`,
          `${regionArn}:security-group/*`,
          `${regionArn}:key-pair/accordagents-worker-*`,
          `${regionArn}:network-interface/*`
        ],
        Condition: regionCondition
      },
      {
        Sid: "CreateTaggedWorkerInfra",
        Effect: "Allow",
        Action: ["ec2:ImportKeyPair", "ec2:CreateSecurityGroup"],
        Resource: "*",
        Condition: regionCondition
      },
      {
        Sid: "TagWorkerResourcesAtCreation",
        Effect: "Allow",
        Action: ["ec2:CreateTags"],
        Resource: [
          `${regionArn}:instance/*`,
          `${regionArn}:volume/*`,
          `${regionArn}:security-group/*`,
          `${regionArn}:key-pair/accordagents-worker-*`
        ],
        Condition: {
          ...requiredWorkerTags,
          StringEquals: {
            ...requiredWorkerTags.StringEquals,
            "ec2:CreateAction": ["RunInstances", "CreateSecurityGroup", "ImportKeyPair"]
          }
        }
      },
      {
        Sid: "DeleteAppKeyPairs",
        Effect: "Allow",
        Action: ["ec2:DeleteKeyPair"],
        Resource: [`${regionArn}:key-pair/accordagents-worker-*`],
        Condition: regionCondition
      },
      {
        Sid: "ManageTaggedInstances",
        Effect: "Allow",
        Action: [
          "ec2:StartInstances",
          "ec2:StopInstances",
          "ec2:TerminateInstances"
        ],
        Resource: "*",
        Condition: {
          StringEquals: {
            [`ec2:ResourceTag/${AWS_WORKER_TAG_KEY}`]: AWS_WORKER_TAG_VALUE
          }
        }
      },
      {
        Sid: "ManageTaggedWorkerStorageAndNetwork",
        Effect: "Allow",
        Action: [
          "ec2:ModifyVolume",
          "ec2:DeleteSecurityGroup",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:RevokeSecurityGroupIngress"
        ],
        Resource: "*",
        Condition: {
          StringEquals: {
            [`ec2:ResourceTag/${AWS_WORKER_TAG_KEY}`]: AWS_WORKER_TAG_VALUE
          }
        }
      },
      {
        Sid: "ConnectToTaggedWorkers",
        Effect: "Allow",
        Action: ["ec2-instance-connect:SendSSHPublicKey"],
        Resource: "*",
        Condition: {
          StringEquals: {
            [`aws:ResourceTag/${AWS_WORKER_TAG_KEY}`]: AWS_WORKER_TAG_VALUE,
            "ec2:osuser": "ubuntu"
          }
        }
      }
    ]
  };
}

// The copy-paste snippet shown in the app. The user runs it in a terminal that
// already has AWS auth. It creates three dedicated IAM users, printed together
// as one paste blob: the app's worker user with the scoped policy above, the
// machine's stop-key user with `machinePowerPolicy` (read, start and stop
// app-tagged instances in the region), and the phone's start-key user with
// `machineWakePolicy` (read and start them), whose key is made only once. It
// never touches anything outside those users and their policies, and the app
// never sees the user's own credentials, only the scoped keys pasted back.
export function buildBootstrapCommand(
  region: string,
  userSuffix: string,
  options: {
    targetUserName?: string;
    keepWorkerKeyId?: string;
    keepPowerKeyIds?: readonly string[];
    keepWakeKeyId?: string;
    /** False: make only the app's key, and leave the stop and start keys of an
     *  instance in another region alone. */
    machineKeys?: boolean;
  } = {}
): string {
  const safeRegion = assertToken("region", region);
  const targetUserName = options.targetUserName ? assertWorkerUserName(options.targetUserName) : undefined;
  const userName = targetUserName ?? `accordagents-worker-${assertToken("suffix", userSuffix)}`;
  const policy = JSON.stringify(buildScopedWorkerPolicy(safeRegion));
  if (policy.length > 6_144) {
    throw new Error("AWS worker policy exceeds the IAM customer-managed policy size limit.");
  }
  // Single-quote the policy for the shell; escape embedded quotes.
  const policyLiteral = shellSingleQuote(policy);
  if (targetUserName) {
    // An in-place permission update mints no key, so it never touches the stop key.
    return [
      "set -e",
      `REGION=${safeRegion}`,
      `USER=${userName}`,
      `POLICY=${policyLiteral}`,
      'if ! aws iam get-user --user-name "$USER" >/dev/null 2>&1; then printf "%s\\n" "Expected existing AccordAgents worker IAM user $USER was not found." >&2; exit 1; fi',
      'POLICY_ARN=$(aws iam list-policies --scope Local --query "Policies[?PolicyName==\x27$USER\x27].Arn | [0]" --output text)',
      'if [ -z "$POLICY_ARN" ] || [ "$POLICY_ARN" = None ]; then POLICY_ARN=$(aws iam create-policy --policy-name "$USER" --policy-document "$POLICY" --query "Policy.Arn" --output text); else for VERSION_ID in $(aws iam list-policy-versions --policy-arn "$POLICY_ARN" --query \x27Versions[?IsDefaultVersion==\x60false\x60].VersionId\x27 --output text); do aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$VERSION_ID"; done; aws iam create-policy-version --policy-arn "$POLICY_ARN" --policy-document "$POLICY" --set-as-default >/dev/null; fi',
      'aws iam attach-user-policy --user-name "$USER" --policy-arn "$POLICY_ARN"',
      'aws iam delete-user-policy --user-name "$USER" --policy-name accordagents-worker >/dev/null 2>&1 || true',
      'printf "\\nUpdated AccordAgents worker permissions for %s. Return to AccordAgents and select Try again.\\n" "$USER"'
    ].join("\n");
  }
  const powerUserName = `accordagents-power-${assertToken("suffix", userSuffix)}`;
  const wakeUserName = `accordagents-wake-${assertToken("suffix", userSuffix)}`;
  if ([userName, powerUserName, wakeUserName].some((name) => name.length > 64)) throw new Error("An AWS IAM user name would exceed the IAM limit of 64 characters.");
  // Only well-formed key ids reach the script; anything else keeps nothing.
  const keepWorkerKeyId = options.keepWorkerKeyId && isAwsAccessKeyId(options.keepWorkerKeyId) ? options.keepWorkerKeyId : "";
  const keepPowerKeyIds = [...new Set((options.keepPowerKeyIds ?? []).filter(isAwsAccessKeyId))].join(" ");
  const keepWakeKeyId = options.keepWakeKeyId && isAwsAccessKeyId(options.keepWakeKeyId) ? options.keepWakeKeyId : "";
  // A region the stop- and start-key policies cannot name still gets the app's key.
  const machineKeys = options.machineKeys !== false;
  const powerPolicy = machineKeys ? policyOrUndefined(() => machinePowerPolicy(safeRegion)) : undefined;
  const wakePolicy = machineKeys ? policyOrUndefined(() => machineWakePolicy(safeRegion)) : undefined;
  return [
    "set -e",
    `REGION=${safeRegion}`,
    `USER=${userName}`,
    `POLICY=${policyLiteral}`,
    "FOUND_WORKERS=",
    `for R in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do for I in $(aws ec2 describe-instances --region \"$R\" --filters Name=tag:${AWS_WORKER_TAG_KEY},Values=${AWS_WORKER_TAG_VALUE} Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down --query 'Reservations[].Instances[].InstanceId' --output text); do FOUND_WORKERS=\"$FOUND_WORKERS $R $I\"; done; done`,
    // Split explicitly: the command is pasted into the user's own shell, and
    // zsh (the macOS default) does not split an unquoted variable.
    "set -- $(printf '%s\\n' \"$FOUND_WORKERS\")",
    "if [ $(( $# / 2 )) -gt 1 ]; then printf '%s\\n' 'Multiple tagged AccordAgents workers exist; resolve them before setup.' >&2; exit 1; fi",
    "if [ $# -eq 2 ]; then WORKER_REGION=$1; WORKER_ID=$2; ROOT_DEVICE=$(aws ec2 describe-instances --region \"$WORKER_REGION\" --instance-ids \"$WORKER_ID\" --query 'Reservations[0].Instances[0].RootDeviceName' --output text); ROOT_VOLUME=$(aws ec2 describe-instances --region \"$WORKER_REGION\" --instance-ids \"$WORKER_ID\" --query \"Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName=='$ROOT_DEVICE'].Ebs.VolumeId | [0]\" --output text); if [ -n \"$ROOT_VOLUME\" ] && [ \"$ROOT_VOLUME\" != None ]; then aws ec2 create-tags --region \"$WORKER_REGION\" --resources \"$ROOT_VOLUME\" --tags Key=accordagents-worker,Value=1; fi; for SG in $(aws ec2 describe-instances --region \"$WORKER_REGION\" --instance-ids \"$WORKER_ID\" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text); do SG_NAME=$(aws ec2 describe-security-groups --region \"$WORKER_REGION\" --group-ids \"$SG\" --query 'SecurityGroups[0].GroupName' --output text); case \"$SG_NAME\" in accordagents-worker-*-sg) aws ec2 create-tags --region \"$WORKER_REGION\" --resources \"$SG\" --tags Key=accordagents-worker,Value=1 ;; esac; done; fi",
    'if ! aws iam get-user --user-name "$USER" >/dev/null 2>&1; then aws iam create-user --user-name "$USER" >/dev/null; fi',
    'POLICY_ARN=$(aws iam list-policies --scope Local --query "Policies[?PolicyName==\x27$USER\x27].Arn | [0]" --output text)',
    'if [ -z "$POLICY_ARN" ] || [ "$POLICY_ARN" = None ]; then POLICY_ARN=$(aws iam create-policy --policy-name "$USER" --policy-document "$POLICY" --query "Policy.Arn" --output text); else for VERSION_ID in $(aws iam list-policy-versions --policy-arn "$POLICY_ARN" --query \x27Versions[?IsDefaultVersion==\x60false\x60].VersionId\x27 --output text); do aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$VERSION_ID"; done; aws iam create-policy-version --policy-arn "$POLICY_ARN" --policy-document "$POLICY" --set-as-default >/dev/null; fi',
    'aws iam attach-user-policy --user-name "$USER" --policy-arn "$POLICY_ARN"',
    'aws iam delete-user-policy --user-name "$USER" --policy-name accordagents-worker >/dev/null 2>&1 || true',
    // The key the app uses now stays valid until the app has taken the new
    // one: a result that is never pasted, or is refused, leaves the app
    // working. At IAM's two-key limit the other key goes; a superseded key
    // is removed by the next run.
    `KEEP_WORKER_KEY=${keepWorkerKeyId}`,
    'EXISTING_KEYS=$(aws iam list-access-keys --user-name "$USER" --query \'sort_by(AccessKeyMetadata,&CreateDate)[].AccessKeyId\' --output text)',
    "set -- $(printf '%s\\n' \"$EXISTING_KEYS\")",
    'if [ "$#" -ge 2 ]; then DROP=$1; if [ "$DROP" = "$KEEP_WORKER_KEY" ]; then DROP=$2; fi; aws iam delete-access-key --user-name "$USER" --access-key-id "$DROP"; fi',
    'KEY=$(aws iam create-access-key --user-name "$USER" --output json)',
    'AKID=$(printf "%s" "$KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)[\\"AccessKey\\"][\\"AccessKeyId\\"])")',
    'SAK=$(printf "%s" "$KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)[\\"AccessKey\\"][\\"SecretAccessKey\\"])")',
    // The machine's stop key, from the same run: a second user whose only
    // rights are to read, start and stop app-tagged instances in this region.
    // It never costs the connection: if this account refuses any step, the
    // result is printed without it and the app keeps the stop key it has.
    // Keys still in use (the one the machine holds, the one waiting to be
    // handed over) are never deleted; with both IAM slots in use, no new key
    // is made.
    ...(powerPolicy ? [
      `POWER_USER=${powerUserName}`,
      `POWER_POLICY=${shellSingleQuote(powerPolicy)}`,
      `KEEP_POWER_KEYS=${shellSingleQuote(keepPowerKeyIds)}`,
      "mint_power_key() {",
      '  aws iam get-user --user-name "$POWER_USER" >/dev/null 2>&1 || aws iam create-user --user-name "$POWER_USER" >/dev/null || return 1',
      `  aws iam put-user-policy --user-name "$POWER_USER" --policy-name ${AWS_MACHINE_POWER_POLICY_NAME} --policy-document "$POWER_POLICY" || return 1`,
      '  POWER_KEYS=$(aws iam list-access-keys --user-name "$POWER_USER" --query \'sort_by(AccessKeyMetadata,&CreateDate)[].AccessKeyId\' --output text) || return 1',
      "  set -- $(printf '%s\\n' \"$POWER_KEYS\")",
      '  if [ "$#" -ge 2 ]; then',
      "    DROP=",
      '    for CANDIDATE in "$@"; do case " $KEEP_POWER_KEYS " in *" $CANDIDATE "*) ;; *) DROP=$CANDIDATE; break ;; esac; done',
      '    if [ -z "$DROP" ]; then printf "%s\\n" "Both automatic-stop keys are still in use, so no new one was made." >&2; return 1; fi',
      '    aws iam delete-access-key --user-name "$POWER_USER" --access-key-id "$DROP" || return 1',
      "  fi",
      '  aws iam create-access-key --user-name "$POWER_USER" --output json',
      "}",
      "POWER_FIELDS=",
      'if POWER_KEY=$(mint_power_key); then POWER_AKID=$(printf "%s" "$POWER_KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)[\\"AccessKey\\"][\\"AccessKeyId\\"])") && POWER_SAK=$(printf "%s" "$POWER_KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)[\\"AccessKey\\"][\\"SecretAccessKey\\"])") && POWER_FIELDS=$(printf \',"power":{"accessKeyId":"%s","secretAccessKey":"%s"}\' "$POWER_AKID" "$POWER_SAK"); fi'
    ] : ["POWER_FIELDS="]),
    'if [ -z "$POWER_FIELDS" ]; then printf "\\n%s\\n" "No new automatic-stop key was made, so automatic stop stays as it is. AccordAgents still connects with the result below." >&2; fi',
    // The phone's start key, made once: while the key the app holds still
    // exists, none is made and the app keeps it, so a phone paired with it
    // never has to be paired again because this command ran.
    ...(wakePolicy ? [
      `WAKE_USER=${wakeUserName}`,
      `WAKE_POLICY=${shellSingleQuote(wakePolicy)}`,
      `KEEP_WAKE_KEY=${keepWakeKeyId}`,
      "mint_wake_key() {",
      '  aws iam get-user --user-name "$WAKE_USER" >/dev/null 2>&1 || aws iam create-user --user-name "$WAKE_USER" >/dev/null || return 1',
      '  WAKE_KEYS=$(aws iam list-access-keys --user-name "$WAKE_USER" --query \'sort_by(AccessKeyMetadata,&CreateDate)[].AccessKeyId\' --output text) || return 1',
      "  set -- $(printf '%s\\n' \"$WAKE_KEYS\")",
      // The phones' key, and its policy, stay exactly as they are.
      '  for CANDIDATE in "$@"; do if [ "$CANDIDATE" = "$KEEP_WAKE_KEY" ]; then return 2; fi; done',
      `  aws iam put-user-policy --user-name "$WAKE_USER" --policy-name ${AWS_MACHINE_WAKE_POLICY_NAME} --policy-document "$WAKE_POLICY" || return 1`,
      '  if [ "$#" -ge 2 ]; then aws iam delete-access-key --user-name "$WAKE_USER" --access-key-id "$1" || return 1; fi',
      '  aws iam create-access-key --user-name "$WAKE_USER" --output json',
      "}",
      "WAKE_FIELDS=",
      "WAKE_RC=0",
      'WAKE_KEY=$(mint_wake_key) || WAKE_RC=$?',
      'if [ "$WAKE_RC" -eq 0 ]; then WAKE_AKID=$(printf "%s" "$WAKE_KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)[\\"AccessKey\\"][\\"AccessKeyId\\"])") && WAKE_SAK=$(printf "%s" "$WAKE_KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)[\\"AccessKey\\"][\\"SecretAccessKey\\"])") && WAKE_FIELDS=$(printf \',"wake":{"accessKeyId":"%s","secretAccessKey":"%s"}\' "$WAKE_AKID" "$WAKE_SAK"); fi',
      'if [ "$WAKE_RC" -eq 1 ]; then printf "\\n%s\\n" "The phone start key could not be made; the phone cannot start the machine yet. AccordAgents still connects with the result below." >&2; fi'
    ] : ["WAKE_FIELDS="]),
    `BLOB=$(printf '{"accessKeyId":"%s","secretAccessKey":"%s","region":"%s"%s%s}' "$AKID" "$SAK" "$REGION" "$POWER_FIELDS" "$WAKE_FIELDS" | base64 | tr -d '\\n')`,
    `printf '\\nPaste this into AccordAgents:\\n${AWS_WORKER_BLOB_PREFIX}%s\\n' "$BLOB"`
  ].join("\n");
}

function policyOrUndefined(build: () => unknown): string | undefined {
  try {
    return JSON.stringify(build());
  } catch {
    return undefined;
  }
}

function isAwsAccessKeyId(value: string): boolean {
  return /^AKIA[0-9A-Z]{12,}$/.test(value);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function encodeWorkerBlob(credentials: AwsWorkerCredentials): string {
  const json = JSON.stringify({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
    ...(credentials.power ? { power: { accessKeyId: credentials.power.accessKeyId, secretAccessKey: credentials.power.secretAccessKey } } : {}),
    ...(credentials.wake ? { wake: { accessKeyId: credentials.wake.accessKeyId, secretAccessKey: credentials.wake.secretAccessKey } } : {})
  });
  return `${AWS_WORKER_BLOB_PREFIX}${Buffer.from(json, "utf8").toString("base64")}`;
}

export function parseWorkerBlob(blob: string): AwsWorkerCredentials {
  const trimmed = blob.trim();
  const body = trimmed.startsWith(AWS_WORKER_BLOB_PREFIX)
    ? trimmed.slice(AWS_WORKER_BLOB_PREFIX.length)
    : trimmed;
  let decoded: string;
  try {
    decoded = Buffer.from(body, "base64").toString("utf8");
  } catch {
    throw new Error("The pasted worker setup value is not valid.");
  }
  let parsed: Partial<AwsWorkerCredentials>;
  try {
    parsed = JSON.parse(decoded) as Partial<AwsWorkerCredentials>;
  } catch {
    throw new Error("The pasted worker setup value is not valid.");
  }
  const accessKeyId = typeof parsed.accessKeyId === "string" ? parsed.accessKeyId.trim() : "";
  const secretAccessKey = typeof parsed.secretAccessKey === "string" ? parsed.secretAccessKey.trim() : "";
  const region = typeof parsed.region === "string" ? parsed.region.trim() : "";
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error("The pasted worker setup value is missing required fields.");
  }
  if (!isAwsAccessKeyId(accessKeyId)) {
    throw new Error("The pasted access key id does not look like an AWS access key.");
  }
  // Older setup commands print no stop key; that is a valid connection
  // without automatic stop. A stop key that is present but damaged is not.
  const power = parsePowerKey((parsed as { power?: unknown }).power, "automatic-stop");
  const wake = parsePowerKey((parsed as { wake?: unknown }).wake, "phone start");
  return { accessKeyId, secretAccessKey, region, ...(power ? { power } : {}), ...(wake ? { wake } : {}) };
}

function parsePowerKey(value: unknown, label: string): AwsMachinePowerKey | undefined {
  if (value === undefined) return undefined;
  const key = (value && typeof value === "object" ? value : {}) as Partial<AwsMachinePowerKey>;
  const accessKeyId = typeof key.accessKeyId === "string" ? key.accessKeyId.trim() : "";
  const secretAccessKey = typeof key.secretAccessKey === "string" ? key.secretAccessKey.trim() : "";
  if (!isAwsAccessKeyId(accessKeyId) || !secretAccessKey) {
    throw new Error(`The pasted worker setup value has a damaged ${label} key. Copy the whole result again.`);
  }
  return { accessKeyId, secretAccessKey };
}

// cloud-init that installs the worker toolchain at first boot, so a freshly
// launched instance converges to a working state before the doctor even runs.
export function buildWorkerCloudInit(): string {
  return [
    "#cloud-config",
    "package_update: true",
    "packages:",
    "  - git",
    "  - rsync",
    "  - build-essential",
    "  - curl",
    "  - cloud-guest-utils",
    "  - ec2-instance-connect",
    // Virtual display for cloud-side Electron QA. Electron has no headless mode
    // we can rely on, so a worker without Xvfb cannot start the app at all.
    "  - xvfb",
    // storage.ts shells out to the sqlite3 CLI; Ubuntu server does not ship it.
    "  - sqlite3",
    "runcmd:",
    "  - [ bash, -lc, \"curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs\" ]",
    "  - [ bash, -lc, \"npm install -g @openai/codex\" ]",
    "  - [ bash, -lc, \"type gh >/dev/null 2>&1 || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y gh)\" ]",
    // Google's .deb rather than the snap-backed `chromium` package: it works
    // headless on a bare EC2 box and pulls the GTK/NSS/ALSA libraries Electron
    // needs, so this single install covers both browser and Electron QA.
    "  - [ bash, -lc, \"type google-chrome >/dev/null 2>&1 || (tmp=$(mktemp -d) && curl -fsSL -o $tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && DEBIAN_FRONTEND=noninteractive apt-get install -y $tmp/chrome.deb && rm -rf $tmp)\" ]",
    "  - [ bash, -lc, \"sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 && echo kernel.apparmor_restrict_unprivileged_userns=0 > /etc/sysctl.d/99-accordagents-userns.conf\" ]",
    ""
  ].join("\n");
}

export interface WorkerInstanceSpec {
  imageId: string;
  rootDeviceName: string;
  instanceType: string;
  keyName: string;
  securityGroupId: string;
  userData: string;
  tagKey: string;
  tagValue: string;
  rootVolumeSizeGb: number;
  clientToken?: string;
}

export function buildWorkerInstanceSpec(options: {
  imageId: string;
  rootDeviceName: string;
  keyName: string;
  securityGroupId: string;
  instanceType?: string;
  rootVolumeSizeGb?: number;
  clientToken?: string;
}): WorkerInstanceSpec {
  return {
    imageId: options.imageId,
    rootDeviceName: options.rootDeviceName,
    instanceType: options.instanceType?.trim() || DEFAULT_AWS_WORKER_INSTANCE_TYPE,
    keyName: options.keyName,
    securityGroupId: options.securityGroupId,
    userData: Buffer.from(buildWorkerCloudInit(), "utf8").toString("base64"),
    tagKey: AWS_WORKER_TAG_KEY,
    tagValue: AWS_WORKER_TAG_VALUE,
    rootVolumeSizeGb: normalizeAwsRootVolumeSizeGb(options.rootVolumeSizeGb),
    clientToken: options.clientToken?.trim() || undefined
  };
}

// Turn a raw public IPv4 into the single-address CIDR AWS ingress rules expect.
export function ipToCidr(ip: string): string {
  const trimmed = ip.trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) {
    throw new Error(`Not a valid IPv4 address: ${ip}`);
  }
  if (trimmed.split(".").some((part) => Number(part) > 255)) {
    throw new Error(`Not a valid IPv4 address: ${ip}`);
  }
  return `${trimmed}/32`;
}

function assertToken(label: string, value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return trimmed;
}

function assertWorkerUserName(value: string): string {
  const trimmed = assertToken("AWS worker IAM user", value);
  if (!trimmed.startsWith(`${AWS_WORKER_TAG_KEY}-`)) {
    throw new Error(`Invalid AWS worker IAM user: ${value}`);
  }
  return trimmed;
}
