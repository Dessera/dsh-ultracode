/**
 * Pure-function tests for the level vocabulary, the per-session state store,
 * the Chinese-aware heuristics, and the injected text.
 *
 * Everything under test is deliberately free of host dependencies, so these
 * tests run against the TypeScript sources directly with no build step.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isUltracodeLevel, parseUltracodeLevel } from "../src/host/protocol.ts";
import {
    isSubstantiveRequest,
    weightedLength,
    SUBSTANTIVE_WEIGHT_THRESHOLD,
} from "../src/host/heuristics.ts";
import {
    BANNER_CLOSE,
    BANNER_OPEN,
    buildBanner,
    buildInjection,
    buildInstruction,
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

test("one turn is injected at most once", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    assert.equal(store.claimInjection(session, 3), true);
    assert.equal(store.claimInjection(session, 3), false);
    // A later turn claims its own injection.
    assert.equal(store.claimInjection(session, 4), true);
});

test("the first remembered effort wins and can be forgotten", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    store.rememberEffort(session, { effort: "high" });
    store.rememberEffort(session, { effort: "low" });
    assert.deepEqual(store.rememberedEffort(session), { effort: "high" });
    store.forgetEffort(session);
    assert.equal(store.rememberedEffort(session), undefined);
});

test("a request with a work verb is substantive without reaching the weight threshold", () => {
    assert.equal(isSubstantiveRequest("帮我重构一下这个模块"), true);
});

test("a message long enough on weight alone is substantive with no work verb in it", () => {
    const text = "xy".repeat(32);
    assert.equal(weightedLength(text), 16);
    assert.equal(isSubstantiveRequest(text), true);
});

test("a message one weighted unit short of the threshold is not substantive", () => {
    const text = "xy".repeat(30);
    assert.equal(weightedLength(text), 15);
    assert.equal(isSubstantiveRequest(text), false);
});

test("a greeting is not substantive", () => {
    assert.equal(isSubstantiveRequest("你好"), false);
    assert.equal(isSubstantiveRequest("thanks!"), false);
    assert.equal(isSubstantiveRequest("   "), false);
});

test("a slash command line is never substantive", () => {
    assert.equal(isSubstantiveRequest("/ultracode ultra"), false);
});

test("a question too light to call work is not substantive", () => {
    assert.equal(weightedLength("这样对吗？"), 4);
    assert.equal(isSubstantiveRequest("这样对吗？"), false);
});

test("a long question is refused while its weight is still under the ceiling", () => {
    const question =
        "为什么帮我重构一下这个模块的解析逻辑呢帮我重构一下这个模块的解";
    assert.equal(weightedLength(question), 31);
    assert.equal(isSubstantiveRequest(question), false);
});

test("a question of exactly the ceiling weight is accepted as work", () => {
    const question =
        "为什么帮我重构一下这个模块的解析逻辑呢帮我重构一下这个模块的解析";
    assert.equal(weightedLength(question), 32);
    assert.equal(isSubstantiveRequest(question), true);
});

test("a question that carries a work verb is admitted by the verb rule", () => {
    const text = "重构这个模块";
    assert.equal(weightedLength(text), 6);
    assert.equal(isSubstantiveRequest(text), true);
});

test("work verb or not, a message under the minimum weight is not substantive", () => {
    assert.equal(weightedLength("fix"), 0.75);
    assert.equal(isSubstantiveRequest("fix"), false);
});

test("a short imperative with a work verb is substantive", () => {
    assert.equal(isSubstantiveRequest("重构它"), true);
});

test("weighted length counts four Latin letters as one glyph", () => {
    assert.equal(weightedLength("abcd"), 1);
    assert.equal(weightedLength("重构"), 2);
    assert.equal(weightedLength("帮我重构一下这个模块"), 10);
    assert.ok(
        weightedLength("帮我重构一下这个模块的解析逻辑并补上单测") >=
            SUBSTANTIVE_WEIGHT_THRESHOLD,
    );
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
        const text = buildInjection(level);
        for (const forbidden of FORBIDDEN_SCRIPT_NAMES) {
            assert.equal(
                text.includes(forbidden),
                false,
                `${level} must not name ${forbidden}`,
            );
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
