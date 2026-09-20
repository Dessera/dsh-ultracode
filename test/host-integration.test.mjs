/**
 * Integration test for the host half.
 *
 * It drives the built plugin through a stubbed host context: the pre-step
 * waterfall and a command invocation. That covers the wiring of every channel
 * the plugin owns — which nothing else can check without booting a real host —
 * while leaving the full acceptance walkthrough to the real GUI.
 *
 * Every test here that needs a harness installation skips itself when none is
 * reachable, so the file never fails a checkout that has only this plugin.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
    ULTRACODE_KEY,
    ULTRACODE_STATE_VERSION,
} from "../src/host/protocol.ts";
import { findPackage, loadHostBundle, root } from "./support/host-loader.mjs";

const bundlePath = join(root, "lib/index.js");
const available =
    existsSync(bundlePath) && findPackage("@deepseek-ai/dsh-llm") !== undefined;

/** Build one user-role message as the pre-step batch carries it. */
function humanMessage(text) {
    return {
        id: `m-${Math.random().toString(36).slice(2)}`,
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "user" },
    };
}

/** Build a plugin-sourced message, as a synthetic context injection arrives. */
function syntheticMessage(text) {
    return {
        id: `m-${Math.random().toString(36).slice(2)}`,
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "fixture" },
    };
}

/** Build the tool result that opens a later step of the same turn. */
function toolResultMessage() {
    return {
        id: `m-${Math.random().toString(36).slice(2)}`,
        role: "user",
        content: [
            {
                type: "tool-result",
                toolCallId: "call-1",
                content: [{ type: "text", text: "ok" }],
                isError: false,
            },
        ],
        source: { kind: "tool", callId: "call-1" },
    };
}

/** Build a goal-round message, which is what an automatic continuation carries. */
function goalMessage(text) {
    return {
        id: `m-${Math.random().toString(36).slice(2)}`,
        role: "user",
        content: [{ type: "text", text }],
        source: {
            kind: "goal",
            goalId: "goal-1",
            revision: 1,
            round: 1,
        },
    };
}

/** A host context stub that records registrations and exposes one live agent. */
function makeContext(options = {}) {
    const listeners = new Map();
    const commands = [];
    /**
     * The projection units the plugin registered, keyed as the real registry keys
     * them. Answering `stateOf` from this map rather than from the last
     * registration is what makes a key mismatch a miss: the plugin registering one
     * key and reading another must not see a folded value, because the browser
     * would not see one either.
     */
    const projectors = new Map();
    /** The keys the plugin asked the registry to fold, in call order. */
    const queriedKeys = [];
    const session = {
        id: "sess-1",
        header: options.header ?? {},
    };
    const agent = { session };
    /** The unit registered last, which is the only one this fixture serves. */
    const lastUnit = () => [...projectors.values()].at(-1);
    /**
     * Fold one log event through the registered unit, as the real registry does.
     * @param event - the session event to fold.
     */
    const feedFolded = (event) => {
        const unit = lastUnit();
        if (unit === undefined)
            throw new Error("no projection unit was registered");
        unit.state =
            unit.state === undefined
                ? unit.definition.apply(
                      unit.definition.init({ id: session.id }, 0),
                      event,
                  )
                : unit.definition.apply(unit.state, event);
    };
    return {
        listeners,
        commands,
        agent,
        feedFolded,
        projectorCount: () => projectors.size,
        /** The definition the plugin registered, for contract assertions. */
        projection: () => lastUnit()?.definition,
        /** The keys the plugin read the fold under, in call order. */
        queriedKeys: () => [...queriedKeys],
        /** The state the registered unit currently folds, for assertions. */
        foldedState: () => lastUnit()?.state,
        ctx: {
            reflect: {
                get(key) {
                    if (key === "tools")
                        return (
                            options.tools ?? {
                                get: () => ({ name: "workflow" }),
                            }
                        );
                    if (key === "commands") {
                        return {
                            register(definition) {
                                commands.push(definition);
                                return () => {};
                            },
                        };
                    }
                    if (key === "sessionProjections") {
                        if (options.projections === false) return undefined;
                        return {
                            register(definition) {
                                projectors.set(definition.key, {
                                    definition,
                                    state: undefined,
                                });
                                return () => {
                                    projectors.delete(definition.key);
                                };
                            },
                            stateOf(_session, key) {
                                queriedKeys.push(key);
                                const unit = projectors.get(key);
                                if (
                                    unit === undefined ||
                                    unit.state === undefined
                                )
                                    return undefined;
                                // The real registry parses the view before handing it out.
                                return {
                                    wire: unit.definition.wire.viewSchema.parse(
                                        unit.definition.wire.view(unit.state),
                                    ),
                                };
                            },
                        };
                    }
                    return undefined;
                },
            },
            on(event, listener) {
                listeners.set(event, listener);
                return () => listeners.delete(event);
            },
            logger: { warn: () => {} },
        },
    };
}

