import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  Conversation,
  DebateRound,
  DebateStance,
  Finding,
  FindingSeverity,
  FindingStatus,
  GitDiffResult,
  ParticipantConfig,
  ReviewProgress,
  ReviewRequest,
  StartReviewResult
} from "../../shared/types";
import { CliAgentRunner } from "./cliAgents";
import { GitService } from "./git";
import { ParticipantRunResult, ProviderRunner } from "./providers";
import { StorageService } from "./storage";

const MAX_CONTEXT_CHARS = 90_000;
const MAX_POINTS = 8;
const MAX_VERIFIERS_PER_POINT = 2;
const SEVERITY_ORDER: FindingSeverity[] = ["Critical", "High", "Medium", "Low", "Info"];
type ProgressCallback = (progress: ReviewProgress) => void;

interface LinePoint {
  id: string;
  title: string;
  claim: string;
  evidence: string;
  action: string;
  severity: FindingSeverity;
  sourceParticipantIds: string[];
}

interface ParsedVerification {
  stance: "confirmed" | "rejected" | "unclear";
  severity?: FindingSeverity;
  reason: string;
}

interface ParsedSourceDecision {
  decision: "accept" | "reject" | "unclear";
  reason: string;
}

export class ConsensusService {
  constructor(
    private readonly git: GitService,
    private readonly storage: StorageService,
    private readonly providerRunner: ProviderRunner,
    private readonly cliRunner: CliAgentRunner
  ) {}

