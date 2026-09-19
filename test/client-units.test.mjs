/**
 * Unit tests for the browser half's two plain modules.
 *
 * The bundle test can only see the browser half through the built artifact,
 * where every decision is wrapped in a render. These tests import the view
 * logic and the write path directly, so the level-to-text mapping and the
 * reply-narrowing rules are asserted on their own values rather than through a
 * component tree.
 *
 * Neither module reaches for the DOM: `chip.ts` imports the shared protocol
 * vocabulary and the dictionary key type, and `service.ts` imports the command
 * name and a couple of type-only host declarations that type stripping removes
 * before Node loads them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { chipView } from "../src/client/chip.ts";
import { en, zh } from "../src/client/locales.ts";
import { changeLevel, readOutcome } from "../src/client/service.ts";

/** Build a wire value for a session that sits at one level. */
function wire(level) {
    return { level };
}

test("chipView translates each published level into its own text keys", () => {
    for (const level of ["off", "high", "ultra"]) {
        const view = chipView(wire(level), false, null, true);
        // Literal expectations, not templates built from the level: a swapped key
        // family has to fail here instead of following the source's own spelling.
        const expected = {
            off: ["chip.off", "chip.aria.off", "chip.title.off"],
            high: ["chip.high", "chip.aria.high", "chip.title.high"],
            ultra: ["chip.ultra", "chip.aria.ultra", "chip.title.ultra"],
        }[level];
        assert.equal(view.level, level);
        assert.deepEqual(
            [view.labelKey, view.ariaKey, view.titleKey],
            expected,
        );
    }
});

test("chipView describes a session whose value has not arrived as connecting", () => {
    const view = chipView(undefined, false, null, true);
    assert.equal(
        view.level,
        null,
        "nothing published must not be shown as a level",
    );
    assert.equal(view.labelKey, "chip.connecting");
    assert.equal(view.ariaKey, "chip.aria.connecting");
    assert.equal(view.titleKey, "chip.title.connecting");
    // The first press advances from off, the only level nobody had to publish.
    assert.equal(view.nextLevel, "high");
});

test("chipView arms every level except off", () => {
    assert.equal(chipView(wire("off"), false, null, true).armed, false);
    assert.equal(chipView(wire("high"), false, null, true).armed, true);
    assert.equal(chipView(wire("ultra"), false, null, true).armed, true);
    // A connecting chip is not armed: it has no level to be armed at.
    assert.equal(chipView(undefined, false, null, true).armed, false);
});

test("chipView refuses presses only while one is in flight or the session has no writer", () => {
    assert.equal(chipView(wire("high"), false, null, true).disabled, false);
    assert.equal(chipView(wire("high"), true, null, true).disabled, true);
    assert.equal(chipView(wire("high"), false, null, false).disabled, true);
    // The failure text is history, not a reason to refuse the next attempt.
    assert.equal(
        chipView(wire("high"), false, "the host said no", true).disabled,
        false,
    );
});

test("chipView carries the in-flight flag into the view it renders", () => {
    assert.equal(chipView(wire("high"), true, null, true).pending, true);
    assert.equal(chipView(wire("high"), false, null, true).pending, false);
});

test("chipView asks for the next level in the rotation, wrapping from the strongest", () => {
    assert.equal(chipView(wire("off"), false, null, true).nextLevel, "high");
    assert.equal(chipView(wire("high"), false, null, true).nextLevel, "ultra");
    assert.equal(chipView(wire("ultra"), false, null, true).nextLevel, "off");
});

test("readOutcome accepts a reply the host marked successful", () => {
    assert.deepEqual(readOutcome({ ok: true }), { ok: true });
});

test("readOutcome reports the value a successful reply carried as an error result", () => {
    const reply = {
        ok: true,
        value: { result: { kind: "error", text: "no workflow tool here" } },
    };
    assert.deepEqual(readOutcome(reply), {
        ok: false,
        message: "no workflow tool here",
    });
});

