/**
 * Pure-function tests for the level vocabulary, the per-session state store,
 * the Chinese-aware heuristics, and the injected text.
 *
 * Everything under test is deliberately free of host dependencies, so these
 * tests run against the TypeScript sources directly with no build step.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
    isArmed,
    isUltracodeLevel,
    parseUltracodeLevel,
} from "../src/host/protocol.ts";
import {
    buildKeywordPattern,
    isSubstantiveRequest,
    matchesKeyword,
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
function foldBanner(level, reason) {
    return applyProjectionEvent(initialProjectionState(), {
        type: "user/message",
        seq: 1,
        data: {
            source: {
                kind: "plugin",
                plugin: "dsh-ultracode",
                form: "notice",
                summary: injectionSummary(level, reason),
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
    assert.equal(isArmed("off"), false);
    assert.equal(isArmed("high"), true);
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

test("one turn is injected at most once, and the reason is remembered", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    assert.equal(store.claimInjection(session, 3, "level"), true);
    assert.equal(store.stateOf(session).keywordArmedTurn, false);
    assert.equal(store.claimInjection(session, 3, "level"), false);
    assert.equal(store.claimInjection(session, 4, "keyword"), true);
    assert.equal(store.stateOf(session).keywordArmedTurn, true);
});

test("a cleared marker stops reporting the turn as armed and keeps its claim", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    assert.equal(store.claimInjection(session, 1, "keyword"), true);
    assert.equal(store.armedTurn(session), true);
    store.clearTurn(session);
    // Clearing drops the marker without releasing the claim, because the banner the
    // turn already carries cannot be taken back out of the conversation: injecting
    // again in a later step of the same turn would only duplicate it.
    assert.equal(store.stateOf(session).injectedTurn, 1);
    assert.equal(store.armedTurn(session), false);
    assert.equal(store.stateOf(session).keywordArmedTurn, false);
    assert.equal(store.claimInjection(session, 1, "level"), false);
    // With no fold to read, the view follows the marker rather than the claim.
    assert.equal(
        store.viewOf(session, true, undefined, "/dsh-ultracode/state")
            .armedTurn,
        false,
    );
    // The next turn claims its own injection, which is what puts the marker back.
    assert.equal(store.claimInjection(session, 2, "level"), true);
    assert.equal(store.armedTurn(session), true);
});

test("the first remembered effort wins and can be forgotten", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    store.rememberEffort(session, { effort: "high", adapterDefault: false });
    store.rememberEffort(session, { effort: "low", adapterDefault: true });
    assert.deepEqual(store.rememberedEffort(session), {
        effort: "high",
        adapterDefault: false,
    });
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

test("a trigger word matches when it touches Chinese characters", () => {
    const pattern = buildKeywordPattern(["ultracode"]);
    assert.equal(matchesKeyword("用ultracode跑一下", pattern), true);
    assert.equal(matchesKeyword("ultracode", pattern), true);
    assert.equal(matchesKeyword("开启 ULTRAcode 模式", pattern), true);
});

test("a trigger word inside a path or an identifier does not match", () => {
    const pattern = buildKeywordPattern(["ultracode"]);
    assert.equal(matchesKeyword("src/ultracode.ts", pattern), false);
    assert.equal(matchesKeyword("--ultracode", pattern), false);
    assert.equal(matchesKeyword("myultracode", pattern), false);
    assert.equal(matchesKeyword("$ultracode", pattern), false);
});

test("an unrelated word is not a trigger", () => {
    const pattern = buildKeywordPattern(["ultracode"]);
    assert.equal(
        matchesKeyword("我们讨论一下 workflow 的设计", pattern),
        false,
    );
});

test("the keyword matcher is reusable across calls", () => {
    const pattern = buildKeywordPattern(["ultracode"]);
    assert.equal(matchesKeyword("ultracode 一次", pattern), true);
    assert.equal(matchesKeyword("ultracode 再一次", pattern), true);
});

test("no trigger word configured means no match", () => {
    assert.equal(matchesKeyword("ultracode", buildKeywordPattern([])), false);
});

test("the banner names only the script surface the engine provides", () => {
    const banner = buildBanner("level");
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
        for (const reason of ["level", "keyword"]) {
            const text = buildInjection(level, reason);
            for (const forbidden of FORBIDDEN_SCRIPT_NAMES) {
                assert.equal(
                    text.includes(forbidden),
                    false,
                    `${level}/${reason} must not name ${forbidden}`,
                );
            }
        }
    }
});

test("the standing level path carries the escape sentence and the keyword path does not", () => {
    assert.ok(
        buildInstruction("ultra", "level").includes("standing ultracode mode"),
    );
    assert.equal(
        buildInstruction("ultra", "keyword").includes(
            "standing ultracode mode",
        ),
        false,
    );
    assert.equal(buildInstruction("off", "level"), "");
});

test("the reason clause distinguishes the two arming paths", () => {
    assert.ok(buildBanner("keyword").includes("explicit opt-in"));
    assert.ok(buildBanner("level").includes("standing ultracode mode"));
});

test("the injected banner is wrapped in the stable open and close markers", () => {
    for (const reason of ["level", "keyword"]) {
        const banner = buildBanner(reason);
        assert.equal(
            banner.startsWith(`---\n${BANNER_OPEN}`),
            true,
            `the ${reason} banner must open with the marker`,
        );
        assert.equal(
            banner.endsWith(BANNER_CLOSE),
            true,
            `the ${reason} banner must close with the marker`,
        );
    }
    // The block opens before the decision sentence, so the marker wraps the whole
    // banner rather than the reason clause alone.
    assert.equal(BANNER_OPEN, "[workflows mode armed.");
    assert.equal(BANNER_CLOSE, "]");
});

test("the summary the injector writes is the one the fold reads back", () => {
    const keyword = foldBanner("high", "keyword");
    assert.equal(keyword.level, "high");
    assert.equal(keyword.wire.armedTurn, true);
    assert.equal(keyword.wire.keywordArmed, true);

    const byLevel = foldBanner("ultra", "level");
    assert.equal(byLevel.level, "ultra");
    assert.equal(byLevel.wire.armedTurn, true);
    assert.equal(byLevel.wire.keywordArmed, false);
});

test("the injected banner message is frozen all the way down", () => {
    const banner = createBannerMessage(
        "the injected text",
        "dsh-ultracode",
        "ultracode ultra armed this turn (level)",
    );
    assert.equal(Object.isFrozen(banner), true);
    assert.equal(Object.isFrozen(banner.content), true);
    assert.equal(Object.isFrozen(banner.content[0]), true);
    assert.equal(Object.isFrozen(banner.source), true);
});

test("adopting a folded level that differs from the mirror records the divergence", () => {
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
    store.reconcile(session, "ultra");
    assert.deepEqual(store.divergenceOf(session), {
        folded: "ultra",
        mirrored: "off",
    });
});

test("the divergence record is kept once per mirrored level", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    store.adopt(session, "ultra");
    store.reconcile(session, "high");
    assert.deepEqual(store.divergenceOf(session), {
        folded: "high",
        mirrored: "ultra",
    });
    store.reconcile(session, "off");
    assert.deepEqual(
        store.divergenceOf(session),
        { folded: "high", mirrored: "ultra" },
        "the record must not be rewritten while the mirror itself has not moved",
    );
    store.reconcile(session, "high");
    assert.deepEqual(store.divergenceOf(session), {
        folded: "high",
        mirrored: "ultra",
    });
});

test("reconciling a session that was never adopted records nothing", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    store.reconcile(session, "high");
    assert.equal(store.divergenceOf(session), undefined);
});

test("the view reports the folded level over the mirror and passes the rest through", () => {
    const store = new UltracodeStateStore();
    const session = sessionOf("s1");
    store.select(session, "ultra");
    const view = store.viewOf(session, true, "max", "/dsh-ultracode/state", {
        level: "off",
        armedTurn: true,
        keywordArmed: true,
    });
    assert.equal(
        view.level,
        "off",
        "the fold is the authority once a caller supplies it",
    );
    assert.equal(view.armedTurn, true);
    assert.equal(view.keywordArmedTurn, true);
    assert.equal(view.available, true);
    assert.equal(view.modelEffort, "max");
    assert.equal(view.route, "/dsh-ultracode/state");
});