  async startReview(request: ReviewRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    const warnings: string[] = [];
    const runId = request.runId ?? randomUUID();
    const now = new Date().toISOString();
    const arbiter = request.arbiter ?? request.participants[0];
    const pendingProgressMessages: ChatMessage[] = [];
    let conversation: Conversation | undefined;
    const recordProgress: ProgressCallback = (event) => {
      const message = this.progressMessage(event);
      if (conversation) {
        conversation.messages.push(message);
      } else {
        pendingProgressMessages.push(message);
      }
      progress?.(event);
    };

    if (!arbiter) {
      throw new Error("Select an arbiter model.");
    }

    this.emitProgress(runId, recordProgress, "initial", "Preparing review context.");
    this.throwIfAborted(signal);
    const diff = await this.resolveDiff(request, warnings);
    const initialPrompt = this.buildInitialPrompt(request, diff, warnings);

    conversation = {
      id: randomUUID(),
      title: this.titleFor(request, diff),
      kind: request.kind,
      createdAt: now,
      updatedAt: now,
      repoPath: request.repoPath,
      messages: [
        this.message("user", request.question || "Review the selected changes."),
        ...pendingProgressMessages,
        this.message("system", this.systemIntro(request, diff, arbiter), this.asArbiterParticipant(arbiter))
      ],
      findings: [],
      metadata: {
        diffMode: request.diffMode,
        participantCount: request.participants.length,
        arbiter: { id: arbiter.id, kind: arbiter.kind, label: arbiter.label, model: arbiter.model },
        roundLimit: request.roundLimit
      }
    };

    const failedParticipantIds = new Set<string>();
    let completedInitial = 0;
    const initialResults = await Promise.all(
      request.participants.map(async (participant) => {
        this.emitProgress(runId, recordProgress, "initial", `Running independent answer from ${participant.label}.`, {
          participantLabel: participant.label,
          completed: completedInitial,
          total: request.participants.length
        });
        const result = await this.runParticipant(participant, initialPrompt, request, signal);
        completedInitial += 1;
        this.emitProgress(runId, recordProgress, "initial", `${participant.label} ${result.ok ? "finished" : "failed"} independent answer${this.formatDuration(result.durationMs)}.`, {
          participantLabel: participant.label,
          completed: completedInitial,
          total: request.participants.length
        });
        return result;
      })
    );
    this.throwIfAborted(signal);

    for (const result of initialResults) {
      conversation.messages.push(this.message("participant", result.content, result.participant, result.ok ? "done" : "error"));
      if (!result.ok && result.error) {
        failedParticipantIds.add(result.participant.id);
        warnings.push(`${result.participant.label}: ${result.error}. Skipping this participant for the rest of the run.`);
      }
    }

    const healthyParticipants = request.participants.filter((participant) => !failedParticipantIds.has(participant.id));
    const participantPoints = await this.collectParticipantPoints(
      request,
      arbiter,
      diff,
      initialResults,
      healthyParticipants,
      warnings,
      signal,
      recordProgress,
      runId
    );

    this.emitProgress(runId, recordProgress, "arbiter", `Arbiter ${arbiter.label} is merging points.`);
    const arbiterPrompt = this.buildArbiterPrompt(request, diff, healthyParticipants, participantPoints, warnings);
    const arbiterResult = await this.runParticipant(arbiter, arbiterPrompt, request, signal);
    conversation.messages.push(this.message("participant", arbiterResult.content, this.asArbiterParticipant(arbiter), arbiterResult.ok ? "done" : "error"));

    let canonicalPoints = arbiterResult.ok
      ? this.parseLineProtocol(arbiterResult.content, undefined, healthyParticipants)
      : [];
    if (!arbiterResult.ok) {
      warnings.push(`${arbiter.label} arbiter failed: ${arbiterResult.error ?? "unknown error"}. Falling back to local point merge.`);
    }
    if (canonicalPoints.length === 0) {
      canonicalPoints = this.localMergePoints(participantPoints);
      warnings.push("Arbiter did not return canonical points; used local line-protocol merge fallback.");
    }

    canonicalPoints = canonicalPoints
      .filter((point) => !this.isMetaPoint(point))
      .map((point) => this.withInferredSources(point, participantPoints, healthyParticipants));
    const untraceablePointCount = canonicalPoints.filter((point) => point.sourceParticipantIds.length === 0).length;
    if (untraceablePointCount > 0) {
      warnings.push(`${untraceablePointCount} arbiter point${untraceablePointCount === 1 ? "" : "s"} had no matching participant source and were filtered out.`);
    }
    canonicalPoints = canonicalPoints
      .filter((point) => point.sourceParticipantIds.length > 0)
      .slice(0, MAX_POINTS);
    if (canonicalPoints.length === 0) {
      warnings.push("No actionable points were extracted from the independent answers.");
    }

    this.emitProgress(runId, recordProgress, "debate", `Extracted ${canonicalPoints.length} canonical point${canonicalPoints.length === 1 ? "" : "s"}.`);
    this.emitProgress(runId, recordProgress, "debate", `Opening ${canonicalPoints.length} consensus threads.`, {
      completed: 0,
      total: canonicalPoints.length
    });

    for (let index = 0; index < canonicalPoints.length; index += 1) {
      this.throwIfAborted(signal);
      const point = canonicalPoints[index];
      const finding = this.createFinding(point, healthyParticipants);
      if (finding.status !== "Confirmed") {
        await this.debatePoint(finding, request, diff, warnings, signal, recordProgress, runId, index, canonicalPoints.length, failedParticipantIds);
      }
      conversation.findings.push(finding);
      this.emitProgress(runId, recordProgress, "debate", `Finished point ${index + 1} of ${canonicalPoints.length}.`, {
        findingTitle: finding.title,
        completed: index + 1,
        total: canonicalPoints.length
      });
    }

    this.emitProgress(runId, recordProgress, "summary", "Building final consensus summary.");
    conversation.finalSummary = this.finalSummary(conversation);
    conversation.messages.push(this.message("summary", conversation.finalSummary));
    this.emitProgress(runId, recordProgress, "done", "Consensus review finished.");
    conversation.updatedAt = new Date().toISOString();
    await this.storage.saveConversation(conversation);

    return { conversation, warnings };
  }

