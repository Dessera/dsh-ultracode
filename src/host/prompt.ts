/**
 * Injection text assembly.
 *
 * Every string this module produces is generated from plugin-owned constants.
 * No repository text, file content, or user input is interpolated into the
 * banner, so a workspace file cannot close the bracketed block or address the
 * model through this channel.
 *
 * Three kinds of text are built here: the banner that authorizes a workflow for
 * one turn, the level instruction a turn is injected with, and the one-off
 * notice that tells a session its orchestration authorization has been taken
 * away.
 *
 * @module @dessera/dsh-ultracode/prompt
 *
 * The phrasing of the banner and of the two level instructions is adapted from
 * `pi-dynamic-workflows` (<https://github.com/QuintinShaw/pi-dynamic-workflows>),
 * which is MIT licensed; its notice, including the original author's copyright,
 * is carried in the repository's `LICENSE`.
 */
import type { UltracodeLevel } from "./protocol.ts";

/**
 * Marker opening the banner block, kept stable for readers and tests.
 *
 * `buildBanner` emits a `---` separator line above the block, so the injected
 * text starts with that separator and this marker opens the bracketed part on
 * the line below it.
 *
 * The marker itself is the one `pi-dynamic-workflows` uses to open its armed
 * prompt block, and this plugin keeps it so that the two banners read the same
 * way to a model that has seen either one.
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

/**
 * Level instruction for the high level.
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
 * Level instruction for the ultra level.
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

/** Escape hatch every armed turn carries, so the banner never forces a workflow. */
const ESCAPE_SENTENCE = [
    "",
    "This turn was armed by standing ultracode mode, not by an explicit workflow request: if it",
    "is conversational or trivial, skip the workflow and just respond directly.",
].join("\n");

/**
 * Build the banner inserted ahead of the user's own message.
 * @returns the banner text.
 */
export function buildBanner(): string {
    return [
        "---",
        `${BANNER_OPEN} Decide first: if this message is a question, a trivial task, or`,
        "just talk (about workflows, this repo, or the tool itself), answer it directly and stay",
        "conversational — arming authorizes the tool, it does not force it. If it is a real,",
        "decomposable request to do work, handle it by calling the workflow tool: write a script",
        `that fans the task out across subagents via ${SCRIPT_SURFACE.join("/")}.`,
        "Why this turn is armed: standing ultracode mode armed this turn (you did not",
        `explicitly ask for a workflow).${BANNER_CLOSE}`,
    ].join("\n");
}

/**
 * Build the instruction for one armed level.
 *
 * Every armed turn carries the escape sentence, because the level arms turns
 * standing rather than per request: the user asked for the mode, not for a
 * workflow on this particular message.
 * @param level - the armed level, which must not be `off`.
 * @returns the instruction text, or the empty string for the `off` level.
 */
export function buildInstruction(level: UltracodeLevel): string {
    if (level === "off") return "";
    const body = level === "ultra" ? ULTRA_INSTRUCTION : HIGH_INSTRUCTION;
    return `${body}${ESCAPE_SENTENCE}`;
}

/**
 * Assemble the complete injected block for one armed turn.
 *
 * This is the block a session is told once per level: it is what defines what
 * `high` or `ultra` asks of a workflow run. Later turns of the same level carry
 * {@link buildReminder} instead.
 * @param level - the armed level.
 * @returns the banner followed by the level instruction.
 */
export function buildInjection(level: UltracodeLevel): string {
    return `${buildBanner()}\n\n${buildInstruction(level)}`;
}

/**
 * Build the one line a repeat armed turn carries instead of the full block.
 *
 * It states what a later turn still needs and nothing else: the level in effect,
 * so the block it belongs to is unambiguous; the fact that the authorization
 * still stands; and the escape hatch, which is why a trivial turn is still
 * answered directly. Everything the block explains is normally still in the
 * session's history, so repeating it every turn would buy nothing while being
 * paid for on every request. The line is written to stand on its own anyway,
 * because compaction can remove the block it belongs to and a reminder referring
 * to an instruction the model can no longer read would be worse than no reminder.
 * @param level - the armed level.
 * @returns the reminder, or the empty string for the `off` level.
 */
export function buildReminder(level: UltracodeLevel): string {
    if (level === "off") return "";
    return `---\n[workflows mode armed at ${level}; the workflow tool is authorized for real work, and a trivial turn is answered directly.]`;
}

/**
 * Build the notice a session carries on the turn after its level was turned
 * off, so the model does not keep reaching for a tool the session no longer
 * authorizes.
 *
 * It is written to be the only text that turn needs, the same way
 * {@link buildReminder} is: the turn that follows a level change may sit far
 * from the block that explained the mode, and compaction may have removed it.
 *
 * Unlike the banner and the two level instructions, this text does not open
 * with {@link BANNER_OPEN}: nothing is armed, and a model looking for the armed
 * marker would find it in a notice that arms nothing.
 * @returns the notice text.
 */
export function buildDisarmNotice(): string {
    return [
        "---",
        "[workflows mode off. The ultracode level was turned off before this",
        "message, so this turn does not authorize calling the workflow tool.",
        "Answer normally: do not start a workflow run, do not fan out across",
        "subagents, and do not treat the earlier standing instruction as still",
        "in force.]",
    ].join("\n");
}

/**
 * One line recording that a session was disarmed, for the message source.
 *
 * The fold reads a level out of a source summary by looking for a level word in
 * it, so this line deliberately names none at all. A summary containing `high`
 * or `ultra` would read as a banner arming that level, and even `off` is a word
 * the fold recognises — which would make an unreadable log fall back to `off`
 * instead of leaving the level it recovered alone.
 * @returns the one-line summary recorded on the message source.
 */
export function disarmSummary(): string {
    return "ultracode mode ended before this turn";
}

/**
 * One line recording which turn this block belongs to, so a transcript reader
 * can tell an armed turn from an unarmed one without re-deriving the level.
 *
 * The fold reads the level back out of this line, which is what carries a
 * session's level across a host restart when its log carries no level command.
 * @param level - the armed level.
 * @returns the one-line summary recorded on the message source.
 */
export function injectionSummary(level: UltracodeLevel): string {
    return `ultracode ${level} armed this turn`;
}
