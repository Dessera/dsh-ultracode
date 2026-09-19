/**
 * Every notice the plugin prints to the user.
 *
 * These strings are user-facing output, so they live in one module rather than
 * being spread across whichever code path happens to need them. The host entry
 * renders them and nothing else; the browser half has its own dictionary,
 * because a notice the host prints and a label the chip shows are different
 * surfaces even when they describe the same level.
 *
 * `usage` names the level vocabulary through {@link LEVEL_WORDS}; the
 * unknown-level notice spells the available levels out in its own sentence.
 *
 * @module @dessera/dsh-ultracode/notices
 */
import { LEVEL_WORDS } from "./protocol.ts";

/** One language's notice set. */
export interface NoticeTemplates {
    readonly usage: string;
    readonly unknownLevel: (word: string) => string;
    readonly unavailable: string;
    readonly levelOff: string;
    readonly levelHigh: string;
    readonly levelUltra: string;
    readonly status: (level: string, available: boolean) => string;
}

/** Every notice the plugin prints, keyed by the configured language. */
export const NOTICES: Record<"zh" | "en", NoticeTemplates> = {
    zh: {
        usage: `用法：/ultracode ${LEVEL_WORDS}，或 /ultracode status。`,
        unknownLevel: (word) =>
            `未知档位「${word}」。可用的档位是：关闭、高阶、极致。`,
        unavailable:
            "当前会话看不到 workflow 工具，因此无法开启 ultracode。请切换到包含该工具的 preset。",
        levelOff: "Ultracode 档位已关闭：本会话不再注入编排授权。",
        levelHigh: "Ultracode 档位已切到高阶：实质性任务将自动编排。",
        levelUltra: "Ultracode 档位已切到极致：实质性任务将大面积展开。",
        status: (level, available) =>
            `Ultracode 档位：${level}；workflow 工具：${available ? "可见" : "不可见"}。`,
    },
    en: {
        usage: `Usage: /ultracode ${LEVEL_WORDS}, or /ultracode status.`,
        unknownLevel: (word) =>
            `Unknown level "${word}". Available levels: off, high, ultra.`,
        unavailable:
            "This session cannot see the workflow tool, so ultracode cannot be armed here. Switch to a preset that includes it.",
        levelOff:
            "Ultracode level is off: this session stops arming turns.",
        levelHigh:
            "Ultracode level is high: substantive tasks are armed for orchestration.",
        levelUltra:
            "Ultracode level is ultra: substantive tasks fan out widely.",
        status: (level, available) =>
            `Ultracode level: ${level}; workflow tool: ${available ? "visible" : "not visible"}.`,
    },
};
