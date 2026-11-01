// The setup commands in Windows PowerShell 5.1, the shell of Terminal on
// Windows: the same AWS calls in the same order as the bash commands, and the
// same printed line to paste back. Pure, like their bash counterparts.
//
// Windows PowerShell mangles a native argument that contains a double quote,
// so JSON (policies, user data) is handed to the AWS CLI as a file:// path,
// never as an argument. Arguments with a comma are quoted: unquoted, PowerShell
// reads them as arrays. Every value arrives through the plan the bash builder
// spells too (awsWorkerProvisioning.ts, hubProvisioning.ts); a change to what
// one of them does belongs in both.
import { HUB_SETUP_BLOB_PREFIX } from "../../shared/hubSetup";
import type { BootstrapPlan } from "./awsWorkerProvisioning";

/** Single-quoted PowerShell literal. */
function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Helpers every command starts with. `Invoke-Aws` stops the command when an
 * AWS call fails, as `set -e` does in bash; `Test-Aws` is a call whose failure
 * is an answer (bash `>/dev/null 2>&1`), `Test-AwsStep` one whose failure ends
 * only the current step (bash `>/dev/null || return 1`). Every AWS call's
 * output is captured or piped, so the CLI never opens its pager. A temporary
 * folder only this user can open holds the files (bash: mktemp -d and umask
 * 077), removed at the end.
 */
const POWERSHELL_PRELUDE = [
  "$ErrorActionPreference = 'Continue'",
  "$Tmp = Join-Path ([IO.Path]::GetTempPath()) ('accordagents-' + [guid]::NewGuid().ToString('N'))",
  "New-Item -ItemType Directory -Path $Tmp | Out-Null",
  "icacls $Tmp /inheritance:r /grant:r ('*' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value + ':(OI)(CI)F') | Out-Null",
  "function Invoke-Aws { $out = & aws @args; if ($LASTEXITCODE -ne 0) { throw ('aws ' + ($args[0..1] -join ' ') + ' failed.') }; (@($out) -join \"`n\").Trim() }",
  "function Test-Aws { & aws @args 2>$null | Out-Null; $LASTEXITCODE -eq 0 }",
  "function Test-AwsStep { & aws @args | Out-Null; $LASTEXITCODE -eq 0 }",
  "function Get-Words([string]$Text) { @($Text -split '\\s+' | Where-Object { $_ }) }",
  "function Write-Note([string]$Text) { [Console]::Error.WriteLine($Text) }"
];

const POWERSHELL_CLEANUP = [
  "Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue"
];

/** The block pasted into Terminal: one scriptblock, so it runs once whole. */
function powerShellCommand(setup: string[], body: string[]): string {
  const script = ["& {", ...POWERSHELL_PRELUDE, ...setup, "try {", ...body.map((line) => `  ${line}`), "} finally {", ...POWERSHELL_CLEANUP.map((line) => `  ${line}`), "}", "}"].join("\n");
  // ASCII only: a pasted non-ASCII character can arrive as another one.
  if (!/^[\x09\x0a\x20-\x7e]*$/.test(script)) throw new Error("The setup command must be plain ASCII.");
  return script;
}

const KEY_FIELDS = "function Get-KeyField([string]$Json, [string]$Name) { ($Json | ConvertFrom-Json).AccessKey.$Name }";