/**
 * Set one session's level through the command channel, which is the only writer.
 *
 * The composer control writes the same way, so this helper is what a press of the
 * control amounts to on the host side.
 * @param harness - the context stub the plugin was applied to.
 * @param level - the level word to pass to the command.
 */
function setLevel(harness, level) {
    const result = harness.commands[0].handler({
        agent: harness.agent,
        rawInput: ` ${level}`,
    });
    assert.equal(result.kind, "success", `setting ${level} must succeed`);
}

test("a bundle that regains a bare import is refused with the specifier named", async () => {
    const staging = mkdtempSync(join(tmpdir(), "dsh-ultracode-bare-import-"));
    try {
        const staged = join(staging, "not-self-contained.mjs");
        writeFileSync(
            staged,
            'import { z } from "@deepseek-ai/dsh-llm";\nexport const zed = z;\n',
            "utf8",
        );
        await assert.rejects(
            loadHostBundle(staged),
            /imports "@deepseek-ai\/dsh-llm" by name/,
            "a bare import would load a copy of the harness the profile does not run, so the loader must name it",
        );
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
});

test(
    "the host half mounts its listener and its command",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        const dispose = module.apply(harness.ctx, {});
        assert.equal(module.name, "dsh-ultracode");
        assert.deepEqual(module.inject, ["tools", "commands"]);
        assert.ok(
            harness.listeners.has("agent/pre-step"),
            "the pre-step listener must be mounted",
        );
        assert.equal(harness.commands.length, 1);
        assert.equal(harness.commands[0].name, "ultracode");
        assert.equal(typeof dispose, "function");
        dispose();
        assert.equal(
            harness.listeners.size,
            0,
            "the disposer must release the listener",
        );
    },
);

test(
    "an armed level injects one banner after the message that opens the turn",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const preStep = harness.listeners.get("agent/pre-step");

        // Select the ultra level through the command, which is what the control does.
        setLevel(harness, "ultra");

        const synthetic = syntheticMessage("AGENTS.md contents follow");
        const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
        const decision = await preStep(
            {
                agent: harness.agent,
                messages: [synthetic, human],
                turn: 1,
                step: 1,
            },
            async () => ({ kind: "enter", messages: [synthetic, human] }),
        );
        assert.equal(decision.messages.length, 3);
        assert.equal(
            decision.messages[1].id,
            human.id,
            "the banner goes directly after the opening message",
        );
        const banner = decision.messages[2];
        assert.equal(banner.source.kind, "plugin");
        assert.equal(banner.source.plugin, "dsh-ultracode");
        assert.ok(banner.content[0].text.includes("Effort: ULTRA"));
        assert.ok(banner.content[0].text.includes("standing ultracode mode"));

        // A later step of the same turn must not stack a second banner. Its batch
        // holds only this turn's own tool result, which is not an opening at all.
        const toolResult = toolResultMessage();
        const again = await preStep(
            { agent: harness.agent, messages: [toolResult], turn: 1, step: 2 },
            async () => ({ kind: "enter", messages: [toolResult] }),
        );
        assert.equal(again.messages.length, 1);
    },
);

test(
    "a turn with no opening message is never injected",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        setLevel(harness, "high");
        const preStep = harness.listeners.get("agent/pre-step");
        const toolResult = toolResultMessage();
        const decision = await preStep(
            { agent: harness.agent, messages: [toolResult], turn: 1, step: 3 },
            async () => ({ kind: "enter", messages: [toolResult] }),
        );
        assert.equal(
            decision.messages.length,
            1,
            "a batch of tool results alone opens no turn",
        );
    },
);

