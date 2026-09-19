/**
 * Tests for the host notice dictionary.
 *
 * The host prints these strings verbatim, so a broken notice reaches a person
 * with nothing in between. The assertions here pin what a reader depends on:
 * a usage or unknown-level notice names the words the command really accepts,
 * the three level notices stay tellable apart, and the status line answers
 * every flag it is handed instead of collapsing into one sentence. Both
 * languages are exercised, since a dictionary nobody reads is a dictionary
 * nobody notices breaking.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { NOTICES } from "../src/host/notices.ts";
import { LEVELS, LEVEL_WORDS, levelLabel } from "../src/host/protocol.ts";

const LANGUAGES = ["zh", "en"];

for (const language of LANGUAGES) {
    test(`the ${language} usage line names every level word the command accepts`, () => {
        const { usage } = NOTICES[language];
        // Word boundaries, because `ultra` is also a substring of "ultracode"
        // itself, so a plain containment test for that word would pass on a usage
        // line that had silently dropped it.
        for (const word of LEVEL_WORDS.split(" | ")) {
            assert.match(
                usage,
                new RegExp(`\\b${word}\\b`),
                `${language} usage must name ${word}`,
            );
        }
        assert.ok(
            usage.includes(LEVEL_WORDS),
            `${language} usage must quote the vocabulary`,
        );
    });

    test(`the ${language} level notices are non-empty and mutually distinct`, () => {
        const levelNotices = [
            NOTICES[language].levelOff,
            NOTICES[language].levelHigh,
            NOTICES[language].levelUltra,
        ];
        for (const notice of levelNotices) {
            assert.ok(
                notice.trim().length > 0,
                `${language} level notice is blank`,
            );
        }
        assert.equal(
            new Set(levelNotices).size,
            3,
            `${language} level notices collide`,
        );
    });

    test(`the ${language} status line separates an available tool from an unavailable one`, () => {
        const { status } = NOTICES[language];
        const level = levelLabel("ultra", language);
        assert.notEqual(status(level, true), status(level, false));
    });

    test(`the ${language} status line reports the level it was handed`, () => {
        const level = levelLabel("high", language);
        assert.ok(NOTICES[language].status(level, false).includes(level));
    });

    // Pinned word for word, because the checks above read differences: a field
    // whose two words are simply exchanged, or a reworded sentence, still
    // differs from its neighbours and only a golden string notices.
    test(`the ${language} status line reads a call out word for word`, () => {
        const expected = {
            zh: "Ultracode 档位：极致；workflow 工具：可见。",
            en: "Ultracode level: ultra; workflow tool: visible.",
        };
        assert.equal(
            NOTICES[language].status(levelLabel("ultra", language), true),
            expected[language],
        );
    });

    test(`the ${language} unknown-level notice echoes the refused word`, () => {
        assert.ok(NOTICES[language].unknownLevel("turbo").includes("turbo"));
    });

    test(`the ${language} unknown-level notice offers the levels that would work`, () => {
        const notice = NOTICES[language].unknownLevel("turbo");
        for (const level of LEVELS) {
            assert.ok(
                notice.includes(levelLabel(level, language)),
                `${language} omits ${level}`,
            );
        }
    });

    test(`the ${language} unavailable notice names the workflow tool`, () => {
        assert.ok(
            NOTICES[language].unavailable.toLowerCase().includes("workflow"),
        );
    });
}
