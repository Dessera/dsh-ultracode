/**
 * Tests for the shared protocol, the pure log fold, and the projection unit.
 *
 * These three modules are the refactor's foundation: the fold is the only
 * derivation of a session's level, and the registry that consumes it requires
 * the fold to be a pure, plain-JSON function of the log. The assertions here
 * pin the two properties the registry depends on — reference stability for
 * unrelated events, and state that survives a structured clone — plus the
 * event vocabulary the fold reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
    COMMAND_NAME,
    LEVELS,
    PLUGIN_ID,
    ProjectionStateSchema,
    ULTRACODE_KEY,
    ULTRACODE_STATE_VERSION,
    UltracodeWireSchema,
    initialWire,
    isUltracodeLevel,
    levelLabel,
    nextUltracodeLevel,
    parseUltracodeLevel,
} from "../src/host/protocol.ts";
import {
    applyProjectionEvent,
    classifyCommandArgs,
    initialProjectionState,
    parseCommandLevel,
} from "../src/host/reducer.ts";
import { ultracodeProjection } from "../src/host/projection.ts";

/** One command/run event as DSH records it. */
function commandRun(commandId, name, args) {
    return { type: "command/run", seq: 1, data: { commandId, name, args } };
}

/** One command/done event as DSH records it. */
function commandDone(commandId, kind = "success") {
    return { type: "command/done", seq: 2, data: { commandId, kind } };
}

/** One banner user message as the plugin's own injection records it. */
function banner(summary) {
    return {
        type: "user/message",
        seq: 3,
        data: {
            source: {
                kind: "plugin",
                plugin: PLUGIN_ID,
                form: "notice",
                summary,
            },
        },
    };
}

/** Fold a sequence of events in order. */
function fold(events, extraLevels = []) {
    return events.reduce(
        (state, event) => applyProjectionEvent(state, event, extraLevels),
        initialProjectionState(),
    );
}

test("the vocabulary has exactly three levels and rotates forward", () => {
    assert.deepEqual([...LEVELS], ["off", "high", "ultra"]);
    assert.equal(nextUltracodeLevel("off"), "high");
    assert.equal(nextUltracodeLevel("high"), "ultra");
    assert.equal(nextUltracodeLevel("ultra"), "off");
    assert.equal(isUltracodeLevel("off"), true);
    assert.equal(isUltracodeLevel("none"), false);
});

test("level words parse in both languages and unknown words are refused", () => {
    assert.equal(parseUltracodeLevel("OFF"), "off");
    assert.equal(parseUltracodeLevel(" 关闭 "), "off");
    assert.equal(parseUltracodeLevel("高阶"), "high");
    assert.equal(parseUltracodeLevel("极致"), "ultra");
    assert.equal(parseUltracodeLevel("turbo"), undefined);
    assert.equal(levelLabel("off", "zh"), "关闭");
    assert.equal(levelLabel("ultra", "en"), "ultra");
});

test("the command argument vocabulary is classified the way the handler reads it", () => {
    assert.equal(classifyCommandArgs(""), "rotate");
    assert.equal(classifyCommandArgs("   "), "rotate");
    assert.equal(classifyCommandArgs("status"), "status");
    assert.equal(classifyCommandArgs("clear"), "clear");
    assert.equal(classifyCommandArgs("cancel"), "clear");
    assert.equal(classifyCommandArgs("ultra"), "level");
    assert.equal(classifyCommandArgs("极致"), "level");
    assert.equal(classifyCommandArgs("turbo"), "unknown-level");
    assert.equal(parseCommandLevel("turbo", ["turbo"]), "ultra");
});

test("an unrelated event returns the very same state reference", () => {
    const state = initialProjectionState();
    const same = applyProjectionEvent(state, {
        type: "assistant/message",
        seq: 1,
    });
    assert.equal(same, state);
    const otherCommand = applyProjectionEvent(
        state,
        commandRun("c1", "plan", "on"),
    );
    assert.equal(otherCommand, state);
});

test("a foreign command never moves the fold, not even with level or clear words", () => {
    // The command name is the whitelist: a fold that classified the arguments of
    // any command would treat `/plan high` as a level and `/plan clear` as a
    // disarm, so the name check is the only thing holding these two apart.
    const foreignLevel = fold([
        commandRun("c1", "plan", "high"),
        commandDone("c1"),
    ]);
    assert.equal(foreignLevel.level, "off");
    assert.equal(foreignLevel.revision, 0);

    const foreignClear = fold([
        { type: "turn/start", seq: 1, data: { turn: 4 } },
        banner("ultracode high armed this turn (level)"),
        commandRun("c9", "plan", "clear"),
        commandDone("c9"),
    ]);
    assert.equal(foreignClear.wire.armedTurn, true);
    assert.equal(foreignClear.level, "high");
});