test(
    "every turn is injected, however short its message is",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        setLevel(harness, "high");
        const preStep = harness.listeners.get("agent/pre-step");

        // The three shapes that used to be refused: a bare continuation, a short
        // question, and a greeting.
        for (const [index, text] of ["继续", "这样对吗？", "你好"].entries()) {
            const human = humanMessage(text);
            const turn = index + 1;
            const decision = await preStep(
                { agent: harness.agent, messages: [human], turn, step: 1 },
                async () => ({ kind: "enter", messages: [human] }),
            );
            assert.equal(
                decision.messages.length,
                2,
                `"${text}" must be injected while the level is armed`,
            );
            assert.equal(decision.messages[1].source.plugin, "dsh-ultracode");
        }
    },
);

test(
    "a goal continuation round is injected like any other turn",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        setLevel(harness, "ultra");
        const preStep = harness.listeners.get("agent/pre-step");

        const round = goalMessage("<goal_round>Objective: finish the sweep");
        const decision = await preStep(
            { agent: harness.agent, messages: [round], turn: 2, step: 1 },
            async () => ({ kind: "enter", messages: [round] }),
        );
        assert.equal(
            decision.messages.length,
            2,
            "an automatic continuation round must carry the banner",
        );
        assert.equal(decision.messages[1].source.plugin, "dsh-ultracode");
    },
);

test(
    "re-arming after off states the block again",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const preStep = harness.listeners.get("agent/pre-step");

        const bannerFor = async (text, turn) => {
            const human = humanMessage(text);
            const decision = await preStep(
                { agent: harness.agent, messages: [human], turn, step: 1 },
                async () => ({ kind: "enter", messages: [human] }),
            );
            return decision.messages.length === 2
                ? decision.messages[1].content[0].text
                : "";
        };

        setLevel(harness, "high");
        assert.ok((await bannerFor("第一轮", 1)).includes("Effort: HIGH"));
        assert.ok(!(await bannerFor("第二轮", 2)).includes("Effort: HIGH"));

        // Turning the level off and on again must not leave the session on the
        // reminder: the block is stated once more, because compaction may have
        // removed the earlier one while the level was off. The turn in between is
        // the one that reports the mode ending, and it must not authorize anything.
        setLevel(harness, "off");
        const dark = await bannerFor("关档期间的这一轮", 3);
        assert.ok(
            dark.includes("workflows mode off"),
            `the turn after a disarm must say so: ${dark}`,
        );
        assert.ok(
            !dark.includes("Effort: HIGH") && !dark.includes("Effort: ULTRA"),
            "the notice must not carry a level instruction",
        );
        setLevel(harness, "high");
        assert.ok(
            (await bannerFor("重新开启后的这一轮", 4)).includes("Effort: HIGH"),
            "re-arming after off must state the block again",
        );
    },
);

test(
    "the turn after a disarm carries one notice and later turns carry none",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        setLevel(harness, "ultra");
        setLevel(harness, "off");
        const preStep = harness.listeners.get("agent/pre-step");

        const turnWith = async (text, turn) => {
            const human = humanMessage(text);
            return preStep(
                { agent: harness.agent, messages: [human], turn, step: 1 },
                async () => ({ kind: "enter", messages: [human] }),
            );
        };

        const owed = await turnWith("关档之后的第一条", 1);
        assert.equal(owed.messages.length, 2);
        assert.equal(
            owed.messages[0].source.kind,
            "user",
            "the notice follows the message that opened the turn",
        );
        assert.equal(owed.messages[1].source.plugin, "dsh-ultracode");
        assert.equal(
            owed.messages[1].source.summary,
            "ultracode mode ended before this turn",
        );
        assert.ok(
            owed.messages[1].content[0].text.includes("workflows mode off"),
        );

        // The notice is owed once. The session is off from here on, so every later
        // turn is a plain unarmed turn again.
        const later = await turnWith("关档之后的第二条", 2);
        assert.equal(
            later.messages.length,
            1,
            "a disarmed session must not keep reporting the mode",
        );
    },
);

test(
    "re-arming before the notice is delivered drops the notice",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        setLevel(harness, "high");
        setLevel(harness, "off");
        // The user turned the level back on before sending anything, so the next
        // turn is armed and gets the level's own banner instead.
        setLevel(harness, "ultra");
        const preStep = harness.listeners.get("agent/pre-step");
        const human = humanMessage("重新开档之后的第一条");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(decision.messages.length, 2);
        assert.ok(
            decision.messages[1].content[0].text.includes("Effort: ULTRA"),
        );
        assert.equal(
            decision.messages[1].content[0].text.includes("workflows mode off"),
            false,
            "a stale disarm notice must not ride along with the new banner",
        );
    },
);