export function powerShellBootstrapCommand(plan: BootstrapPlan): string {
  const setup = [
    `$Region = ${powerShellQuote(plan.region)}`,
    `$User = ${powerShellQuote(plan.userName)}`,
    `$Policy = ${powerShellQuote(plan.policy)}`,
    KEY_FIELDS
  ];
  const policy = [
    "[IO.File]::WriteAllText(\"$Tmp\\policy.json\", $Policy)",
    "$PolicyArn = Invoke-Aws iam list-policies --scope Local --query \"Policies[?PolicyName=='$User'].Arn | [0]\" --output text",
    "if (-not $PolicyArn -or $PolicyArn -eq 'None') {",
    "  $PolicyArn = Invoke-Aws iam create-policy --policy-name $User --policy-document \"file://$Tmp\\policy.json\" --query 'Policy.Arn' --output text",
    "} else {",
    "  foreach ($VersionId in (Get-Words (& aws iam list-policy-versions --policy-arn $PolicyArn --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text))) { Invoke-Aws iam delete-policy-version --policy-arn $PolicyArn --version-id $VersionId | Out-Null }",
    "  Invoke-Aws iam create-policy-version --policy-arn $PolicyArn --policy-document \"file://$Tmp\\policy.json\" --set-as-default | Out-Null",
    "}",
    "Invoke-Aws iam attach-user-policy --user-name $User --policy-arn $PolicyArn | Out-Null",
    "Test-Aws iam delete-user-policy --user-name $User --policy-name accordagents-worker | Out-Null"
  ];
  if (plan.kind === "permissions") {
    return powerShellCommand(setup, [
      "if (-not (Test-Aws iam get-user --user-name $User)) { throw \"Expected existing AccordAgents worker IAM user $User was not found.\" }",
      ...policy,
      "Write-Output ''",
      "Write-Output \"Updated AccordAgents worker permissions for $User. Return to AccordAgents and select Try again.\""
    ]);
  }
  // The space makes PowerShell quote the argument, so a pip-installed aws.cmd
  // (AWS CLI v1, run through cmd.exe) keeps the "&".
  const keys = "--query 'sort_by(AccessKeyMetadata, &CreateDate)[].AccessKeyId' --output text";
  const tag = powerShellQuote(`Key=${plan.tagKey},Value=${plan.tagValue}`);
  return powerShellCommand(setup, [
    "$Found = @()",
    `foreach ($R in (Get-Words (& aws ec2 describe-regions --query 'Regions[].RegionName' --output text))) { foreach ($I in (Get-Words (& aws ec2 describe-instances --region $R --filters ${powerShellQuote(`Name=tag:${plan.tagKey},Values=${plan.tagValue}`)} 'Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down' --query 'Reservations[].Instances[].InstanceId' --output text))) { $Found += ,@($R, $I) } }`,
    "if ($Found.Count -gt 1) { throw 'Multiple tagged AccordAgents workers exist; resolve them before setup.' }",
    "if ($Found.Count -eq 1) {",
    "  $WorkerRegion = $Found[0][0]; $WorkerId = $Found[0][1]",
    "  $RootDevice = Invoke-Aws ec2 describe-instances --region $WorkerRegion --instance-ids $WorkerId --query 'Reservations[0].Instances[0].RootDeviceName' --output text",
    "  $RootVolume = Invoke-Aws ec2 describe-instances --region $WorkerRegion --instance-ids $WorkerId --query \"Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName=='$RootDevice'].Ebs.VolumeId | [0]\" --output text",
    `  if ($RootVolume -and $RootVolume -ne 'None') { Invoke-Aws ec2 create-tags --region $WorkerRegion --resources $RootVolume --tags ${tag} | Out-Null }`,
    `  foreach ($Sg in (Get-Words (& aws ec2 describe-instances --region $WorkerRegion --instance-ids $WorkerId --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text))) { $SgName = Invoke-Aws ec2 describe-security-groups --region $WorkerRegion --group-ids $Sg --query 'SecurityGroups[0].GroupName' --output text; if ($SgName -clike 'accordagents-worker-*-sg') { Invoke-Aws ec2 create-tags --region $WorkerRegion --resources $Sg --tags ${tag} | Out-Null } }`,
    "}",
    "if (-not (Test-Aws iam get-user --user-name $User)) { Invoke-Aws iam create-user --user-name $User | Out-Null }",
    ...policy,
    // The key the app uses now stays valid until the app has taken the new
    // one; at IAM's two-key limit the other key goes.
    `$KeepWorkerKey = ${powerShellQuote(plan.keepWorkerKeyId)}`,
    `$Existing = Get-Words (Invoke-Aws iam list-access-keys --user-name $User ${keys})`,
    "if ($Existing.Count -ge 2) { $Drop = $Existing[0]; if ($Drop -ceq $KeepWorkerKey) { $Drop = $Existing[1] }; Invoke-Aws iam delete-access-key --user-name $User --access-key-id $Drop | Out-Null }",
    "$Key = Invoke-Aws iam create-access-key --user-name $User --output json",
    "$Akid = Get-KeyField $Key AccessKeyId",
    "$Sak = Get-KeyField $Key SecretAccessKey",
    "$PowerFields = ''",
    ...(plan.powerPolicy ? [
      `$PowerUser = ${powerShellQuote(plan.powerUserName)}`,
      `[IO.File]::WriteAllText("$Tmp\\power-policy.json", ${powerShellQuote(plan.powerPolicy)})`,
      `$KeepPowerKeys = @(${plan.keepPowerKeyIds.map(powerShellQuote).join(", ")})`,
      "function New-PowerKey {",
      "  if (-not (Test-Aws iam get-user --user-name $PowerUser)) { if (-not (Test-AwsStep iam create-user --user-name $PowerUser)) { return $null } }",
      `  if (-not (Test-AwsStep iam put-user-policy --user-name $PowerUser --policy-name ${plan.powerPolicyName} --policy-document "file://$Tmp\\power-policy.json")) { return $null }`,
      `  $Keys = & aws iam list-access-keys --user-name $PowerUser ${keys}`,
      "  if ($LASTEXITCODE -ne 0) { return $null }",
      "  $Keys = Get-Words $Keys",
      "  if ($Keys.Count -ge 2) {",
      "    $Drop = $Keys | Where-Object { $KeepPowerKeys -cnotcontains $_ } | Select-Object -First 1",
      "    if (-not $Drop) { Write-Note 'Both automatic-stop keys are still in use, so no new one was made.'; return $null }",
      "    if (-not (Test-AwsStep iam delete-access-key --user-name $PowerUser --access-key-id $Drop)) { return $null }",
      "  }",
      "  $Made = & aws iam create-access-key --user-name $PowerUser --output json",
      "  if ($LASTEXITCODE -ne 0) { return $null }",
      "  return (@($Made) -join \"`n\")",
      "}",
      "$PowerKey = New-PowerKey",
      "if ($PowerKey) { $PowerFields = ',\"power\":{\"accessKeyId\":\"' + (Get-KeyField $PowerKey AccessKeyId) + '\",\"secretAccessKey\":\"' + (Get-KeyField $PowerKey SecretAccessKey) + '\"}' }"
    ] : []),
    "if (-not $PowerFields) { Write-Note ''; Write-Note 'No new automatic-stop key was made, so automatic stop stays as it is. AccordAgents still connects with the result below.' }",
    "$WakeFields = ''",
    ...(plan.wakePolicy ? [
      // The phone's start key, made once: while the key the app holds still
      // exists, none is made, so a paired phone never has to pair again.
      `$WakeUser = ${powerShellQuote(plan.wakeUserName)}`,
      `[IO.File]::WriteAllText("$Tmp\\wake-policy.json", ${powerShellQuote(plan.wakePolicy)})`,
      `$KeepWakeKey = ${powerShellQuote(plan.keepWakeKeyId)}`,
      "function New-WakeKey {",
      "  if (-not (Test-Aws iam get-user --user-name $WakeUser)) { if (-not (Test-AwsStep iam create-user --user-name $WakeUser)) { return 'failed' } }",
      `  $Keys = & aws iam list-access-keys --user-name $WakeUser ${keys}`,
      "  if ($LASTEXITCODE -ne 0) { return 'failed' }",
      "  $Keys = Get-Words $Keys",
      "  if ($KeepWakeKey -and ($Keys -ccontains $KeepWakeKey)) { return 'kept' }",
      `  if (-not (Test-AwsStep iam put-user-policy --user-name $WakeUser --policy-name ${plan.wakePolicyName} --policy-document "file://$Tmp\\wake-policy.json")) { return 'failed' }`,
      "  if ($Keys.Count -ge 2) { if (-not (Test-AwsStep iam delete-access-key --user-name $WakeUser --access-key-id $Keys[0])) { return 'failed' } }",
      "  $Made = & aws iam create-access-key --user-name $WakeUser --output json",
      "  if ($LASTEXITCODE -ne 0) { return 'failed' }",
      "  return (@($Made) -join \"`n\")",
      "}",
      "$Wake = New-WakeKey",
      "if ($Wake -ne 'failed' -and $Wake -ne 'kept') { $WakeFields = ',\"wake\":{\"accessKeyId\":\"' + (Get-KeyField $Wake AccessKeyId) + '\",\"secretAccessKey\":\"' + (Get-KeyField $Wake SecretAccessKey) + '\"}' }",
      "if ($Wake -eq 'failed') { Write-Note ''; Write-Note 'The phone start key could not be made; the phone cannot start the machine yet. AccordAgents still connects with the result below.' }"
    ] : []),
    "$Json = '{\"accessKeyId\":\"' + $Akid + '\",\"secretAccessKey\":\"' + $Sak + '\",\"region\":\"' + $Region + '\"' + $PowerFields + $WakeFields + '}'",
    "$Blob = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Json))",
    "Write-Output ''",
    "Write-Output 'Paste this into AccordAgents:'",
    `Write-Output (${powerShellQuote(plan.blobPrefix)} + $Blob)`
  ]);
}