  private async collectParticipantPoints(
    request: ReviewRequest,
    arbiter: ParticipantConfig,
    diff: GitDiffResult | undefined,
    initialResults: ParticipantRunResult[],
    healthyParticipants: ParticipantConfig[],
    warnings: string[],
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    runId: string
  ): Promise<Map<string, LinePoint[]>> {
    const pointsByParticipant = new Map<string, LinePoint[]>();

    for (const result of initialResults) {
      if (!result.ok) {
        continue;
      }
      let points = this.parseLineProtocol(result.content, result.participant, healthyParticipants);
      if (points.length === 0) {
        this.emitProgress(runId, progress, "arbiter", `Arbiter ${arbiter.label} is repairing ${result.participant.label}'s answer.`);
        const repair = await this.runParticipant(
          arbiter,
          this.buildRepairPrompt(request, diff, result.participant, result.content, warnings),
          request,
          signal
        );
        if (repair.ok) {
          points = this.parseLineProtocol(repair.content, result.participant, healthyParticipants);
        } else {
          warnings.push(`${arbiter.label} could not repair ${result.participant.label}'s answer: ${repair.error ?? "unknown error"}.`);
        }
      }
      if (points.length === 0) {
        warnings.push(`${result.participant.label} produced no parseable points.`);
      }
      this.emitProgress(runId, progress, "extract", `Extracted ${points.length} point${points.length === 1 ? "" : "s"} from ${result.participant.label}.`, {
        participantLabel: result.participant.label
      });
      pointsByParticipant.set(result.participant.id, points);
    }

    return pointsByParticipant;
  }

  private async resolveDiff(request: ReviewRequest, warnings: string[]): Promise<GitDiffResult | undefined> {
    if (request.kind !== "code-review") {
      return undefined;
    }

    if (!request.diffMode) {
      warnings.push("No diff mode was selected.");
      return undefined;
    }

    const diff = await this.git.getDiff({
      repoPath: request.repoPath ?? "",
      mode: request.diffMode,
      baseBranch: request.baseBranch,
      compareBranch: request.compareBranch,
      commit: request.commit,
      pastedDiff: request.pastedDiff
    });

    if (!diff.diff.trim()) {
      warnings.push("The selected diff is empty.");
    }
    return diff;
  }

  private async runParticipant(
    participant: ParticipantConfig,
    prompt: string,
    request: ReviewRequest,
    signal?: AbortSignal
  ): Promise<ParticipantRunResult> {
    this.throwIfAborted(signal);
    if (participant.kind === "codex-cli" || participant.kind === "claude-code") {
      return this.cliRunner.run(participant, prompt, request.repoPath, request.diffMode, signal);
    }
    return this.providerRunner.run(participant, prompt, signal);
  }

