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
    PLUGIN_SOURCE_KIND,
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
                kind: PLUGIN_SOURCE_KIND,
                form: "notice",
                summary,
            },
        },
    };
}

/** Fold a sequence of events in order. */
function fold(events) {
    return events.reduce(
        (state, event) => applyProjectionEvent(state, event),
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
    assert.equal(classifyCommandArgs("ultra"), "level");
    assert.equal(classifyCommandArgs("极致"), "level");
    assert.equal(classifyCommandArgs("turbo"), "unknown-level");
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

test("a foreign command never moves the fold, not even with a level word", () => {
    // The command name is the whitelist: a fold that classified the arguments of
    // any command would treat `/plan high` as a level, so the name check is the
    // only thing holding the two apart.
    const foreignLevel = fold([
        commandRun("c1", "plan", "high"),
        commandDone("c1"),
    ]);
    assert.equal(foreignLevel.level, "off");
    assert.equal(foreignLevel.wire.level, "off");

    const foreignRotate = fold([
        banner("ultracode high armed this turn"),
        commandRun("c9", "plan", ""),
        commandDone("c9"),
    ]);
    assert.equal(foreignRotate.level, "high");
});

test("a settled level command republishes only a real change", () => {
    const first = fold([
        commandRun("c1", COMMAND_NAME, "ultra"),
        commandDone("c1"),
    ]);
    assert.equal(first.level, "ultra");
    assert.equal(first.wire.level, "ultra");

    // A second command that lands on the same level leaves the published wire
    // object untouched, which is what lets the registry skip the frame.
    let repeat = applyProjectionEvent(
        first,
        commandRun("c2", COMMAND_NAME, "ultra"),
    );
    repeat = applyProjectionEvent(repeat, commandDone("c2"));
    assert.equal(repeat.level, "ultra");
    assert.equal(repeat.wire, first.wire, "the same level must reuse the wire");
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

    // The error settlement returns before any level can be published, so it
    // hides a missing rejection; a successful one carries the pending level all
    // the way to the wire.
    const succeeded = fold([
        commandRun("c1", COMMAND_NAME, "turbo"),
        commandDone("c1"),
    ]);
    assert.equal(succeeded.level, "off");
    assert.equal(succeeded.pending, null);
});

test("the banner is recognised by its source and carries the level it announced", () => {
    const armed = fold([banner("ultracode ultra armed this turn")]);
    assert.equal(armed.level, "ultra");
    assert.equal(armed.wire.level, "ultra");
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
                    text: "ultracode ultra armed this turn",
                },
            ],
        },
    };
    const start = initialProjectionState();
    assert.equal(
        applyProjectionEvent(start, quoted),
        start,
        "an unrelated message must not move the fold",
    );
});

test("once the log carries a level command, a later banner never rolls the level back", () => {
    const state = fold([
        commandRun("c1", COMMAND_NAME, "ultra"),
        commandDone("c1"),
        banner("ultracode high armed this turn"),
    ]);
    assert.equal(state.level, "ultra", "the command history is the authority");
});

test("without any level command the banner itself carries the level across a restart", () => {
    const state = fold([banner("ultracode ultra armed this turn")]);
    assert.equal(state.level, "ultra");
    assert.equal(state.fromCommand, false);
});

test("the fold state is plain JSON and survives the registry checkpoint clone", () => {
    const state = fold([
        commandRun("c1", COMMAND_NAME, "high"),
        commandDone("c1"),
        banner("ultracode high armed this turn"),
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
    assert.deepEqual(parsedWire, { level: "off" });
    assert.notStrictEqual(
        parsedWire,
        wire,
        "the parse must rebuild instead of passing its input through",
    );
    const degraded = UltracodeWireSchema.parse({ level: "turbo" });
    assert.deepEqual(degraded, { level: "off" });
    assert.deepEqual(
        ProjectionStateSchema.parse(undefined),
        initialProjectionState(),
    );
    assert.equal(
        ProjectionStateSchema.parse({
            pending: { commandId: "c1", level: "nope" },
        }).pending,
        null,
    );
});

test("the projection unit folds the log without any session or state store", () => {
    const unit = ultracodeProjection();
    // The key and the version are written into every persisted projection row, so
    // the literals are pinned as well: comparing against the constants alone
    // would follow a changed constant through without noticing.
    assert.equal(unit.key, "ultracode");
    assert.equal(unit.stateVersion, 2);
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