test("readOutcome accepts a failed result that carries no message", () => {
    const reply = { ok: true, value: { result: { kind: "error" } } };
    assert.deepEqual(readOutcome(reply), { ok: true });
});

test("readOutcome falls back to the error code when the host sent no message", () => {
    assert.deepEqual(
        readOutcome({ ok: false, error: { code: "unavailable" } }),
        {
            ok: false,
            message: "unavailable",
        },
    );
});

test("readOutcome reports a refusal with no message and no code as a bare failure", () => {
    assert.deepEqual(readOutcome({ ok: false, error: {} }), {
        ok: false,
        message: undefined,
    });
});

test("readOutcome treats a reply that is not an object as a failure with no message", () => {
    for (const reply of ["ultra", 7, null, undefined, ["ok", true]]) {
        assert.deepEqual(readOutcome(reply), { ok: false, message: undefined });
    }
});

test("readOutcome refuses a reply whose error field is a string rather than an object", () => {
    assert.deepEqual(readOutcome({ ok: false, error: "nope" }), {
        ok: false,
        message: undefined,
    });
});

test("readOutcome counts a truthy but non-boolean ok as a refusal", () => {
    assert.deepEqual(readOutcome({ ok: "yes" }), {
        ok: false,
        message: undefined,
    });
});

test("changeLevel sends the level as the command's argument word", async () => {
    const calls = [];
    const commands = {
        async execute(sessionId, line, attachments) {
            calls.push({ sessionId, line, attachments });
            return { ok: true };
        },
    };
    for (const level of ["off", "high", "ultra"]) {
        const outcome = await changeLevel(commands, "session-1", level);
        assert.equal(outcome.ok, true);
    }
    assert.deepEqual(
        calls.map((call) => call.line),
        ["/ultracode off", "/ultracode high", "/ultracode ultra"],
    );
    assert.deepEqual(
        calls.map((call) => call.sessionId),
        ["session-1", "session-1", "session-1"],
    );
    assert.deepEqual(
        calls.map((call) => [...call.attachments]),
        [[], [], []],
    );
});

test("changeLevel reports a session with no command channel instead of pressing anyway", async () => {
    const outcome = await changeLevel(undefined, "session-1", "high");
    assert.equal(outcome.ok, false);
    assert.equal(
        outcome.message,
        "The ultracode command channel is unavailable in this session.",
    );
});

test("changeLevel turns a rejected execute into the reason it gave", async () => {
    const commands = {
        async execute() {
            throw new Error("the socket closed");
        },
    };
    assert.deepEqual(await changeLevel(commands, "session-1", "high"), {
        ok: false,
        message: "the socket closed",
    });
});

test("changeLevel turns a non-Error rejection into text", async () => {
    const commands = {
        async execute() {
            // eslint-disable-next-line no-throw-literal -- a transport may reject with anything
            throw "offline";
        },
    };
    assert.deepEqual(await changeLevel(commands, "session-1", "high"), {
        ok: false,
        message: "offline",
    });
});

test("the dictionaries cover the same keys and none of them is empty", () => {
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
    assert.ok(Object.keys(zh).length > 0, "the dictionary must carry keys");
    for (const dict of [zh, en]) {
        for (const [key, value] of Object.entries(dict)) {
            assert.equal(typeof value, "string", `${key} must be a string`);
            assert.notEqual(value.trim(), "", `${key} must not be blank`);
        }
    }
});

test("every text key the chip can select is in both dictionaries", () => {
    const states = [undefined, wire("off"), wire("high"), wire("ultra")];
    for (const state of states) {
        const view = chipView(state, false, null, true);
        for (const key of [
            view.labelKey,
            view.ariaKey,
            view.titleKey,
            "chip.busy",
            "error.action",
        ]) {
            assert.ok(key in zh, `${key} must be in the Chinese dictionary`);
            assert.ok(key in en, `${key} must be in the English dictionary`);
        }
    }
});
