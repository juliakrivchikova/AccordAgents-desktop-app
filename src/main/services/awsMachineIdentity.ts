import type { AwsMachinePowerConfig } from "../../shared/machinePower";

/** The runtime may stop only the EC2 instance it actually runs on. IMDSv2
 * stays link-local, ignores redirects and sends no AWS key or relay data.
 * https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/retrieve-iid.html */
export async function assertCurrentAwsMachine(config: AwsMachinePowerConfig, request: typeof fetch = fetch): Promise<void> {
  const root = "http://169.254.169.254/latest/";
  const tokenResponse = await request(`${root}api/token`, { method: "PUT", redirect: "error", signal: AbortSignal.timeout(3000),
    headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" } });
  if (!tokenResponse.ok) throw new Error("The AWS machine identity is unavailable; automatic stop is suspended.");
  const token = (await tokenResponse.text()).trim();
  if (!token || token.length > 4096) throw new Error("The AWS machine identity token is invalid.");
  const response = await request(`${root}dynamic/instance-identity/document`, { redirect: "error", signal: AbortSignal.timeout(3000),
    headers: { "X-aws-ec2-metadata-token": token } });
  if (!response.ok) throw new Error("The AWS machine identity is unavailable; automatic stop is suspended.");
  const document = await response.json() as { instanceId?: unknown; region?: unknown };
  if (document.instanceId !== config.instanceId || document.region !== config.credentials.region) {
    throw new Error("The power configuration names a different AWS machine; automatic stop is suspended.");
  }
}
