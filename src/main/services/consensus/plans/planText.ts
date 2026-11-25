import type { Conversation, FindingStatus } from "../../../../shared/types";
import { SEVERITY_ORDER } from "../constants";
import { planItemReviewForFinding, planItemReviewsFromMetadata } from "./planMetadata";
import type { ImplementationPlanSynthesis } from "./types";

export function finalSummary(conversation: Conversation): string {
  if (conversation.kind === "implementation-plan") {
    return finalImplementationPlanSummary(conversation);
  }

  if (conversation.findings.length === 0) {
    return conversation.kind === "code-review"
      ? "No concrete review findings were confirmed."
      : "No actionable consensus points were extracted.";
  }

  const title = conversation.kind === "code-review" ? "Final review consensus" : "Final answer consensus";
  const lines: string[] = [title];
  for (const status of ["Confirmed", "Unresolved", "Rejected"] as FindingStatus[]) {
    const group = conversation.findings.filter((finding) => finding.status === status);
    if (group.length === 0) {
      continue;
    }
    lines.push(`\n${status}`);
    for (const severity of SEVERITY_ORDER) {
      for (const finding of group.filter((item) => item.severity === severity)) {
        const text = finding.action || finding.claim || finding.description || finding.title;
        lines.push(`- [${severity}] ${text}`);
      }
    }
  }
  return lines.join("\n");
}

function finalImplementationPlanSummary(conversation: Conversation): string {
  const approved = conversation.findings.filter((finding) => finding.status === "Confirmed");
  const unresolved = conversation.findings.filter((finding) => finding.status === "Unresolved");
  const rejected = conversation.findings.filter((finding) => finding.status === "Rejected");
  const reviews = planItemReviewsFromMetadata(conversation);
  if (conversation.findings.length === 0) {
    return "No implementation-plan items were approved by all healthy participants.";
  }

  const lines: string[] = approved.length > 0 ? ["Approved implementation plan"] : ["No implementation-plan items were approved by all healthy participants."];
  for (const [index, finding] of approved.entries()) {
    const action = finding.action || finding.claim || finding.description || finding.title;
    lines.push(`${index + 1}. ${finding.title}`);
    lines.push(`   ${action}`);
    if (finding.evidence) {
      lines.push(`   Context: ${finding.evidence}`);
    }
    const review = planItemReviewForFinding(finding, reviews);
    if (review?.status === "commented" && review.comment?.trim()) {
      lines.push(`   User guidance: ${review.comment.trim()}`);
    }
  }
  if (unresolved.length > 0) {
    lines.push("\nUnresolved differences");
    for (const finding of unresolved) {
      lines.push(`- ${finding.title}: ${finding.action || finding.claim || finding.description}`);
    }
  }
  if (rejected.length > 0) {
    lines.push("\nRejected differences");
    for (const finding of rejected) {
      lines.push(`- ${finding.title}: ${finding.action || finding.claim || finding.description}`);
    }
  }
  return lines.join("\n");
}

export function parseImplementationPlanSynthesis(content: string, conversation: Conversation): ImplementationPlanSynthesis {
  const fallback = fallbackImplementationPlanSynthesis(conversation);
  const legacyFullPlan = markdownSection(content, "Full Plan");
  const fullPlan = legacyFullPlan || removeMarkdownSection(content, "Debate Summary");
  if (!fullPlan.trim()) {
    return fallback;
  }
  const debateSummary = markdownSection(content, "Debate Summary") || fallback.debateSummary;
  return implementationPlanSynthesis(fullPlan, debateSummary, "arbiter");
}

export function fallbackImplementationPlanSynthesis(conversation: Conversation): ImplementationPlanSynthesis {
  return implementationPlanSynthesis(
    finalImplementationPlanSummary(conversation),
    localImplementationPlanDebateSummary(conversation),
    "fallback"
  );
}

export function implementationPlanSynthesis(fullPlan: string, debateSummary: string, source: ImplementationPlanSynthesis["source"]): ImplementationPlanSynthesis {
  const cleanFullPlan = fullPlan.trim();
  const cleanDebateSummary = debateSummary.trim();
  return {
    fullPlan: cleanFullPlan,
    debateSummary: cleanDebateSummary,
    combined: [cleanFullPlan, cleanDebateSummary ? `## Debate Summary\n${cleanDebateSummary}` : ""].filter(Boolean).join("\n\n"),
    source
  };
}

export function markdownSection(content: string, title: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const normalizedTitle = title.trim().toLowerCase();
  let start = -1;
  for (const [index, line] of lines.entries()) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading?.[1].trim().toLowerCase() === normalizedTitle) {
      start = index;
      break;
    }
  }
  if (start < 0) {
    return "";
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,3}\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

export function removeMarkdownSection(content: string, title: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const normalizedTitle = title.trim().toLowerCase();
  let start = -1;
  for (const [index, line] of lines.entries()) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading?.[1].trim().toLowerCase() === normalizedTitle) {
      start = index;
      break;
    }
  }
  if (start < 0) {
    return content.trim();
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,3}\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
}

export function localImplementationPlanDebateSummary(conversation: Conversation): string {
  const debated = conversation.findings.filter((finding) => finding.rounds.length > 0 || finding.status !== "Confirmed");
  if (debated.length === 0) {
    return "All approved items were common across the healthy members; no non-common plan items required debate.";
  }

  const lines: string[] = [];
  for (const finding of debated) {
    const latestRound = finding.rounds.at(-1);
    const outcome = finding.status.toLowerCase();
    const reason = latestRound?.content || finding.action || finding.claim || finding.description;
    lines.push(`- ${finding.title}: ${outcome}. ${reason}`);
  }
  return lines.join("\n");
}