export interface HubSetupPlan {
  region: string;
  instanceName: string;
  staticIpName: string;
  blueprintId: string;
  bundleId: string;
  tag: string;
  user: string;
  nonce: string;
  publicKey: string;
  /** The first-boot script, line by line. */
  launchScript: string[];
}

/** The hub server command (see `buildHubSetupCommand`) in PowerShell. */
export function powerShellHubSetupCommand(plan: HubSetupPlan): string {
  const setup = [
    `$Region = ${powerShellQuote(plan.region)}`,
    `$Name = ${powerShellQuote(plan.instanceName)}`,
    `$IpName = ${powerShellQuote(plan.staticIpName)}`,
    `$Nonce = ${powerShellQuote(plan.nonce)}`,
    `$Key = ${powerShellQuote(plan.publicKey)}`,
    "function L { $out = & aws lightsail --region $Region @args; if ($LASTEXITCODE -ne 0) { throw ('aws lightsail ' + $args[0] + ' failed.') }; (@($out) -join \"`n\").Trim() }",
    "function Test-L { & aws lightsail --region $Region @args 2>$null | Out-Null; $LASTEXITCODE -eq 0 }"
  ];
  // Joined here, not pasted as lines: a pasted line break may arrive as CRLF.
  const launch = `@(${plan.launchScript.map(powerShellQuote).join(", ")}) -join "\`n"`;
  return powerShellCommand(setup, [
    `[IO.File]::WriteAllText("$Tmp\\boot.sh", (${launch}))`,
    "if (-not (Test-L get-instance --instance-name $Name)) {",
    "  $Zone = Invoke-Aws lightsail get-regions --region $Region --include-availability-zones --query \"regions[?name=='$Region'].availabilityZones[0].zoneName | [0]\" --output text",
    "  Write-Note \"Creating the server $Name in $Zone...\"",
    `  L create-instances --instance-names $Name --availability-zone $Zone --blueprint-id ${plan.blueprintId} --bundle-id ${plan.bundleId} --user-data "file://$Tmp\\boot.sh" --tags ${powerShellQuote(`key=${plan.tag},value=1`)} | Out-Null`,
    "  $New = $true",
    "} else {",
    "  $New = $false",
    "  Write-Note \"Found the server $Name.\"",
    "}",
    // A server that was stopped (or is stopping) is started again, once.
    "$Started = $false",
    "for ($i = 0; $i -lt 90; $i++) {",
    "  $State = L get-instance --instance-name $Name --query instance.state.name --output text",
    "  if ($State -eq 'running') { break }",
    "  if ($State -eq 'stopped' -and -not $Started) { Write-Note \"Starting the server $Name...\"; L start-instance --instance-name $Name | Out-Null; $Started = $true }",
    "  Start-Sleep -Seconds 5",
    "}",
    "if ((L get-instance --instance-name $Name --query instance.state.name --output text) -ne 'running') { throw 'The server did not start; run the command again.' }",
    "if (-not (Test-L get-static-ip --static-ip-name $IpName)) { L allocate-static-ip --static-ip-name $IpName | Out-Null }",
    "if ((L get-static-ip --static-ip-name $IpName --query staticIp.attachedTo --output text) -ne $Name) { L attach-static-ip --static-ip-name $IpName --instance-name $Name | Out-Null }",
    "$Ip = L get-static-ip --static-ip-name $IpName --query staticIp.ipAddress --output text",
    // SSH for setup and updates, 80 for the certificate check, 443 for the app.
    "L put-instance-public-ports --instance-name $Name --port-infos 'fromPort=22,toPort=22,protocol=tcp' 'fromPort=80,toPort=80,protocol=tcp' 'fromPort=443,toPort=443,protocol=tcp' | Out-Null",
    // Each request issues a new key and certificate and reports the server's
    // host keys, which a server just made reports a while after it starts.
    "$Tries = if ($New) { 120 } else { 24 }",
    "$HostKeys = @()",
    "for ($i = 0; $i -lt $Tries; $i++) {",
    "  $Access = (L get-instance-access-details --instance-name $Name --protocol ssh --query accessDetails --output json) | ConvertFrom-Json",
    "  $HostKeys = @($Access.hostKeys | Where-Object { $_ } | ForEach-Object { $_.algorithm + ' ' + $_.publicKey })",
    "  if ($HostKeys.Count -gt 0) { break }",
    "  Start-Sleep -Seconds 5",
    "}",
    // Without them neither this command nor the app could tell the server
    // from whatever else answers at its address.
    "if ($HostKeys.Count -eq 0) { throw 'AWS has not reported the keys of the server yet. Run the command again in a few minutes.' }",
    "if (-not $New) {",
    // A server made before (from another computer, or a key since lost):
    // this computer's key is added with the short-lived access AWS gives its
    // owner. Relative paths: a profile folder may have a space in its name.
    "  [IO.File]::WriteAllText(\"$Tmp\\key\", $Access.privateKey)",
    "  [IO.File]::WriteAllText(\"$Tmp\\key-cert.pub\", $Access.certKey)",
    "  [IO.File]::WriteAllText(\"$Tmp\\known_hosts\", ((@($HostKeys | ForEach-Object { \"$Ip $_\" }) -join \"`n\") + \"`n\"))",
    "  Push-Location -LiteralPath $Tmp",
    `  try { & ssh -n -i key -o CertificateFile=key-cert.pub -o IdentitiesOnly=yes -o UserKnownHostsFile=known_hosts -o StrictHostKeyChecking=yes -o LogLevel=ERROR -o ConnectTimeout=20 "${plan.user}@$Ip" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && (grep -qxF '$Key' ~/.ssh/authorized_keys 2>/dev/null || echo '$Key' >> ~/.ssh/authorized_keys) && chmod 600 ~/.ssh/authorized_keys" } finally { Pop-Location }`,
    "  if ($LASTEXITCODE -ne 0) { throw 'This computer could not be let in to the server. Run the command again.' }",
    "}",
    `$Blob = [ordered]@{ version = 1; region = $Region; instanceName = $Name; ip = $Ip; user = ${powerShellQuote(plan.user)}; nonce = $Nonce; hostKeys = [string[]]$HostKeys } | ConvertTo-Json -Compress`,
    "Write-Note ''",
    "Write-Note 'Done. Paste this line into AccordAgents:'",
    `Write-Output (${powerShellQuote(HUB_SETUP_BLOB_PREFIX)} + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Blob)))`
  ]);
}