  private async debatePoint(
    finding: Finding,
    request: ReviewRequest,
    diff: GitDiffResult | undefined,
    warnings: string[],
    signal: AbortSignal | undefined,
    progress: ProgressCallback | undefined,
    runId: string,
    pointIndex: number,
    totalPoints: number,
    failedParticipantIds: Set<string>
  ): Promise<void> {
    const missingParticipants = request.participants
      .filter((participant) => !failedParticipantIds.has(participant.id))
      .filter((participant) => finding.missingParticipantIds?.includes(participant.id))
      .slice(0, MAX_VERIFIERS_PER_POINT);
    const totalMissing = finding.missingParticipantIds?.length ?? 0;
    if (totalMissing > missingParticipants.length) {
      warnings.push(`Point "${finding.title}" was checked with ${MAX_VERIFIERS_PER_POINT} missing participants to keep the run bounded.`);
    }

    for (const participant of missingParticipants) {
      this.throwIfAborted(signal);
      this.emitProgress(runId, progress, "debate", `Asking ${participant.label} about point ${pointIndex + 1} of ${totalPoints}.`, {
        participantLabel: participant.label,
        findingTitle: finding.title,
        completed: pointIndex,
        total: totalPoints
      });
      const result = await this.runParticipant(participant, this.buildVerificationPrompt(request, finding, diff, warnings), request, signal);
      if (!result.ok) {
        failedParticipantIds.add(participant.id);
        warnings.push(`${participant.label}: ${result.error ?? "failed"}. Skipping this participant for the rest of the run.`);
      }
      const parsed = result.ok ? this.parseVerification(result.content) : { stance: "unclear" as const, reason: result.content };
      finding.rounds.push({
        id: randomUUID(),
        roundIndex: 1,
        participantId: participant.id,
        participantLabel: participant.label,
        stance: parsed.stance,
        severity: parsed.severity,
        content: parsed.reason,
        createdAt: new Date().toISOString()
      });
    }

    finding.status = this.statusFor(finding, request.participants.filter((participant) => !failedParticipantIds.has(participant.id)));

    const dissentingRound = finding.rounds.find((round) => round.roundIndex === 1 && round.stance !== "confirmed");
    if (request.roundLimit <= 1 || !dissentingRound) {
      return;
    }

    const source = request.participants.find((participant) => participant.id === finding.sourceParticipantId && !failedParticipantIds.has(participant.id));
    if (!source) {
      return;
    }

    this.emitProgress(runId, progress, "debate", `Asking ${source.label} to evaluate the counterargument.`);
    const sourceResult = await this.runParticipant(source, this.buildSourceResponsePrompt(request, finding, dissentingRound, diff, warnings), request, signal);
    if (!sourceResult.ok) {
      failedParticipantIds.add(source.id);
      warnings.push(`${source.label}: ${sourceResult.error ?? "failed"}. Skipping this participant for the rest of the run.`);
      return;
    }

    const sourceDecision = this.parseSourceDecision(sourceResult.content);
    finding.rounds.push({
      id: randomUUID(),
      roundIndex: 2,
      participantId: source.id,
      participantLabel: source.label,
      stance: "originator-rebuttal",
      severity: finding.severity,
      content: sourceDecision.reason,
      createdAt: new Date().toISOString()
    });

    if (sourceDecision.decision === "accept") {
      finding.status = "Rejected";
      return;
    }
    if (sourceDecision.decision !== "reject") {
      finding.status = "Unresolved";
      return;
    }

    const finalResolver = request.participants.find((participant) => participant.id === dissentingRound.participantId && !failedParticipantIds.has(participant.id));
    if (!finalResolver) {
      finding.status = "Unresolved";
      return;
    }

    this.emitProgress(runId, progress, "debate", `Asking ${finalResolver.label} for final resolution.`);
    const finalResult = await this.runParticipant(finalResolver, this.buildFinalResolutionPrompt(request, finding, sourceDecision.reason, diff, warnings), request, signal);
    const parsedFinal = finalResult.ok ? this.parseVerification(finalResult.content) : { stance: "unclear" as const, reason: finalResult.content };
    finding.rounds.push({
      id: randomUUID(),
      roundIndex: 3,
      participantId: finalResolver.id,
      participantLabel: finalResolver.label,
      stance: "final-resolution",
      severity: parsedFinal.severity,
      content: parsedFinal.reason,
      createdAt: new Date().toISOString()
    });
    finding.status = parsedFinal.stance === "confirmed" ? "Confirmed" : parsedFinal.stance === "rejected" ? "Rejected" : "Unresolved";
  }

