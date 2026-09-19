/**
 * Every notice the plugin prints to the user.
 *
 * These strings are user-facing output, so they live in one module rather than
 * being spread across whichever code path happens to need them. The host entry
 * renders them and nothing else; the browser half has its own dictionary,
 * because a notice the host prints and a label the chip shows are different
 * surfaces even when they describe the same level.
 *
 * `usage` and `unknownLevel` name the level vocabulary through
 * {@link LEVEL_WORDS}, so the words a person may type are stated in exactly one
 * place.
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
    readonly cleared: string;
    readonly status: (
        level: string,
        keyword: boolean,
        armed: boolean,
        available: boolean,
    ) => string;
}

/** Every notice the plugin prints, keyed by the configured language. */
export const NOTICES: Record<"zh" | "en", NoticeTemplates> = {
    zh: {
        usage: `用法：/ultracode ${LEVEL_WORDS}，或 /ultracode status。`,
        unknownLevel: (word) =>
            `未知档位「${word}」。可用的档位是：关闭、高阶、极致。`,
        unavailable:
            "当前会话看不到 workflow 工具，因此无法开启 ultracode。请切换到包含该工具的 preset。",
        levelOff:
            "Ultracode 档位已关闭：本会话不再注入编排授权，推理强度恢复原值。",
        levelHigh:
            "Ultracode 档位已切到高阶：实质性任务将自动编排，推理强度提到该模型的最强档。",
        levelUltra:
            "Ultracode 档位已切到极致：实质性任务将大面积展开，推理强度提到该模型的最强档。",
        cleared: "已清除本会话的武装标记。",
        status: (level, keyword, armed, available) =>
            `Ultracode 档位：${level}；关键词触发：${keyword ? "开" : "关"}；本轮武装：${armed ? "是" : "否"}；workflow 工具：${available ? "可见" : "不可见"}。`,
    },
    en: {
        usage: `Usage: /ultracode ${LEVEL_WORDS}, or /ultracode status.`,
        unknownLevel: (word) =>
            `Unknown level "${word}". Available levels: off, high, ultra.`,
        unavailable:
            "This session cannot see the workflow tool, so ultracode cannot be armed here. Switch to a preset that includes it.",
        levelOff:
            "Ultracode level is off: this session stops arming turns and the reasoning effort is restored.",
        levelHigh:
            "Ultracode level is high: substantive tasks are armed for orchestration and reasoning is at its strongest.",
        levelUltra:
            "Ultracode level is ultra: substantive tasks fan out widely and reasoning is at its strongest.",
        cleared: "The armed marker for this session is cleared.",
        status: (level, keyword, armed, available) =>
            `Ultracode level: ${level}; keyword trigger: ${keyword ? "on" : "off"}; this turn armed: ${armed ? "yes" : "no"}; workflow tool: ${available ? "visible" : "not visible"}.`,
    },
};
