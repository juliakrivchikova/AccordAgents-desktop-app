// Pure helpers for the AWS-managed Cloud Runs worker: the one-shot bootstrap
// command the user runs with their own AWS auth, the paste-blob it produces,
// and the instance-launch spec. No AWS SDK and no side effects live here so
// this is fully unit-testable; awsWorkerLifecycle.ts drives the real EC2 calls.
import { normalizeAwsRootVolumeSizeGb } from "../../shared/cloudRuns";

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
}

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
// already has AWS auth; it creates a dedicated IAM user with the scoped policy,
// mints an access key, and prints the paste blob. It never touches anything
// outside that one IAM user + policy, and the app never sees the user's own
// credentials — only the scoped key they paste back.
export function buildBootstrapCommand(region: string, userSuffix: string): string {
  const safeRegion = assertToken("region", region);
  const userName = `accordagents-worker-${assertToken("suffix", userSuffix)}`;
  const policy = JSON.stringify(buildScopedWorkerPolicy(safeRegion));
  // Single-quote the policy for the shell; escape embedded quotes.
  const policyLiteral = `'${policy.replace(/'/g, `'\\''`)}'`;
  return [
    "set -e",
    `REGION=${safeRegion}`,
    `USER=${userName}`,
    `POLICY=${policyLiteral}`,
    "FOUND_WORKERS=",
    `for R in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do for I in $(aws ec2 describe-instances --region \"$R\" --filters Name=tag:${AWS_WORKER_TAG_KEY},Values=${AWS_WORKER_TAG_VALUE} Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down --query 'Reservations[].Instances[].InstanceId' --output text); do FOUND_WORKERS=\"$FOUND_WORKERS $R $I\"; done; done`,
    "set -- $FOUND_WORKERS",
    "if [ $(( $# / 2 )) -gt 1 ]; then printf '%s\\n' 'Multiple tagged AccordAgents workers exist; resolve them before setup.' >&2; exit 1; fi",
    "if [ $# -eq 2 ]; then WORKER_REGION=$1; WORKER_ID=$2; ROOT_DEVICE=$(aws ec2 describe-instances --region \"$WORKER_REGION\" --instance-ids \"$WORKER_ID\" --query 'Reservations[0].Instances[0].RootDeviceName' --output text); ROOT_VOLUME=$(aws ec2 describe-instances --region \"$WORKER_REGION\" --instance-ids \"$WORKER_ID\" --query \"Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName=='$ROOT_DEVICE'].Ebs.VolumeId | [0]\" --output text); if [ -n \"$ROOT_VOLUME\" ] && [ \"$ROOT_VOLUME\" != None ]; then aws ec2 create-tags --region \"$WORKER_REGION\" --resources \"$ROOT_VOLUME\" --tags Key=accordagents-worker,Value=1; fi; for SG in $(aws ec2 describe-instances --region \"$WORKER_REGION\" --instance-ids \"$WORKER_ID\" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text); do SG_NAME=$(aws ec2 describe-security-groups --region \"$WORKER_REGION\" --group-ids \"$SG\" --query 'SecurityGroups[0].GroupName' --output text); case \"$SG_NAME\" in accordagents-worker-*-sg) aws ec2 create-tags --region \"$WORKER_REGION\" --resources \"$SG\" --tags Key=accordagents-worker,Value=1 ;; esac; done; fi",
    'if ! aws iam get-user --user-name "$USER" >/dev/null 2>&1; then aws iam create-user --user-name "$USER" >/dev/null; fi',
    'aws iam put-user-policy --user-name "$USER" --policy-name accordagents-worker --policy-document "$POLICY" >/dev/null',
    'EXISTING_KEYS=$(aws iam list-access-keys --user-name "$USER" --query \'sort_by(AccessKeyMetadata,&CreateDate)[].AccessKeyId\' --output text)',
    'set -- $EXISTING_KEYS',
    'if [ "$#" -ge 2 ]; then aws iam delete-access-key --user-name "$USER" --access-key-id "$1"; shift; fi',
    'KEY=$(aws iam create-access-key --user-name "$USER" --output json)',
    'AKID=$(printf "%s" "$KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)[\\"AccessKey\\"][\\"AccessKeyId\\"])")',
    'SAK=$(printf "%s" "$KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)[\\"AccessKey\\"][\\"SecretAccessKey\\"])")',
    'for OLD_AKID in "$@"; do aws iam delete-access-key --user-name "$USER" --access-key-id "$OLD_AKID"; done',
    `BLOB=$(printf '{"accessKeyId":"%s","secretAccessKey":"%s","region":"%s"}' "$AKID" "$SAK" "$REGION" | base64 | tr -d '\\n')`,
    `printf '\\nPaste this into AccordAgents:\\n${AWS_WORKER_BLOB_PREFIX}%s\\n' "$BLOB"`
  ].join("\n");
}

export function encodeWorkerBlob(credentials: AwsWorkerCredentials): string {
  const json = JSON.stringify({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region
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
  if (!/^AKIA[0-9A-Z]{12,}$/.test(accessKeyId)) {
    throw new Error("The pasted access key id does not look like an AWS access key.");
  }
  return { accessKeyId, secretAccessKey, region };
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
    "runcmd:",
    "  - [ bash, -lc, \"curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs\" ]",
    "  - [ bash, -lc, \"npm install -g @openai/codex\" ]",
    "  - [ bash, -lc, \"type gh >/dev/null 2>&1 || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y gh)\" ]",
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
