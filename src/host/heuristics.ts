/**
 * Substantive-message and trigger-word heuristics.
 *
 * Both judgements are pure functions over the text a user submitted, so they
 * are unit-testable without a host. Their thresholds are stated in units that
 * survive Chinese: a Latin-character count is the wrong yardstick for
 * languages where a complete request fits in a dozen glyphs.
 *
 * @module @dessera/dsh-ultracode/heuristics
 */

/**
 * Weighted length at or above which a message counts as a work request.
 *
 * One CJK ideograph, kana, or Hangul syllable weighs 1; one Latin letter or
 * digit weighs 0.25, i.e. four letters weigh as much as one glyph. Sixteen
 * weighted units is the threshold, which is four CJK glyphs — short enough
 * that "帮我重构一下这个模块" (10 glyphs) arms, and long enough that "你好" and
 * "thanks" do not.
 */
export const SUBSTANTIVE_WEIGHT_THRESHOLD = 16;

/** Weight contributed by one CJK glyph or kana character. */
const CJK_WEIGHT = 1;

/**
 * Weighted length a short request still needs before a work verb alone makes
 * it substantive. Three glyphs admits "重构它" and still refuses "改" alone,
 * which is too little context to decide anything about.
 */
const MINIMUM_WORK_VERB_WEIGHT = 3;

/** Weight contributed by one letter, digit, or other word character. */
const WORD_WEIGHT = 0.25;

/** Matches one CJK ideograph, kana character, or Hangul syllable. */
const CJK_PATTERN =
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

/** Matches one Latin letter, digit, or underscore. */
const WORD_PATTERN = /[A-Za-z0-9_]/;

/**
 * Matches a request that names an action on the user's project rather than a
 * question or a remark. The list is intentionally short: it exists to keep the
 * banner out of small talk, not to classify intent.
 */
const WORK_VERB_PATTERN =
    /(重构|实现|新增|添加|编写|写一下|写一个|写个|修复|排查|定位|调研|分析|审查|评审|优化|迁移|升级|补全|改造|生成|整理|文档|测试|单测|梳理|设计|搭建|部署|接入|排查|refactor|implement|migrate|optimi[sz]e|fix|debug|investigate|analy[sz]e|review|design|write|build|add|create|generate|document|test)/iu;

/** Matches a question shape, which is almost never a request to do work. */
const QUESTION_PATTERN =
    /[?？]|^(请问|能否|是否|是不是|为什么|怎么|如何|what|why|how|can you|could you|is it|are there|does )/iu;

/** Matches a slash command line, which the command registry handles itself. */
const SLASH_PREFIX_PATTERN = /^\s*\//u;

/**
 * Measure one string in weighted units, where a CJK glyph counts fully and
 * four Latin letters count once.
 * @param text - the string to measure.
 * @returns the weighted length.
 */
export function weightedLength(text: string): number {
    let weight = 0;
    for (const character of text) {
        if (CJK_PATTERN.test(character)) weight += CJK_WEIGHT;
        else if (WORD_PATTERN.test(character)) weight += WORD_WEIGHT;
    }
    return weight;
}

/**
 * Decide whether one message is a request to do work that a multi-agent
 * orchestration could plausibly serve.
 *
 * The decision is a cheap heuristic on purpose. When it says yes, the model
 * still decides whether to call the workflow tool; the banner it receives says
 * so explicitly. What this function must avoid is arming a turn for a greeting,
 * a question, or a slash command.
 * @param text - the message text exactly as the user typed it.
 * @returns whether the message is substantive.
 */
export function isSubstantiveRequest(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed === "") return false;
    if (SLASH_PREFIX_PATTERN.test(trimmed)) return false;
    const weight = weightedLength(trimmed);
    if (
        QUESTION_PATTERN.test(trimmed) &&
        weight < SUBSTANTIVE_WEIGHT_THRESHOLD * 2
    )
        return false;
    if (weight >= SUBSTANTIVE_WEIGHT_THRESHOLD) return true;
    return (
        WORK_VERB_PATTERN.test(trimmed) && weight >= MINIMUM_WORK_VERB_WEIGHT
    );
}

/**
 * Escape one trigger word for use inside a regular expression.
 * @param word - the configured trigger word.
 * @returns the word with regular-expression metacharacters escaped.
 */
function escapeRegExp(word: string): string {
    return word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Build the trigger-word matcher for the configured words.
 *
 * The boundaries deliberately exclude only the characters that would make a
 * match an accident of a path, flag, or variable name: a slash, a backslash, a
 * dollar sign, and a hyphen. CJK ideographs carry the Unicode `ID_Continue`
 * property, so a boundary built from that property would refuse the ordinary
 * Chinese spelling "用ultracode跑一下"; this matcher accepts a trigger word
 * directly against a CJK glyph and refuses it inside a path or an identifier.
 * @param keywords - configured trigger words; empty entries are dropped.
 * @returns a global, case-insensitive matcher, or undefined when no word is configured.
 */
export function buildKeywordPattern(
    keywords: readonly string[],
): RegExp | undefined {
    const words = keywords
        .map((word) => word.trim())
        .filter((word) => word !== "")
        .map(escapeRegExp);
    if (words.length === 0) return undefined;
    const alternation = words.join("|");
    return new RegExp(
        `(?:^|[^\\w/\\\\$-])(?:${alternation})(?![\\w$-])`,
        "giu",
    );
}

/**
 * Test one message for a configured trigger word.
 * @param text - the message text.
 * @param pattern - the matcher built by {@link buildKeywordPattern}.
 * @returns whether a trigger word occurs in the text.
 */
export function matchesKeyword(
    text: string,
    pattern: RegExp | undefined,
): boolean {
    if (pattern === undefined) return false;
    pattern.lastIndex = 0;
    return pattern.test(text);
}
