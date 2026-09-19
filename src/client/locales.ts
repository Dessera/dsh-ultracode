/**
 * Dictionary namespace owned by this plugin.
 * @module @dessera/dsh-ultracode/client/locales
 */
export const NS = "ultracode";

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
    "chip.off": "Ultracode 关闭",
    "chip.high": "Ultracode 高阶",
    "chip.ultra": "Ultracode 极致",
    "chip.connecting": "Ultracode 连接中",
    "chip.aria.off": "Ultracode 档位关闭，按下切到高阶",
    "chip.aria.high": "Ultracode 档位为高阶，按下切到极致",
    "chip.aria.ultra": "Ultracode 档位为极致，按下关闭",
    "chip.aria.connecting": "Ultracode 尚未收到宿主状态，按下按当前档位切换",
    "chip.title.off": "Ultracode 档位：关闭 — 点击切到高阶",
    "chip.title.high": "Ultracode 档位：高阶 — 点击切到极致",
    "chip.title.ultra": "Ultracode 档位：极致 — 点击关闭",
    "chip.title.connecting":
        "尚未收到宿主发布的档位，点击等同于执行一次 /ultracode 命令",
    "chip.busy": "正在应用…",
    "error.action": "切换 Ultracode 档位失败",
} as const;

/**
 * The key union of this plugin's dictionary.
 *
 * The Chinese dictionary is the source of truth for the key set. This alias is
 * what `./contract.ts` merges into the harness's locale-namespace table under
 * this plugin's namespace, which is what makes the seat's `t` seat
 * and the locale registration narrow to real keys: `tsc` rejects a key one
 * language has and the other lacks, and rejects a registration that leaves out a
 * locale the harness ships.
 */
export type UltracodeKey = keyof typeof zh;

/** English dictionary, checked complete against the zh key set. */
export const en = {
    "chip.off": "Ultracode off",
    "chip.high": "Ultracode high",
    "chip.ultra": "Ultracode ultra",
    "chip.connecting": "Ultracode connecting",
    "chip.aria.off": "Ultracode level off, press to switch to high",
    "chip.aria.high": "Ultracode level high, press to switch to ultra",
    "chip.aria.ultra": "Ultracode level ultra, press to turn off",
    "chip.aria.connecting":
        "No host state received yet; pressing advances from the current level",
    "chip.title.off": "Ultracode level: off — click for high",
    "chip.title.high": "Ultracode level: high — click for ultra",
    "chip.title.ultra": "Ultracode level: ultra — click to turn off",
    "chip.title.connecting":
        "The host has not published a level yet; a click runs one /ultracode command",
    "chip.busy": "Applying…",
    "error.action": "Could not change the Ultracode level",
} as const;