test("a settled level command moves the fold and bumps the revision once", () => {
    const after = fold([
        commandRun("c1", COMMAND_NAME, "ultra"),
        commandDone("c1"),
    ]);
    assert.equal(after.level, "ultra");
    assert.equal(after.revision, 1);
    assert.equal(after.wire.level, "ultra");
    assert.equal(after.wire.revision, 1);

    const repeat = fold([
        commandRun("c1", COMMAND_NAME, "ultra"),
        commandDone("c1"),
        commandRun("c2", COMMAND_NAME, "ultra"),
        commandDone("c2"),
    ]);
    assert.equal(repeat.level, "ultra");
    assert.equal(
        repeat.revision,
        1,
        "re-selecting the same level must not publish a new frame",
    );
});

test("a command that started but did not settle leaves the visible level alone", () => {
    const started = fold([commandRun("c1", COMMAND_NAME, "ultra")]);
    assert.equal(started.level, "off");
    // The pending record is the fold's own bookkeeping and the client never reads
    // it, so only the parts the next event depends on belong in the assertion.
    assert.notEqual(started.pending, null);
    assert.equal(started.pending.commandId, "c1");

    const failed = fold([
        commandRun("c1", COMMAND_NAME, "ultra"),
        commandDone("c1", "error"),
    ]);
    assert.equal(failed.level, "off");
    assert.equal(failed.pending, null);
    assert.equal(failed.revision, 0);
});

test("the argument-less form rotates from the level the fold already reports", () => {
    const once = fold([commandRun("c1", COMMAND_NAME, ""), commandDone("c1")]);
    assert.equal(once.level, "high");
    const twice = fold([
        commandRun("c1", COMMAND_NAME, ""),
        commandDone("c1"),
        commandRun("c2", COMMAND_NAME, ""),
        commandDone("c2"),
    ]);
    assert.equal(twice.level, "ultra");
    const thrice = fold([
        commandRun("c1", COMMAND_NAME, ""),
        commandDone("c1"),
        commandRun("c2", COMMAND_NAME, ""),
        commandDone("c2"),
        commandRun("c3", COMMAND_NAME, ""),
        commandDone("c3"),
    ]);
    assert.equal(thrice.level, "off");
});

test("an unknown level word never moves the fold", () => {
    const errored = fold([
        commandRun("c1", COMMAND_NAME, "turbo"),
        commandDone("c1", "error"),
    ]);
    assert.equal(errored.level, "off");
    assert.equal(errored.revision, 0);

    // The error settlement returns before any level can be published, so it
    // hides a missing rejection; a successful one carries the pending level all
    // the way to the wire.
    const succeeded = fold([
        commandRun("c1", COMMAND_NAME, "turbo"),
        commandDone("c1"),
    ]);
    assert.equal(succeeded.level, "off");
    assert.equal(succeeded.pending, null);
    assert.equal(succeeded.revision, 0);
});

test("the banner is recognised by its source and carries the arming reason", () => {
    const armed = fold([
        { type: "turn/start", seq: 1, data: { turn: 4 } },
        banner("ultracode ultra armed this turn (level)"),
    ]);
    assert.equal(armed.level, "ultra");
    assert.equal(armed.wire.armedTurn, true);
    assert.equal(armed.wire.keywordArmed, false);

    const keyword = fold([
        { type: "turn/start", seq: 1, data: { turn: 4 } },
        banner("ultracode high armed this turn (keyword)"),
    ]);
    assert.equal(keyword.wire.keywordArmed, true);
});

test("a message that merely quotes the banner is not the banner", () => {
    const quoted = {
        type: "user/message",
        seq: 3,
        data: {
            source: { kind: "user" },
            content: [
                {
                    type: "text",
                    text: "ultracode ultra armed this turn (level)",
                },
            ],
        },
    };
    const state = fold([quoted]);
    assert.equal(state.wire.armedTurn, false);
    assert.equal(state.revision, 0);
});