test(
    "a step that is refused keeps the notice owed for the next one",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        setLevel(harness, "high");
        setLevel(harness, "off");
        const preStep = harness.listeners.get("agent/pre-step");

        // A step that never enters injects nothing, so it must not consume the
        // notice: the turn that does open is the one that has to carry it.
        const refused = humanMessage("被拒绝的一步");
        const rejected = await preStep(
            { agent: harness.agent, messages: [refused], turn: 1, step: 1 },
            async () => ({ kind: "reject", messages: [refused] }),
        );
        assert.equal(rejected.kind, "reject");

        const human = humanMessage("真正发出去的一条");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 2, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(decision.messages.length, 2);
        assert.ok(
            decision.messages[1].content[0].text.includes("workflows mode off"),
        );
    },
);

test(
    "a batch with no opening message does not consume the notice",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        setLevel(harness, "high");
        setLevel(harness, "off");
        const preStep = harness.listeners.get("agent/pre-step");

        const toolResult = toolResultMessage();
        const step = await preStep(
            { agent: harness.agent, messages: [toolResult], turn: 1, step: 2 },
            async () => ({ kind: "enter", messages: [toolResult] }),
        );
        assert.equal(step.messages.length, 1);

        const human = humanMessage("轮到真正开局的那条消息");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 2, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(decision.messages.length, 2);
        assert.ok(
            decision.messages[1].content[0].text.includes("workflows mode off"),
        );
    },
);

test(
    "one opening message collects one disarm notice",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        setLevel(harness, "high");
        setLevel(harness, "off");
        const preStep = harness.listeners.get("agent/pre-step");

        // The runtime hands an abandoned step's opening message back to the next
        // step, so the same message reaches the waterfall twice.
        const human = humanMessage("同一条开局消息");
        const first = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(first.messages.length, 2);
        const again = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(
            again.messages.length,
            1,
            "a re-queued opening must not collect a second notice",
        );
    },
);

test(
    "the first turn states the block and later turns carry the reminder",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        setLevel(harness, "high");
        const preStep = harness.listeners.get("agent/pre-step");

        const bannerFor = async (text, turn) => {
            const human = humanMessage(text);
            const decision = await preStep(
                { agent: harness.agent, messages: [human], turn, step: 1 },
                async () => ({ kind: "enter", messages: [human] }),
            );
            assert.equal(decision.messages.length, 2, `turn ${turn} injected`);
            return decision.messages[1].content[0].text;
        };

        const first = await bannerFor("先做一次完整的编排", 1);
        assert.ok(
            first.includes("Effort: HIGH"),
            "the first turn of a level states its full block",
        );

        const second = await bannerFor("再来一轮", 2);
        assert.ok(
            !second.includes("Effort: HIGH"),
            "a later turn must not repeat the block",
        );
        assert.ok(
            second.includes("high"),
            "the reminder must still name the level",
        );

        // Changing the level states the new level's block, because the two levels
        // differ in exactly that text.
        setLevel(harness, "ultra");
        const third = await bannerFor("换成极致档再跑", 3);
        assert.ok(
            third.includes("Effort: ULTRA"),
            "a level change must state the new block",
        );

        const fourth = await bannerFor("继续这一档", 4);
        assert.ok(
            !fourth.includes("Effort: ULTRA"),
            "the unchanged level must fall back to the reminder",
        );
    },
);

test(
    "a steer typed into a running turn carries a banner of its own",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        setLevel(harness, "high");
        const preStep = harness.listeners.get("agent/pre-step");

        const first = humanMessage("先看一下这个模块");
        const opened = await preStep(
            { agent: harness.agent, messages: [first], turn: 1, step: 1 },
            async () => ({ kind: "enter", messages: [first] }),
        );
        assert.equal(opened.messages.length, 2);

        // A steer joins the running turn, so the turn number is unchanged while the
        // message is new. It must still be injected.
        const steer = humanMessage("顺便把单测也补上");
        const steered = await preStep(
            {
                agent: harness.agent,
                messages: [toolResultMessage(), steer],
                turn: 1,
                step: 2,
            },
            async () => ({
                kind: "enter",
                messages: [toolResultMessage(), steer],
            }),
        );
        assert.equal(
            steered.messages.length,
            3,
            "the steer must carry a banner despite the unchanged turn",
        );
        assert.equal(steered.messages[1].id, steer.id);
        assert.equal(steered.messages[2].source.plugin, "dsh-ultracode");
    },
);

