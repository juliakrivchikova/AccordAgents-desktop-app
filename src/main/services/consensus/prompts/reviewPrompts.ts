import type { DebateRound, Finding, GitDiffResult, ParticipantConfig, ReviewRequest } from "../../../../shared/types";
import { limitText } from "../runs/reviewRecords";
import type { LinePoint } from "../types";

export function buildInitialPrompt(request: ReviewRequest, diff: GitDiffResult | undefined, warnings: string[]): string {
  const context = diff
    ? limitText(
        [
          `Diff title: ${diff.title}`,
          diff.repoPath ? `Repository: ${diff.repoPath}` : "",
          "Diff:",
          diff.diff || "(empty diff)"
        ]
          .filter(Boolean)
          .join("\n"),
        warnings
      )
    : "";

  return [
    "You are one independent participant in a consensus workflow.",
    "Return only compact point blocks. Do not add prose before or after.",
    "IMPORTANT: The output format is mandatory. Do not return JSON, Markdown, bullets, explanations, or any text outside the blocks.",
    "Points must be concise, practical, and directly useful to the user. Avoid broad background, generic advice, and over-explaining.",
    "Return all concrete, non-duplicate, actionable points. Do not create source/citation-only points.",
    "Format:",
    "P1|S:High|T:short title",
    "C:claim or recommendation",
    "E:evidence/reasoning",
    "A:action or fix guidance",
    "Severity S must be one of Critical, High, Medium, Low, Info.",
    request.kind === "code-review"
      ? "For code review, each point must be a concrete bug, risk, regression, or fix recommendation."
      : "For general questions, each point must be an actionable recommendation, caution, or directly useful conclusion.",
    request.question ? `User request:\n${request.question}` : "User request:\nReview the selected changes.",
    context
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildRepairPrompt(
  request: ReviewRequest,
  diff: GitDiffResult | undefined,
  participant: ParticipantConfig,
  content: string,
  warnings: string[]
): string {
  if (request.kind === "implementation-plan") {
    return [
      "Convert this participant answer into the compact implementation-plan item protocol.",
      "Return only plan-item blocks. Keep only concrete implementation steps, risks, unresolved blockers, and test guidance.",
      "IMPORTANT: The output format is mandatory. Do not return JSON, Markdown, bullets, explanations, or any text outside the blocks.",
      "Format:",
      "P1|S:Info|T:short implementation step title",
      "C:goal or decision for this step",
      "E:repo evidence, likely files/modules, dependencies, or reasoning",
      "A:concrete implementation guidance plus tests/verification",
      `Participant: ${participant.id} (${participant.label})`,
      request.question ? `User request:\n${request.question}` : "",
      `Repository: ${request.repoPath}`,
      `Raw answer:\n${content}`
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    "Convert this participant answer into the compact point protocol.",
    "Return only point blocks. Keep only actionable user-facing points. Remove source/citation-only and meta points.",
    "IMPORTANT: The output format is mandatory. Do not return JSON, Markdown, bullets, explanations, or any text outside the blocks.",
    "Points must be concise, practical, and directly useful to the user. Preserve only concrete claims and actions.",
    "Format:",
    "P1|S:Info|T:short title",
    "C:claim or recommendation",
    "E:evidence/reasoning",
    "A:action or fix guidance",
    `Participant: ${participant.id} (${participant.label})`,
    request.question ? `User request:\n${request.question}` : "",
    diff ? limitText(`Diff:\n${diff.diff || "(empty diff)"}`, warnings) : "",
    `Raw answer:\n${content}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildArbiterPrompt(
  request: ReviewRequest,
  diff: GitDiffResult | undefined,
  participants: ParticipantConfig[],
  pointsByParticipant: Map<string, LinePoint[]>,
  warnings: string[]
): string {
  return [
    "You are the arbiter. Merge participant point lists into canonical consensus points.",
    "Do not add new facts. Merge duplicates. Remove source/citation-only and meta points.",
    "Use participant ids exactly in SRC. A point can have multiple SRC ids if equivalent points appear in multiple answers.",
    "IMPORTANT: The output format is mandatory. If you return prose, JSON, Markdown, bullets, or any text outside the blocks, the result will be rejected.",
    "Canonical points must be concise, practical, and directly useful to the user. Prefer fewer, sharper points over broad or repetitive ones.",
    "Return only canonical blocks:",
    "K1|S:High|T:short title|SRC:codex-cli,claude-code",
    "C:canonical claim/recommendation",
    "E:shared evidence/reasoning",
    "A:user-facing action or fix guidance",
    `Mode: ${request.kind}`,
    `Participants: ${participants.map((participant) => `${participant.id}=${participant.label}`).join(", ")}`,
    request.question ? `User request:\n${request.question}` : "",
    diff ? limitText(`Diff summary/source:\n${diff.title}\n${diff.diff || "(empty diff)"}`, warnings) : "",
    `Participant points:\n${formatParticipantPoints(pointsByParticipant)}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildVerificationPrompt(
  request: ReviewRequest,
  finding: Finding,
  diff: GitDiffResult | undefined,
  warnings: string[]
): string {
  if (request.kind === "implementation-plan") {
    return [
      "You did not clearly include this implementation-plan item in your initial plan.",
      "Evaluate whether it should be included in the final approved plan. Return only:",
      "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
      "Be skeptical. Agree only if the item is practical, repo-appropriate, actionable, and compatible with the user decision-thread context.",
      "R|V:AGREE|S:Info",
      "E:short reason",
      "Use V:AGREE if the item should stand, V:REJECT if it is wrong/unhelpful, V:UNCLEAR if evidence is insufficient or a blocker remains.",
      formatFindingForPrompt(finding),
      request.question ? `User request:\n${request.question}` : "",
      `Repository: ${request.repoPath}`
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    "You missed or did not clearly include this point in your initial answer.",
    "Evaluate whether you agree with the point. Return only:",
    "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
    "Be skeptical. Do not agree just because another model proposed it; reject or mark unclear if the point is unsupported, overstated, impractical, or not actionable.",
    "R|V:AGREE|S:Info",
    "E:short reason",
    "Use V:AGREE if the point should stand, V:REJECT if it is wrong/unhelpful, V:UNCLEAR if evidence is insufficient.",
    formatFindingForPrompt(finding),
    request.question ? `User request:\n${request.question}` : "",
    diff ? limitText(`Diff:\n${diff.diff || "(empty diff)"}`, warnings) : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildSourceResponsePrompt(
  request: ReviewRequest,
  finding: Finding,
  dissentingRound: DebateRound,
  diff: GitDiffResult | undefined,
  warnings: string[]
): string {
  if (request.kind === "implementation-plan") {
    return [
      "You were a source for this implementation-plan item. Another participant challenged it.",
      "Return only:",
      "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
      "Be skeptical of your original item. Accept the challenge if the item is unsupported, impractical, wrong for this repo, or blocked by unresolved decisions.",
      "D|V:ACCEPT",
      "E:short reason",
      "Use V:ACCEPT if you accept/withdraw/narrow due to the challenge. Use V:REJECT if the original item should still stand. Use V:UNCLEAR if unresolved.",
      formatFindingForPrompt(finding),
      `Challenge from ${dissentingRound.participantLabel}: ${dissentingRound.content}`,
      request.question ? `User request:\n${request.question}` : "",
      `Repository: ${request.repoPath}`
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    "You were a source for this point. Another participant challenged it.",
    "Return only:",
    "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
    "Be skeptical of your own original point. Accept the challenge if the point is unsupported, overstated, impractical, or not actionable.",
    "D|V:ACCEPT",
    "E:short reason",
    "Use V:ACCEPT if you accept/withdraw/narrow due to the challenge. Use V:REJECT if the original point should still stand. Use V:UNCLEAR if unresolved.",
    formatFindingForPrompt(finding),
    `Challenge from ${dissentingRound.participantLabel}: ${dissentingRound.content}`,
    request.question ? `User request:\n${request.question}` : "",
    diff ? limitText(`Diff:\n${diff.diff || "(empty diff)"}`, warnings) : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildFinalResolutionPrompt(
  request: ReviewRequest,
  finding: Finding,
  sourceReason: string,
  diff: GitDiffResult | undefined,
  warnings: string[]
): string {
  if (request.kind === "implementation-plan") {
    return [
      "Resolve this implementation-plan thread after reading the original item and source rebuttal.",
      "Return only:",
      "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
      "Keep the item only if it remains well-supported, practical, actionable, and compatible with the user decision-thread context.",
      "F|V:AGREE|S:Info",
      "E:short final reason",
      "Use V:AGREE if the original item should stand; V:REJECT if it should be rejected; V:UNCLEAR if still unresolved.",
      formatFindingForPrompt(finding),
      `Source rebuttal: ${sourceReason}`,
      request.question ? `User request:\n${request.question}` : "",
      `Repository: ${request.repoPath}`
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    "Resolve this thread after reading the original point and source rebuttal.",
    "Return only:",
    "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
    "Be skeptical. Keep the point only if it remains well-supported, practical, and actionable after the rebuttal.",
    "F|V:AGREE|S:Info",
    "E:short final reason",
    "Use V:AGREE if the original point should stand; V:REJECT if it should be rejected; V:UNCLEAR if still unresolved.",
    formatFindingForPrompt(finding),
    `Source rebuttal: ${sourceReason}`,
    request.question ? `User request:\n${request.question}` : "",
    diff ? limitText(`Diff:\n${diff.diff || "(empty diff)"}`, warnings) : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function systemIntro(request: ReviewRequest, diff: GitDiffResult | undefined, arbiter: ParticipantConfig): string {
  const participantNames = request.participants.map((participant) => participant.label).join(", ");
  const arbiterRole = request.kind === "implementation-plan" ? "Planner" : "Arbiter";
  return [
    `Participants: ${participantNames || "none"}.`,
    `${arbiterRole}: ${arbiter.label}.`,
    `Round limit per point: ${request.roundLimit}.`,
    request.kind === "implementation-plan"
      ? `Implementation-plan repository: ${request.repoPath}.`
      : diff
        ? `Review source: ${diff.title}.`
        : "Free-form validation conversation."
  ].join("\n");
}

function formatParticipantPoints(pointsByParticipant: Map<string, LinePoint[]>): string {
  const lines: string[] = [];
  for (const [participantId, points] of pointsByParticipant.entries()) {
    lines.push(`## ${participantId}`);
    for (const [index, point] of points.entries()) {
      lines.push(`P${index + 1}|S:${point.severity}|T:${point.title}`);
      if (point.claim) {
        lines.push(`C:${point.claim}`);
      }
      if (point.evidence) {
        lines.push(`E:${point.evidence}`);
      }
      if (point.action) {
        lines.push(`A:${point.action}`);
      }
    }
  }
  return lines.join("\n");
}

function formatFindingForPrompt(finding: Finding): string {
  return [
    `POINT|S:${finding.severity}|T:${finding.title}`,
    finding.claim ? `C:${finding.claim}` : "",
    finding.evidence ? `E:${finding.evidence}` : "",
    finding.action ? `A:${finding.action}` : "",
    finding.sourceParticipantLabels?.length ? `Sources:${finding.sourceParticipantLabels.join(", ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}