test("a finished turn stops reporting an armed marker", () => {
    const state = fold([
        { type: "turn/start", seq: 1, data: { turn: 4 } },
        banner("ultracode high armed this turn (level)"),
        { type: "turn/end", seq: 9, data: { turn: 4, reason: "next-turn" } },
    ]);
    assert.equal(state.wire.armedTurn, false);
    assert.equal(state.level, "high");
});

test("once the log carries a level command, a later banner never rolls the level back", () => {
    const state = fold([
        commandRun("c1", COMMAND_NAME, "ultra"),
        commandDone("c1"),
        { type: "turn/start", seq: 5, data: { turn: 1 } },
        banner("ultracode high armed this turn (level)"),
    ]);
    assert.equal(state.level, "ultra", "the command history is the authority");
    assert.equal(state.wire.armedTurn, true);
});

test("without any level command the banner itself carries the level across a restart", () => {
    const state = fold([
        { type: "turn/start", seq: 1, data: { turn: 1 } },
        banner("ultracode ultra armed this turn (level)"),
    ]);
    assert.equal(state.level, "ultra");
    assert.equal(state.fromCommand, false);
});

test("a clear command drops the armed marker without touching the level", () => {
    const state = fold([
        { type: "turn/start", seq: 1, data: { turn: 4 } },
        banner("ultracode high armed this turn (level)"),
        commandRun("c9", COMMAND_NAME, "clear"),
        commandDone("c9"),
    ]);
    assert.equal(state.level, "high");
    assert.equal(state.wire.armedTurn, false);
});

test("the fold state is plain JSON and survives the registry checkpoint clone", () => {
    const state = fold([
        { type: "turn/start", seq: 1, data: { turn: 1 } },
        commandRun("c1", COMMAND_NAME, "high"),
        commandDone("c1"),
        banner("ultracode high armed this turn (level)"),
    ]);
    const cloned = structuredClone(state);
    assert.deepEqual(cloned, state);
    const parsed = ProjectionStateSchema.parse(cloned);
    assert.deepEqual(parsed, state);
    assert.notStrictEqual(
        parsed,
        cloned,
        "the parse must rebuild instead of passing its input through",
    );
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
});

test("the view parse always succeeds and never returns host objects by reference", () => {
    const wire = structuredClone(initialWire());
    const parsedWire = UltracodeWireSchema.parse(wire);
    assert.deepEqual(parsedWire, {
        level: "off",
        armedTurn: false,
        keywordArmed: false,
        revision: 0,
    });
    assert.notStrictEqual(
        parsedWire,
        wire,
        "the parse must rebuild instead of passing its input through",
    );
    const degraded = UltracodeWireSchema.parse({
        level: "turbo",
        armedTurn: "yes",
        revision: "x",
    });
    assert.deepEqual(degraded, {
        level: "off",
        armedTurn: false,
        keywordArmed: false,
        revision: 0,
    });
    assert.deepEqual(
        ProjectionStateSchema.parse(undefined),
        initialProjectionState(),
    );
    assert.equal(
        ProjectionStateSchema.parse({
            pending: { kind: "set-level", level: "nope" },
        }).pending,
        null,
    );
});

test("the projection unit folds the log without any session or state store", () => {
    const unit = ultracodeProjection({ extraLevels: [] });
    // The key and the version are written into every persisted projection row, so
    // the literals are pinned as well: comparing against the constants alone
    // would follow a changed constant through without noticing.
    assert.equal(unit.key, "ultracode");
    assert.equal(unit.stateVersion, 1);
    assert.equal(unit.key, ULTRACODE_KEY);
    assert.equal(unit.stateVersion, ULTRACODE_STATE_VERSION);
    // The unit's init takes only a header and an event count; calling it with a
    // bare object stands in for the cold path where no session exists at all.
    const start = unit.init({ id: "session-1" }, 0);
    assert.deepEqual(start, initialProjectionState());
    const after = unit.apply(start, commandRun("c1", COMMAND_NAME, "high"));
    const settled = unit.apply(after, commandDone("c1"));
    assert.equal(unit.wire.view(settled).level, "high");
    // The wire object is stable while nothing visible changed, which is what
    // makes the registry's Object.is gate suppress an unnecessary frame.
    const unchanged = unit.apply(settled, {
        type: "assistant/message",
        seq: 4,
    });
    assert.equal(unit.wire.view(settled), unit.wire.view(unchanged));
    assert.deepEqual(
        unit.wire.viewSchema.parse(unit.wire.view(settled)),
        unit.wire.view(settled),
    );
});