test("an unarmed session is never injected", { skip: !available }, async () => {
    const module = await loadHostBundle(bundlePath);
    const harness = makeContext();
    module.apply(harness.ctx, {});
    const preStep = harness.listeners.get("agent/pre-step");
    const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
    const decision = await preStep(
        { agent: harness.agent, messages: [human], turn: 1, step: 1 },
        async () => ({ kind: "enter", messages: [human] }),
    );
    assert.equal(decision.messages.length, 1);
});

test(
    "a delegated child session is skipped even while armed",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext({
            header: { origin: "subagent", delegationDepth: 1 },
        });
        module.apply(harness.ctx, {});
        setLevel(harness, "high");
        const preStep = harness.listeners.get("agent/pre-step");
        const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(decision.messages.length, 1);
    },
);

test(
    "the command refuses to arm a session that cannot see the workflow tool",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext({ tools: { get: () => undefined } });
        module.apply(harness.ctx, {});
        const result = harness.commands[0].handler({
            agent: harness.agent,
            rawInput: " high",
        });
        assert.equal(result.kind, "error");
        assert.ok(
            result.text.toLowerCase().includes("workflow"),
            `the refusal must name the tool it cannot see: ${result.text}`,
        );
    },
);

test(
    "the command drives the same level changes the control writes",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const command = harness.commands[0];
        const high = command.handler({
            agent: harness.agent,
            rawInput: " high",
        });
        assert.equal(high.kind, "success");
        assert.ok(high.text.includes("高阶"));
        const unknown = command.handler({
            agent: harness.agent,
            rawInput: " turbo",
        });
        assert.equal(unknown.kind, "error");
        const status = command.handler({
            agent: harness.agent,
            rawInput: " status",
        });
        assert.equal(status.kind, "success");
        assert.ok(status.text.includes("高阶"));
        // The clear subcommand is gone: the word names no level any more, so it is
        // refused exactly like any other unknown word.
        const cleared = command.handler({
            agent: harness.agent,
            rawInput: " clear",
        });
        assert.equal(cleared.kind, "error");
        assert.ok(cleared.text.includes("clear"));
        const off = command.handler({ agent: harness.agent, rawInput: " off" });
        assert.equal(off.kind, "success");
        assert.equal(
            command
                .handler({ agent: harness.agent, rawInput: " status" })
                .text.includes("关闭"),
            true,
        );
    },
);

test(
    "an argument-less command rotates through the levels and wraps",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        const command = harness.commands[0];

        // The plain `/ultracode` form asks for the next level rather than naming one,
        // so the answer has to be the level the rotation actually reached.
        const first = command.handler({ agent: harness.agent, rawInput: "" });
        assert.equal(first.kind, "success");
        assert.ok(
            first.text.includes("高阶"),
            `the first rotation must land on high: ${first.text}`,
        );
        assert.ok(
            command
                .handler({ agent: harness.agent, rawInput: " status" })
                .text.includes("档位：高阶"),
        );

        // Trailing whitespace is the same argument-less form, not an unknown word.
        const second = command.handler({
            agent: harness.agent,
            rawInput: "   ",
        });
        assert.equal(second.kind, "success");
        assert.ok(
            second.text.includes("极致"),
            `the second rotation must land on ultra: ${second.text}`,
        );

        const third = command.handler({ agent: harness.agent, rawInput: "" });
        assert.ok(
            third.text.includes("关闭"),
            `the third rotation must wrap to off: ${third.text}`,
        );

        const fourth = command.handler({ agent: harness.agent, rawInput: "" });
        assert.ok(
            fourth.text.includes("高阶"),
            `the rotation must start over from off: ${fourth.text}`,
        );
    },
);

