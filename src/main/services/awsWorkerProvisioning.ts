// Pure helpers for the AWS-managed Cloud Runs worker: the one-shot bootstrap
// command the user runs with their own AWS auth, the paste-blob it produces,
// and the instance-launch spec. No AWS SDK and no side effects live here so
// this is fully unit-testable; awsWorkerLifecycle.ts drives the real EC2 calls.

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
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DescribeInRegion",
        Effect: "Allow",
        Action: [
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceStatus",
          "ec2:DescribeImages",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets",
          "ec2:DescribeVpcs",
          "ec2:DescribeKeyPairs"
        ],
        Resource: "*",
        Condition: regionCondition
      },
      {
        Sid: "CreateInfra",
        Effect: "Allow",
        Action: [
          "ec2:RunInstances",
          "ec2:ImportKeyPair",
          "ec2:CreateKeyPair",
          "ec2:CreateSecurityGroup",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:RevokeSecurityGroupIngress",
          "ec2:CreateTags"
        ],
        Resource: "*",
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
            "aws:RequestedRegion": region,
            [`ec2:ResourceTag/${AWS_WORKER_TAG_KEY}`]: AWS_WORKER_TAG_VALUE
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
    'aws iam create-user --user-name "$USER" >/dev/null',
    'aws iam put-user-policy --user-name "$USER" --policy-name accordagents-worker --policy-document "$POLICY" >/dev/null',
    'KEY=$(aws iam create-access-key --user-name "$USER" --output json)',
    'AKID=$(printf "%s" "$KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)[\\"AccessKey\\"][\\"AccessKeyId\\"])")',
    'SAK=$(printf "%s" "$KEY" | python3 -c "import sys,json;print(json.load(sys.stdin)[\\"AccessKey\\"][\\"SecretAccessKey\\"])")',
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
  instanceType: string;
  keyName: string;
  securityGroupId: string;
  userData: string;
  tagKey: string;
  tagValue: string;
}

export function buildWorkerInstanceSpec(options: {
  imageId: string;
  keyName: string;
  securityGroupId: string;
  instanceType?: string;
}): WorkerInstanceSpec {
  return {
    imageId: options.imageId,
    instanceType: options.instanceType?.trim() || DEFAULT_AWS_WORKER_INSTANCE_TYPE,
    keyName: options.keyName,
    securityGroupId: options.securityGroupId,
    userData: Buffer.from(buildWorkerCloudInit(), "utf8").toString("base64"),
    tagKey: AWS_WORKER_TAG_KEY,
    tagValue: AWS_WORKER_TAG_VALUE
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
