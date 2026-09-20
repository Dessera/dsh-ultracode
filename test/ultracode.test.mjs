/**
 * Pure-function tests for the level vocabulary, the per-session state store,
 * and the injected text.
 *
 * Everything under test is deliberately free of host dependencies, so these
 * tests run against the TypeScript sources directly with no build step.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isUltracodeLevel, parseUltracodeLevel } from "../src/host/protocol.ts";
import {
    BANNER_CLOSE,
    BANNER_OPEN,
    buildBanner,
    buildInjection,
    buildInstruction,
    buildReminder,
    FORBIDDEN_SCRIPT_NAMES,
    injectionSummary,
    SCRIPT_SURFACE,
} from "../src/host/prompt.ts";
import { createBannerMessage } from "../src/host/message.ts";
import {
    applyProjectionEvent,
    initialProjectionState,
} from "../src/host/reducer.ts";
import { UltracodeStateStore } from "../src/host/state.ts";

/** Build a session-like handle for the store. */
const sessionOf = (id) => ({ id });

/** Fold the banner message the plugin injects for one armed turn. */
function foldBanner(level) {
    return applyProjectionEvent(initialProjectionState(), {
        type: "user/message",
        seq: 1,
        data: {
            source: {
                kind: "plugin",
                plugin: "dsh-ultracode",
                form: "notice",
                summary: injectionSummary(level),
            },
        },
    });
}

test("the level vocabulary accepts exactly the three levels", () => {
    assert.deepEqual(
        [
            isUltracodeLevel("off"),
            isUltracodeLevel("high"),
            isUltracodeLevel("ultra"),
        ],
        [true, true, true],
    );
    assert.equal(isUltracodeLevel("max"), false);
    assert.equal(isUltracodeLevel(undefined), false);
});

test("a level word is trimmed and lowercased before it is parsed", () => {
    assert.equal(parseUltracodeLevel("  Off  "), "off");
    assert.equal(parseUltracodeLevel("  high"), "high");
    assert.equal(parseUltracodeLevel("Ultra"), "ultra");
    assert.equal(parseUltracodeLevel(" 极致 "), "ultra");
});

test("the off level also answers to the two off aliases", () => {
    assert.equal(parseUltracodeLevel("none"), "off");
    assert.equal(parseUltracodeLevel("close"), "off");
});

test("a level change reports whether it changed anything", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    assert.equal(store.stateOf(session).level, "off");
    assert.equal(store.select(session, "high").kind, "changed");
    assert.equal(store.select(session, "high").kind, "unchanged");
    assert.equal(store.select(session, "off").kind, "changed");
});

test("one anchor message is injected at most once", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    assert.equal(store.claimInjection(session, "m-1"), true);
    assert.equal(store.claimInjection(session, "m-1"), false);
    // A later message claims its own injection, which is what lets a steer typed
    // into a running turn carry a banner even though the turn number is unchanged.
    assert.equal(store.claimInjection(session, "m-2"), true);
});

test("a level states its block once and reminds on every turn after that", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    assert.equal(store.announce(session, "high"), true);
    assert.equal(store.announce(session, "high"), false);
    assert.equal(store.announce(session, "high"), false);
    // A real change states the new level's block, because the two levels differ
    // in exactly that text.
    assert.equal(store.announce(session, "ultra"), true);
    assert.equal(store.announce(session, "ultra"), false);
    // Leaving and re-entering a level states it again rather than reminding.
    assert.equal(store.announce(session, "high"), true);
});

test("leaving for off makes the next arming state the block again", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    store.select(session, "high");
    assert.equal(store.announce(session, "high"), true);
    assert.equal(store.announce(session, "high"), false);

    // Turning the level off forgets the announcement: the turns in between can be
    // arbitrarily many, and compaction may have removed the block by the time the
    // session is armed again, so the block is stated rather than assumed readable.
    store.select(session, "off");
    store.select(session, "high");
    assert.equal(
        store.announce(session, "high"),
        true,
        "re-arming after off must state the block again",
    );
});

test("the reminder names the level and still lets a trivial turn through", () => {
    for (const level of ["high", "ultra"]) {
        const reminder = buildReminder(level);
        assert.ok(
            reminder.includes(level),
            `${level} reminder must name its level`,
        );
        assert.ok(
            reminder.includes("trivial"),
            `${level} reminder must keep the escape hatch`,
        );
    }
    assert.equal(buildReminder("off"), "");
});

test("the reminder is far shorter than the block it replaces", () => {
    // The whole point of the reminder is that a long session does not pay for the
    // full block on every turn, so the two must not drift into being alike.
    for (const level of ["high", "ultra"]) {
        assert.ok(
            buildReminder(level).length * 4 < buildInjection(level).length,
            `${level} reminder is not meaningfully shorter than its block`,
        );
    }
});

test("the banner names only the script surface the engine provides", () => {
    const banner = buildBanner();
    for (const hook of SCRIPT_SURFACE)
        assert.ok(banner.includes(hook), `banner should name ${hook}`);
    for (const forbidden of FORBIDDEN_SCRIPT_NAMES) {
        assert.equal(
            banner.includes(forbidden),
            false,
            `banner must not name ${forbidden}`,
        );
    }
});

test("no generated text names a hook the engine does not provide", () => {
    for (const level of ["high", "ultra"]) {
        for (const text of [buildInjection(level), buildReminder(level)]) {
            for (const forbidden of FORBIDDEN_SCRIPT_NAMES) {
                assert.equal(
                    text.includes(forbidden),
                    false,
                    `${level} must not name ${forbidden}`,
                );
            }
        }
    }
});

test("every armed level carries the escape sentence and off carries nothing", () => {
    for (const level of ["high", "ultra"]) {
        assert.ok(
            buildInstruction(level).includes("standing ultracode mode"),
            `${level} must let the model skip a trivial turn`,
        );
    }
    assert.equal(buildInstruction("off"), "");
});

test("the banner states why the turn is armed", () => {
    assert.ok(buildBanner().includes("standing ultracode mode"));
});

test("the injected banner is wrapped in the stable open and close markers", () => {
    const banner = buildBanner();
    assert.equal(
        banner.startsWith(`---\n${BANNER_OPEN}`),
        true,
        "the banner must open with the marker",
    );
    assert.equal(
        banner.endsWith(BANNER_CLOSE),
        true,
        "the banner must close with the marker",
    );
    // The block opens before the decision sentence, so the marker wraps the whole
    // banner rather than the arming clause alone.
    assert.equal(BANNER_OPEN, "[workflows mode armed.");
    assert.equal(BANNER_CLOSE, "]");
});

test("the summary the injector writes is the one the fold reads back", () => {
    assert.equal(foldBanner("high").level, "high");
    assert.equal(foldBanner("ultra").level, "ultra");
});

test("the injected banner message is frozen all the way down", () => {
    const banner = createBannerMessage(
        "the injected text",
        "dsh-ultracode",
        "ultracode ultra armed this turn",
    );
    assert.equal(Object.isFrozen(banner), true);
    assert.equal(Object.isFrozen(banner.content), true);
    assert.equal(Object.isFrozen(banner.content[0]), true);
    assert.equal(Object.isFrozen(banner.source), true);
});

test("adopting a folded level seeds the mirror once and never moves it again", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    assert.equal(store.adopted(session), false);
    store.adopt(session, "off");
    assert.equal(store.adopted(session), true);
    assert.equal(store.stateOf(session).level, "off");
    store.adopt(session, "ultra");
    assert.equal(
        store.stateOf(session).level,
        "off",
        "a second adopt must not move the mirror",
    );
});