test(
    "the registered projection carries the browser key, its state version, and the fold",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        assert.equal(
            harness.projectorCount(),
            1,
            "the plugin must publish exactly one projection",
        );
        const definition = harness.projection();
        // The key and the state version are the two halves of the projection contract
        // with the browser: the state is published under the key the client reads, and
        // a stored state is restored through the version.
        assert.equal(
            definition.key,
            ULTRACODE_KEY,
            "the browser reads the state under this key",
        );
        assert.equal(
            definition.stateVersion,
            ULTRACODE_STATE_VERSION,
            "a checkpoint is restored through this version",
        );
        assert.equal(
            harness.foldedState(),
            undefined,
            "nothing is folded before the first event",
        );

        // Reading the state is how the plugin learns what the log already records, so
        // it has to ask under the key it registered; the status answer is that read.
        const status = harness.commands[0].handler({
            agent: harness.agent,
            rawInput: " status",
        });
        assert.equal(status.kind, "success");
        assert.deepEqual(
            [...new Set(harness.queriedKeys())],
            [ULTRACODE_KEY],
            "the fold must be read under the registered key",
        );

        // The fold is what the control displays: these two events are the lifecycle a
        // level command leaves in the log.
        harness.feedFolded({
            type: "command/run",
            seq: 1,
            data: { commandId: "c1", name: "ultracode", args: "ultra" },
        });
        harness.feedFolded({
            type: "command/done",
            seq: 2,
            data: { commandId: "c1", kind: "success" },
        });
        const folded = harness.foldedState();
        assert.equal(
            folded.wire.level,
            "ultra",
            "the folded level must be the one the command named",
        );
        assert.equal(
            definition.wire.view(folded),
            folded.wire,
            "the unit publishes exactly the wire the fold built",
        );
        assert.equal(
            harness.ctx.reflect.get("sessionProjections") !== undefined,
            true,
        );
    },
);

test(
    "a host without a projection registry keeps the command channel working",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext({ projections: false });
        const dispose = module.apply(harness.ctx, {});
        assert.equal(harness.projectorCount(), 0);
        const command = harness.commands[0];
        const result = command.handler({
            agent: harness.agent,
            rawInput: "ultra",
            signal: undefined,
        });
        assert.equal(result.kind, "success");
        // The banner injection reads the mirror, which the adoption path seeded from
        // the same command, so the feature works with no projection at all.
        const preStep = harness.listeners.get("agent/pre-step");
        const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(
            decision.messages.length,
            2,
            "the banner must still be injected",
        );
        assert.ok(
            decision.messages[1].content[0].text.includes("Effort: ULTRA"),
        );
        assert.equal(typeof dispose, "function");
    },
);

test(
    "a new host process restores the level the log already records",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        // The log is the only thing that survives a restart, so it is folded first and
        // the host is started against it afterwards.
        const harness = makeContext();
        module.apply(harness.ctx, {});
        harness.feedFolded({
            type: "command/run",
            seq: 2,
            data: { commandId: "c1", name: "ultracode", args: "ultra" },
        });
        harness.feedFolded({
            type: "command/done",
            seq: 3,
            data: { commandId: "c1", kind: "success" },
        });
        harness.feedFolded({
            type: "user/message",
            seq: 4,
            data: {
                source: {
                    kind: "plugin",
                    plugin: "dsh-ultracode",
                    form: "notice",
                    summary: "ultracode ultra armed this turn",
                },
            },
        });

        // The mirror starts at off in a fresh process; adoption is what makes the
        // reported level and the injection follow the log instead.
        const preStep = harness.listeners.get("agent/pre-step");
        const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 4, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(
            decision.messages.length,
            2,
            "a restored level must still arm the turn",
        );

        // The status answer reports the fold, which is what the control displays.
        const status = harness.commands[0].handler({
            agent: harness.agent,
            rawInput: "status",
            signal: undefined,
        });
        assert.equal(status.kind, "success");
        assert.ok(
            status.text.includes("极致"),
            `the status answer must name the folded level: ${status.text}`,
        );
    },
);

test(
    "with nothing in the log the level reads off and no turn is injected",
    { skip: !available },
    async () => {
        const module = await loadHostBundle(bundlePath);
        const harness = makeContext();
        module.apply(harness.ctx, {});
        // The status answer reports the fold, which with an empty log is off.
        const status = harness.commands[0].handler({
            agent: harness.agent,
            rawInput: " status",
        });
        assert.equal(status.kind, "success");
        assert.ok(
            status.text.includes("关闭"),
            `an empty log must read as off: ${status.text}`,
        );
        const preStep = harness.listeners.get("agent/pre-step");
        const human = humanMessage("帮我重构一下这个模块的解析逻辑并补上单测");
        const decision = await preStep(
            { agent: harness.agent, messages: [human], turn: 1, step: 1 },
            async () => ({ kind: "enter", messages: [human] }),
        );
        assert.equal(
            decision.messages.length,
            1,
            "an unarmed session must not be injected",
        );
    },
);
