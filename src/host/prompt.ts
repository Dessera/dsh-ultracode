/**
 * Injection text assembly.
 *
 * Every string this module produces is generated from plugin-owned constants
 * and one enumerated reason value. No repository text, file content, or user
 * input is interpolated into the banner, so a workspace file cannot close the
 * bracketed block or address the model through this channel.
 *
 * @module @dessera/dsh-ultracode/prompt
 */
import type { UltracodeLevel } from "./protocol.ts";
import type { ArmReason } from "./reducer.ts";

/**
 * Marker opening the banner block, kept stable for readers and tests.
 *
 * `buildBanner` emits a `---` separator line above the block, so the injected
 * text starts with that separator and this marker opens the bracketed part on
 * the line below it.
 */
export const BANNER_OPEN = "[workflows mode armed.";

/** Marker closing the banner block. */
export const BANNER_CLOSE = "]";

/**
 * The scripting surface the banner names. Every entry is a real parameter of
 * the workflow tool's script body. Names that DeepSeek Harness does not
 * provide — a verify hook, a judge panel, a loop-until-dry helper, an
 * agent-quota parameter — must never appear here, because a model that is told
 * to call a hook that does not exist spends a whole turn discovering that.
 */
export const SCRIPT_SURFACE: readonly string[] = [
    "agent()",
    "parallel()",
    "pipeline()",
];

/** Words that must never reach the injected text, because no such hook exists. */
export const FORBIDDEN_SCRIPT_NAMES: readonly string[] = [
    "verify(",
    "judgePanel(",
    "loopUntilDry(",
    "completenessCheck(",
    "maxAgents",
    "tokenBudget",
];

/** Why a turn was armed, spelled out as one clause. */
const REASON_CLAUSE: Readonly<Record<ArmReason, string>> = {
    keyword:
        "you typed the ultracode trigger word, which counts as your explicit opt-in to multi-agent orchestration",
    level: "standing ultracode mode armed this turn (you did not explicitly ask for a workflow)",
};

/**
 * Effort instruction for the high level.
 *
 * The adversarial pass is expressed as one more `agent()` call whose prompt
 * asks it to refute, because that is what the engine can actually do; the
 * severity vocabulary the pass returns is the model's own.
 */
const HIGH_INSTRUCTION = [
    "Effort: HIGH. Be thorough — use a few parallel reviewers or perspectives, then run an",
    "adversarial verify pass with a dedicated agent() call whose prompt asks it to refute each",
    "finding, and keep the severity levels it returns.",
].join("\n");

/**
 * Effort instruction for the ultra level.
 *
 * The loop-until-dry rule is written as an instruction to the author of the
 * script, who writes the termination condition in the script itself, and the
 * completeness step asks for an explicit statement of what the sweep could
 * have missed. The sentence about engine caps is there because the engine
 * limits how many agents a run may start while saying nothing about tokens, so
 * a sweep that ignores coverage ends as an unbounded fan-out.
 */
const ULTRA_INSTRUCTION = [
    "Effort: ULTRA. Be exhaustive — fan out widely across independent angles rather than a few",
    "reviewers; run deeper rounds that stop only after two consecutive rounds return no new",
    "findings; finish with a completeness check that names what the sweep could have missed.",
    "Give the synthesis stage the strongest model the agent() call can select.",
    "DeepSeek Harness's engine caps how many agents a run may start; it does not cap tokens, so",
    "scope the sweep deliberately and report the coverage limits you actually achieved.",
].join("\n");

/** Escape hatch appended only when the standing level, not the user, armed the turn. */
const ESCAPE_SENTENCE = [
    "",
    "This turn was armed by standing ultracode mode, not by an explicit workflow request: if it",
    "is conversational or trivial, skip the workflow and just respond directly.",
].join("\n");

/**
 * Build the banner inserted ahead of the user's own message.
 * @param reason - why the turn is armed.
 * @returns the banner text.
 */
export function buildBanner(reason: ArmReason): string {
    return [
        "---",
        `${BANNER_OPEN} Decide first: if this message is a question, a trivial task, or`,
        "just talk (about workflows, this repo, or the tool itself), answer it directly and stay",
        "conversational — arming authorizes the tool, it does not force it. If it is a real,",
        "decomposable request to do work, handle it by calling the workflow tool: write a script",
        `that fans the task out across subagents via ${SCRIPT_SURFACE.join("/")}.`,
        `Why this turn is armed: ${REASON_CLAUSE[reason]}.${BANNER_CLOSE}`,
    ].join("\n");
}

/**
 * Build the effort instruction for one armed level.
 *
 * The standing level path appends the escape sentence, because the user did
 * not ask for orchestration in so many words; the keyword path does not,
 * because the trigger word is the request.
 * @param level - the armed level, which must not be `off`.
 * @param reason - why the turn is armed.
 * @returns the instruction text, or the empty string for the `off` level.
 */
export function buildInstruction(
    level: UltracodeLevel,
    reason: ArmReason,
): string {
    if (level === "off") return "";
    const body = level === "ultra" ? ULTRA_INSTRUCTION : HIGH_INSTRUCTION;
    return reason === "level" ? `${body}${ESCAPE_SENTENCE}` : body;
}

/**
 * Assemble the complete injected block for one armed turn.
 * @param level - the armed level.
 * @param reason - why the turn is armed.
 * @returns the banner followed by the level instruction.
 */
export function buildInjection(
    level: UltracodeLevel,
    reason: ArmReason,
): string {
    return `${buildBanner(reason)}\n\n${buildInstruction(level, reason)}`;
}

/**
 * One line recording which turn this block belongs to, so a transcript reader
 * can tell an armed turn from an unarmed one without re-deriving the level.
 * @param level - the armed level.
 * @param reason - why the turn is armed.
 * @returns the one-line summary recorded on the message source.
 */
export function injectionSummary(
    level: UltracodeLevel,
    reason: ArmReason,
): string {
    return `ultracode ${level} armed this turn (${reason})`;
}