  private buildInitialPrompt(request: ReviewRequest, diff: GitDiffResult | undefined, warnings: string[]): string {
    const context = diff
      ? this.limitText(
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
      "Use at most 6 points. Do not create source/citation-only points.",
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

  private buildRepairPrompt(
    request: ReviewRequest,
    diff: GitDiffResult | undefined,
    participant: ParticipantConfig,
    content: string,
    warnings: string[]
  ): string {
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
      diff ? this.limitText(`Diff:\n${diff.diff || "(empty diff)"}`, warnings) : "",
      `Raw answer:\n${content}`
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildArbiterPrompt(
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
      diff ? this.limitText(`Diff summary/source:\n${diff.title}\n${diff.diff || "(empty diff)"}`, warnings) : "",
      `Participant points:\n${this.formatParticipantPoints(pointsByParticipant)}`
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildVerificationPrompt(
    request: ReviewRequest,
    finding: Finding,
    diff: GitDiffResult | undefined,
    warnings: string[]
  ): string {
    return [
      "You missed or did not clearly include this point in your initial answer.",
      "Evaluate whether you agree with the point. Return only:",
      "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
      "Be skeptical. Do not agree just because another model proposed it; reject or mark unclear if the point is unsupported, overstated, impractical, or not actionable.",
      "R|V:AGREE|S:Info",
      "E:short reason",
      "Use V:AGREE if the point should stand, V:REJECT if it is wrong/unhelpful, V:UNCLEAR if evidence is insufficient.",
      this.formatFindingForPrompt(finding),
      request.question ? `User request:\n${request.question}` : "",
      diff ? this.limitText(`Diff:\n${diff.diff || "(empty diff)"}`, warnings) : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildSourceResponsePrompt(
    request: ReviewRequest,
    finding: Finding,
    dissentingRound: DebateRound,
    diff: GitDiffResult | undefined,
    warnings: string[]
  ): string {
    return [
      "You were a source for this point. Another participant challenged it.",
      "Return only:",
      "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
      "Be skeptical of your own original point. Accept the challenge if the point is unsupported, overstated, impractical, or not actionable.",
      "D|V:ACCEPT",
      "E:short reason",
      "Use V:ACCEPT if you accept/withdraw/narrow due to the challenge. Use V:REJECT if the original point should still stand. Use V:UNCLEAR if unresolved.",
      this.formatFindingForPrompt(finding),
      `Challenge from ${dissentingRound.participantLabel}: ${dissentingRound.content}`,
      request.question ? `User request:\n${request.question}` : "",
      diff ? this.limitText(`Diff:\n${diff.diff || "(empty diff)"}`, warnings) : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildFinalResolutionPrompt(
    request: ReviewRequest,
    finding: Finding,
    sourceReason: string,
    diff: GitDiffResult | undefined,
    warnings: string[]
  ): string {
    return [
      "Resolve this thread after reading the original point and source rebuttal.",
      "Return only:",
      "IMPORTANT: The output format is mandatory. Do not return prose, JSON, Markdown, or bullets.",
      "Be skeptical. Keep the point only if it remains well-supported, practical, and actionable after the rebuttal.",
      "F|V:AGREE|S:Info",
      "E:short final reason",
      "Use V:AGREE if the original point should stand; V:REJECT if it should be rejected; V:UNCLEAR if still unresolved.",
      this.formatFindingForPrompt(finding),
      `Source rebuttal: ${sourceReason}`,
      request.question ? `User request:\n${request.question}` : "",
      diff ? this.limitText(`Diff:\n${diff.diff || "(empty diff)"}`, warnings) : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private systemIntro(request: ReviewRequest, diff: GitDiffResult | undefined, arbiter: ParticipantConfig): string {
    const participantNames = request.participants.map((participant) => participant.label).join(", ");
    return [
      `Participants: ${participantNames || "none"}.`,
      `Arbiter: ${arbiter.label}.`,
      `Round limit per point: ${request.roundLimit}.`,
      diff ? `Review source: ${diff.title}.` : "Free-form validation conversation."
    ].join("\n");
  }

  private parseLineProtocol(content: string, participant: ParticipantConfig | undefined, knownParticipants: ParticipantConfig[]): LinePoint[] {
    const points: LinePoint[] = [];
    let current: Partial<LinePoint> | undefined;
    let currentField: "claim" | "evidence" | "action" | undefined;

    const push = () => {
      if (!current) {
        return;
      }
      const normalized = this.normalizeLinePoint(current, participant, knownParticipants);
      if (normalized && !this.isMetaPoint(normalized)) {
        points.push(normalized);
      }
    };

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const header = line.match(/^[PK]\d+\|/i) ? line : undefined;
      if (header) {
        push();
        current = this.parsePointHeader(header, participant, knownParticipants);
        currentField = undefined;
        continue;
      }
      if (!current) {
        continue;
      }
      const field = line.match(/^(C|E|A|T|S|SRC):\s*(.*)$/i);
      if (field) {
        const key = field[1].toUpperCase();
        const value = field[2].trim();
        if (key === "C") {
          current.claim = value;
          currentField = "claim";
        } else if (key === "E") {
          current.evidence = value;
          currentField = "evidence";
        } else if (key === "A") {
          current.action = value;
          currentField = "action";
        } else if (key === "T") {
          current.title = value;
          currentField = undefined;
        } else if (key === "S") {
          current.severity = this.asSeverity(value) ?? current.severity;
          currentField = undefined;
        } else if (key === "SRC") {
          current.sourceParticipantIds = this.resolveParticipantIds(value, knownParticipants);
          currentField = undefined;
        }
      } else if (currentField) {
        current[currentField] = [current[currentField], line].filter(Boolean).join(" ");
      }
    }
    push();
    return points;
  }

  private parsePointHeader(header: string, participant: ParticipantConfig | undefined, knownParticipants: ParticipantConfig[]): Partial<LinePoint> {
    const [prefix, ...parts] = header.split("|");
    const point: Partial<LinePoint> = {
      id: prefix.trim(),
      sourceParticipantIds: participant ? [participant.id] : []
    };
    for (const part of parts) {
      const [rawKey, ...rawValue] = part.split(":");
      const key = rawKey.trim().toUpperCase();
      const value = rawValue.join(":").trim();
      if (key === "S") {
        point.severity = this.asSeverity(value);
      } else if (key === "T") {
        point.title = value;
      } else if (key === "SRC") {
        point.sourceParticipantIds = this.resolveParticipantIds(value, knownParticipants);
      }
    }
    return point;
  }

  private normalizeLinePoint(point: Partial<LinePoint>, participant: ParticipantConfig | undefined, knownParticipants: ParticipantConfig[]): LinePoint | undefined {
    const sourceParticipantIds = point.sourceParticipantIds?.length
      ? Array.from(new Set(point.sourceParticipantIds))
      : participant
        ? [participant.id]
        : [];
    const claim = (point.claim ?? "").trim();
    const action = (point.action ?? "").trim();
    const title = (point.title || claim || action).trim().slice(0, 160);
    if (!title || (!claim && !action)) {
      return undefined;
    }
    return {
      id: point.id || `P${randomUUID().slice(0, 8)}`,
      title,
      claim,
      evidence: (point.evidence ?? "").trim(),
      action,
      severity: point.severity ?? (participant ? this.severityFromText(`${title} ${claim} ${action}`) : "Info"),
      sourceParticipantIds: sourceParticipantIds.filter((id) => knownParticipants.some((known) => known.id === id))
    };
  }

  private resolveParticipantIds(value: string, participants: ParticipantConfig[]): string[] {
    const tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
    const resolved: string[] = [];
    for (const token of tokens) {
      const normalized = this.normalizeId(token);
      const match = participants.find((participant) => participant.id === token || this.normalizeId(participant.label) === normalized || this.normalizeId(participant.id) === normalized);
      if (match) {
        resolved.push(match.id);
      }
    }
    return Array.from(new Set(resolved));
  }

  private localMergePoints(pointsByParticipant: Map<string, LinePoint[]>): LinePoint[] {
    const merged = new Map<string, LinePoint>();
    for (const points of pointsByParticipant.values()) {
      for (const point of points) {
        const key = this.pointKey(point);
        const existing = merged.get(key);
        if (existing) {
          existing.sourceParticipantIds = Array.from(new Set([...existing.sourceParticipantIds, ...point.sourceParticipantIds]));
          existing.evidence = existing.evidence || point.evidence;
          existing.action = existing.action || point.action;
        } else {
          merged.set(key, { ...point, sourceParticipantIds: [...point.sourceParticipantIds] });
        }
      }
    }
    return Array.from(merged.values());
  }

  private withInferredSources(
    point: LinePoint,
    pointsByParticipant: Map<string, LinePoint[]>,
    participants: ParticipantConfig[]
  ): LinePoint {
    const participantIds = new Set(participants.map((participant) => participant.id));
    const sourceParticipantIds = new Set(point.sourceParticipantIds.filter((id) => participantIds.has(id)));

    for (const [participantId, points] of pointsByParticipant.entries()) {
      if (!participantIds.has(participantId) || sourceParticipantIds.has(participantId)) {
        continue;
      }
      if (points.some((candidate) => this.pointsLikelyMatch(point, candidate))) {
        sourceParticipantIds.add(participantId);
      }
    }

    return { ...point, sourceParticipantIds: Array.from(sourceParticipantIds) };
  }

  private createFinding(point: LinePoint, healthyParticipants: ParticipantConfig[]): Finding {
    const includedParticipantIds = point.sourceParticipantIds.filter((id) => healthyParticipants.some((participant) => participant.id === id));
    const missingParticipantIds = healthyParticipants.map((participant) => participant.id).filter((id) => !includedParticipantIds.includes(id));
    const sourceParticipantId = includedParticipantIds[0] ?? healthyParticipants[0]?.id ?? "unknown";
    const sourceParticipantLabel = healthyParticipants.find((participant) => participant.id === sourceParticipantId)?.label ?? sourceParticipantId;
    const sourceParticipantLabels = includedParticipantIds.map((id) => healthyParticipants.find((participant) => participant.id === id)?.label ?? id);

    return {
      id: randomUUID(),
      title: point.title,
      description: point.claim || point.action || point.title,
      sourceParticipantId,
      sourceParticipantLabel,
      sourceParticipantIds: includedParticipantIds,
      sourceParticipantLabels,
      includedParticipantIds,
      missingParticipantIds,
      claim: point.claim,
      evidence: point.evidence,
      action: point.action,
      severity: point.severity,
      status: missingParticipantIds.length === 0 && includedParticipantIds.length > 0 ? "Confirmed" : "Unresolved",
      rounds: [],
      createdAt: new Date().toISOString()
    };
  }

  private parseVerification(content: string): ParsedVerification {
    const value = content.match(/\bV:\s*(AGREE|REJECT|UNCLEAR)\b/i)?.[1]?.toUpperCase();
    const severityText = content.match(/\bS:\s*(Critical|High|Medium|Low|Info)\b/i)?.[1];
    const reason = content.match(/\bE:\s*([\s\S]*)/i)?.[1]?.trim() || content.trim();
    return {
      stance: value === "AGREE" ? "confirmed" : value === "REJECT" ? "rejected" : "unclear",
      severity: this.asSeverity(severityText),
      reason
    };
  }

  private parseSourceDecision(content: string): ParsedSourceDecision {
    const value = content.match(/\bV:\s*(ACCEPT|REJECT|UNCLEAR)\b/i)?.[1]?.toUpperCase();
    const reason = content.match(/\bE:\s*([\s\S]*)/i)?.[1]?.trim() || content.trim();
    return {
      decision: value === "ACCEPT" ? "accept" : value === "REJECT" ? "reject" : "unclear",
      reason
    };
  }

  private statusFor(finding: Finding, healthyParticipants: ParticipantConfig[]): FindingStatus {
    const finalRound = finding.rounds.find((round) => round.stance === "final-resolution");
    if (finalRound) {
      const parsed = this.parseVerification(finalRound.content);
      return parsed.stance === "confirmed" ? "Confirmed" : parsed.stance === "rejected" ? "Rejected" : "Unresolved";
    }

    const supportIds = new Set(finding.includedParticipantIds ?? [finding.sourceParticipantId]);
    const rejectIds = new Set<string>();
    let hasUnclear = false;
    for (const round of finding.rounds) {
      if (round.stance === "confirmed") {
        supportIds.add(round.participantId);
      } else if (round.stance === "rejected") {
        rejectIds.add(round.participantId);
      } else if (round.stance === "unclear") {
        hasUnclear = true;
      }
    }

    if (healthyParticipants.length > 0 && healthyParticipants.every((participant) => supportIds.has(participant.id))) {
      return "Confirmed";
    }
    if (rejectIds.size > 0 && rejectIds.size >= supportIds.size) {
      return "Rejected";
    }
    return hasUnclear || rejectIds.size > 0 ? "Unresolved" : "Unresolved";
  }

  private finalSummary(conversation: Conversation): string {
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

  private formatParticipantPoints(pointsByParticipant: Map<string, LinePoint[]>): string {
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

  private formatFindingForPrompt(finding: Finding): string {
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

  private asArbiterParticipant(arbiter: ParticipantConfig): ParticipantConfig {
    return { ...arbiter, id: `arbiter:${arbiter.id}`, label: `${arbiter.label} (arbiter)` };
  }

  private isMetaPoint(point: LinePoint): boolean {
    const text = `${point.title} ${point.claim} ${point.action}`.toLowerCase();
    if (/^(sources?|references?|источники|ссылки)\b/i.test(point.title.trim())) {
      return true;
    }
    return !point.claim && !point.action || /\b(niddk|mayo clinic|source|reference|источник)\b/i.test(text) && point.action.length < 20 && point.claim.length < 40;
  }

  private pointKey(point: LinePoint): string {
    return this.normalizeId(`${point.title} ${point.claim || point.action}`).split(/\s+/).slice(0, 14).join(" ");
  }

  private pointsLikelyMatch(left: LinePoint, right: LinePoint): boolean {
    const leftKey = this.pointKey(left);
    const rightKey = this.pointKey(right);
    if (leftKey && rightKey && leftKey === rightKey) {
      return true;
    }

    const leftTokens = this.pointTokens(left);
    const rightTokens = this.pointTokens(right);
    if (leftTokens.size === 0 || rightTokens.size === 0) {
      return false;
    }

    const common = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
    const smaller = Math.min(leftTokens.size, rightTokens.size);
    return common >= 3 && common / smaller >= 0.5;
  }

  private pointTokens(point: LinePoint): Set<string> {
    return new Set(
      this.normalizeId(`${point.title} ${point.claim} ${point.evidence} ${point.action}`)
        .split(/\s+/)
        .filter((token) => token.length > 2)
    );
  }

  private normalizeId(value: string): string {
    return value
      .toLowerCase()
      .replace(/`[^`]+`/g, "")
      .replace(/[^a-zа-яё0-9\s-]/gi, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !["critical", "high", "medium", "low", "info", "severity"].includes(word))
      .join(" ");
  }

  private severityFromText(text: string): FindingSeverity {
    return this.asSeverity(text.match(/\b(Critical|High|Medium|Low|Info)\b/i)?.[1]) ?? "Medium";
  }

  private asSeverity(value: string | undefined): FindingSeverity | undefined {
    if (!value) {
      return undefined;
    }
    const normalized = value.toLowerCase();
    return SEVERITY_ORDER.find((severity) => severity.toLowerCase() === normalized);
  }

  private limitText(text: string, warnings: string[]): string {
    if (text.length <= MAX_CONTEXT_CHARS) {
      return text;
    }
    warnings.push(`Context was truncated to ${MAX_CONTEXT_CHARS.toLocaleString()} characters.`);
    return `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[Context truncated]`;
  }

  private titleFor(request: ReviewRequest, diff: GitDiffResult | undefined): string {
    if (request.question.trim()) {
      return request.question.trim().slice(0, 80);
    }
    return diff?.title ?? "Consensus conversation";
  }

  private message(
    role: ChatMessage["role"],
    content: string,
    participant?: ParticipantConfig,
    status: ChatMessage["status"] = "done"
  ): ChatMessage {
    return {
      id: randomUUID(),
      role,
      participantId: participant?.id,
      participantLabel: participant?.label,
      content,
      createdAt: new Date().toISOString(),
      status
    };
  }

  private progressMessage(progress: ReviewProgress): ChatMessage {
    return {
      id: randomUUID(),
      role: "system",
      participantId: "arbiter",
      participantLabel: "Arbiter",
      content: progress.message,
      createdAt: progress.createdAt,
      status: progress.phase === "error" || progress.phase === "cancelled" ? "error" : "done",
      progressPhase: progress.phase
    };
  }

  private emitProgress(
    runId: string,
    progress: ProgressCallback | undefined,
    phase: ReviewProgress["phase"],
    message: string,
    details: Partial<Omit<ReviewProgress, "runId" | "phase" | "message" | "createdAt">> = {}
  ): void {
    progress?.({
      runId,
      phase,
      message,
      createdAt: new Date().toISOString(),
      ...details
    });
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new Error("Review cancelled.");
    }
  }

  private formatDuration(durationMs: number | undefined): string {
    if (durationMs === undefined) {
      return "";
    }
    return ` in ${(durationMs / 1000).toFixed(1)}s`;
  }
}
