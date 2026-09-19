/**
 * Smoke test for the built client bundle.
 *
 * The browser half is a factory-form CommonJS artifact, and the browser module
 * system is the only thing that normally executes it. This test reproduces the
 * two facts that make it loadable — the loader call at the top and the
 * `apply`/`inject` exports at the bottom — and then runs one real registration
 * against a stub seat registry, so a broken artifact fails here instead of in
 * the browser.
 *
 * It additionally renders the production component with a minimal React runtime
 * and the props the seat really receives. That is what keeps the two behaviours
 * this refactor is about pinned in a test: the control renders something before
 * the host has published a value, and a press goes through the command channel
 * rather than through a private copy of the level.
 *
 * It runs after `npm run build`; `npm run check` orders the two that way.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { en, zh } from "../src/client/locales.ts";
import { ULTRACODE_KEY } from "../src/host/protocol.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(root, "lib/client.js");

/**
 * A React stub that satisfies the hooks the control uses.
 *
 * `useState` is stateful rather than a fixed-return stub, because the component
 * is re-rendered by its own setters: the failure row only exists in a render
 * that follows a refused press, and a setter that does nothing would leave the
 * refusal invisible to every assertion in this file. State is stored by hook
 * position within one render, the way the real runtime stores it, so the slot a
 * setter writes is the slot the next render reads.
 */
function reactStub() {
    const slots = [];
    let cursor = 0;
    let rerender = () => {};
    return {
        useState: (initial) => {
            const slot = cursor;
            cursor += 1;
            if (slots.length <= slot) slots.push(initial);
            return [
                slots[slot],
                (next) => {
                    const value =
                        typeof next === "function" ? next(slots[slot]) : next;
                    const changed = !Object.is(value, slots[slot]);
                    slots[slot] = value;
                    if (changed) rerender();
                },
            ];
        },
        useEffect: () => {},
        useRef: (initial) => ({ current: initial }),
        useCallback: (fn) => fn,
        createElement: (type, props, ...children) => ({
            type,
            props: props ?? {},
            children,
        }),
        // The renderer below drives both of these: it resets the hook cursor before
        // every render so the hooks match their slots by call order, and it receives
        // the render a state change asks for.
        startRender: () => {
            cursor = 0;
        },
        onStateChange: (draw) => {
            rerender = draw;
        },
    };
}

/**
 * Render the production component against a stub React runtime.
 *
 * The returned handle re-renders whenever the component's own state setters
 * fire, so a caller reads `tree` after a press settles and sees the frame that
 * state change produced. The stub is the one the bundle already received: a
 * second stub would give the setters a hook memory the renderer never reads.
 * @param component - the component the seat registration carries.
 * @param react - the stub runtime the bundle's module graph was given.
 * @param build - supplies the props of each render.
 * @returns the rendered tree, kept up to date across re-renders.
 */
function renderControl(component, react, build) {
    const handle = { tree: null };
    const draw = () => {
        react.startRender();
        const produced = component(build());
        // A render never returns an element for a session that cannot carry the
        // control, so a null frame leaves the last live tree in place.
        if (produced !== null) handle.tree = produced;
    };
    react.onStateChange(draw);
    draw();
    return handle;
}

/** Load the built bundle through a stubbed module loader. */
function loadBundle() {
    const source = readFileSync(bundlePath, "utf8");
    let entry = null;
    const context = {
        window: {
            __ModuleLoader__: {
                load(candidate) {
                    entry = candidate;
                },
            },
        },
        document: undefined,
        URL,
        URLSearchParams,
        fetch: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ level: "off" }),
        }),
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    assert.notEqual(
        entry,
        null,
        "the bundle must call window.__ModuleLoader__.load",
    );
    const react = reactStub();
    const exports = entry.factory((id) => {
        if (id === "react") return react;
        // The automatic JSX runtime builds elements through `createElement`, so the
        // stub has to delegate instead of returning nothing: these tests inspect the
        // tree the production component returns.
        if (id === "react/jsx-runtime") {
            return {
                jsx: (type, props) => react.createElement(type, props),
                jsxs: (type, props) => react.createElement(type, props),
                Fragment: Symbol.for("react.fragment"),
            };
        }
        throw new Error(`unexpected require: ${id}`);
    });
    return { entry, exports, react };
}

/**
 * Apply the client half against a stub context and return what it registered.
 * @param options - stubs for the services the client half reads.
 * @returns the recorded registrations plus the context that received them.
 */
function applyClient(options = {}) {
    const { exports, react } = loadBundle();
    const dictionaries = [];
    const seats = [];
    const definitions = [];
    const components = [];
    const ctx = {
        slots: {
            inject(seat, callback) {
                seats.push(seat);
                callback();
            },
            register(definition, component) {
                definitions.push(definition);
                components.push(component);
                return () => {};
            },
        },
        locale: {
            register(namespace, dicts) {
                dictionaries.push({ namespace, dicts });
                return () => {};
            },
        },
        // An explicit `remote` option wins even when it is undefined, so a test can
        // ask for a context with no command channel at all.
        remote:
            "remote" in options
                ? options.remote
                : { commands: { execute: async () => ({ ok: true }) } },
        effect(callback) {
            callback();
            return () => {};
        },
    };
    exports.apply(ctx);
    return {
        exports,
        react,
        ctx,
        dictionaries,
        seats,
        definitions,
        definition: definitions[0],
        component: components[0],
    };
}

/** Walk a React element tree and collect its text. */
function textOf(node) {
    if (node === null || node === undefined || typeof node === "boolean")
        return "";
    if (typeof node === "string" || typeof node === "number")
        return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (typeof node === "object")
        return textOf(node.props?.children ?? node.children ?? []);
    return "";
}

/** Find the first element of one tag in a React element tree. */
function findTag(node, tag) {
    if (node === null || node === undefined || typeof node !== "object")
        return null;
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findTag(child, tag);
            if (found !== null) return found;
        }
        return null;
    }
    if (node.type === tag) return node;
    return findTag(node.props?.children ?? node.children ?? [], tag);
}

/** Find the first element carrying one ARIA role in a React element tree. */
function findRole(node, role) {
    if (node === null || node === undefined || typeof node !== "object")
        return null;
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findRole(child, role);
            if (found !== null) return found;
        }
        return null;
    }
    if (node.props?.role === role) return node;
    return findRole(node.props?.children ?? node.children ?? [], role);
}

/**
 * Render the production control with the props a seat really receives.
 *
 * The component comes from the seat registration itself, which is the only
 * handle the browser module system gets; nothing is exported for the test's
 * convenience.
 * @param injected - the value the seat entry injected for one session.
 * @param options - extra props, such as a published projection value, and how
 * to build the client context.
 * @returns the render handle plus the button, text and failure row it contains.
 */
function renderChip(injected, options = {}) {
    const { component, react } = applyClient(options);
    assert.equal(
        typeof component,
        "function",
        "the seat registration must carry a component",
    );
    const handle = renderControl(component, react, () => ({
        sessionId: "session-1",
        // The key-echoing default is what makes a wrong dictionary key visible in a
        // text assertion; a test that cares about real copy passes its own `t`.
        t: (key) => key,
        useSession: (selector) =>
            selector({ removed: false, subagent: undefined }),
        ...injected,
        ...options.props,
    }));
    return {
        get tree() {
            return handle.tree;
        },
        get button() {
            return findTag(handle.tree, "button");
        },
        get alert() {
            return findRole(handle.tree, "alert");
        },
        get text() {
            return textOf(handle.tree);
        },
    };
}

/**
 * Press the control and wait until the press has settled.
 *
 * The compiled handler starts the press and returns immediately, so awaiting
 * the click waits for nothing. The chip disables itself while a change is in
 * flight, which makes the re-enabled button the observable end of one press.
 * @param chip - the rendered control.
 */
async function press(chip) {
    chip.button.props.onClick();
    for (let turn = 0; turn < 100; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        if (chip.button?.props.disabled === false) return;
    }
    assert.fail("the press never settled");
}

/** The props the seat entry injects for one session, read from the bundle. */
function injectedProps() {
    const { definition } = applyClient();
    return { injected: definition.inject("session-1") };
}

test(
    "the built client bundle registers itself under the package id",
    { skip: !existsSync(bundlePath) },
    () => {
        const { entry, exports } = loadBundle();
        assert.equal(entry.id, "@dessera/dsh-ultracode");
        assert.equal(typeof exports.apply, "function");
        assert.ok(Array.isArray(exports.inject));
        assert.ok(exports.inject.includes("slots"));
        assert.ok(exports.inject.includes("locale"));
        // The write path needs the command channel; it is provided by the API-remotes
        // client entry, which the module graph loads before plugin entries.
        assert.ok(exports.inject.includes("remote.commands"));
    },
);

test(
    "applying the client half registers one dictionary and one composer seat",
    { skip: !existsSync(bundlePath) },
    () => {
        const { dictionaries, seats, definitions, definition } = applyClient();
        assert.equal(dictionaries.length, 1);
        assert.equal(dictionaries[0].namespace, "ultracode");
        assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), [
            "en",
            "zh",
        ]);
        // The two dictionaries must cover exactly the same keys; a missing key would
        // fall back to the raw key text in one language only.
        assert.deepEqual(
            Object.keys(dictionaries[0].dicts.zh).sort(),
            Object.keys(dictionaries[0].dicts.en).sort(),
        );
        // The bundle was built from the same dictionary module the browser half reads,
        // so the copy it registers must still carry those exact strings. The bundle's
        // object comes from another realm, so its fields are compared as entries.
        assert.deepEqual(
            Object.entries(dictionaries[0].dicts.zh),
            Object.entries(zh),
        );
        assert.deepEqual(
            Object.entries(dictionaries[0].dicts.en),
            Object.entries(en),
        );
        assert.deepEqual(seats, ["conversation.input.right"]);
        assert.equal(definitions.length, 1);
        assert.equal(definition.name, "conversation.input.right");
        assert.equal(definition.locale, "ultracode");
        const injected = definition.inject("session-1");
        assert.equal(typeof injected.changeLevel, "function");
        assert.equal(injected.sessionId, "session-1");
        // The private read and write helpers of the old design are gone: reading is
        // the projection's job and writing is the command channel's.
        assert.equal("readState" in injected, false);
        assert.equal("changeState" in injected, false);
    },
);

test(
    "the control renders the level the host published",
    { skip: !existsSync(bundlePath) },
    () => {
        const { injected } = injectedProps();
        const { button, text } = renderChip(injected, {
            props: {
                useProjection: () => ({
                    level: "ultra",
                    armedTurn: false,
                    keywordArmed: false,
                    revision: 2,
                }),
            },
        });
        assert.equal(text, "chip.ultra");
        assert.equal(button.props["aria-pressed"], true);
        assert.equal(button.props.disabled, false);
    },
);

test(
    "the control renders a connecting state instead of nothing before a value arrives",
    { skip: !existsSync(bundlePath) },
    () => {
        const { injected } = injectedProps();
        const { tree, button, text } = renderChip(injected, {
            props: { useProjection: () => undefined },
        });
        assert.notEqual(
            tree,
            null,
            "the control must never render nothing for a live session",
        );
        assert.equal(text, "chip.connecting");
        assert.equal(button.props["aria-pressed"], false);
        // A press is still allowed: the first press asks the host for the next level
        // from off, which is a well-defined request rather than a guess.
        assert.equal(button.props.disabled, false);
    },
);

test(
    "the control disappears for a removed session and for a delegated child",
    { skip: !existsSync(bundlePath) },
    () => {
        const { injected } = injectedProps();
        const removed = renderChip(injected, {
            props: { useSession: (selector) => selector({ removed: true }) },
        });
        assert.equal(removed.tree, null);
        const subagent = renderChip(injected, {
            props: {
                useSession: (selector) => selector({ subagent: "parent-1" }),
            },
        });
        assert.equal(subagent.tree, null);
    },
);

test(
    "a press asks the host to run the command rather than writing state",
    { skip: !existsSync(bundlePath) },
    async () => {
        const calls = [];
        const { definition } = applyClient({
            remote: {
                commands: {
                    execute: async (sessionId, line, attachments) => {
                        calls.push({ sessionId, line, attachments });
                        return { ok: true };
                    },
                },
            },
        });
        const injected = definition.inject("session-1");
        const { button } = renderChip(injected, {
            props: {
                useProjection: () => ({
                    level: "high",
                    armedTurn: false,
                    keywordArmed: false,
                    revision: 1,
                }),
            },
        });
        await button.props.onClick();
        // The reply and its attachment list cross a VM boundary, so the assertion is
        // structural rather than a deep-equal against a value from this realm.
        assert.equal(calls.length, 1);
        assert.equal(calls[0].sessionId, "session-1");
        assert.equal(calls[0].line, "/ultracode ultra");
        assert.equal(Array.from(calls[0].attachments).length, 0);
    },
);

test(
    "the control reads the published value under the projection key it declared",
    { skip: !existsSync(bundlePath) },
    () => {
        const { injected } = injectedProps();
        const asked = [];
        const chip = renderChip(injected, {
            props: {
                // The hook only answers for the key this plugin publishes under, and it
                // records every key it was asked for, so a read under any other key shows
                // up as an empty list rather than as a silently empty projection.
                useProjection: (key) => {
                    asked.push(key);
                    if (key !== ULTRACODE_KEY) return undefined;
                    return {
                        level: "ultra",
                        armedTurn: false,
                        keywordArmed: false,
                        revision: 3,
                    };
                },
            },
        });
        // The literal is the key the harness's projection registry is told to publish
        // under, and the protocol module must agree with it. A browser half that reads
        // any other key gets no answer from this hook, so its chip stays connecting.
        assert.deepEqual(asked, ["ultracode"]);
        assert.equal(ULTRACODE_KEY, "ultracode");
        assert.equal(chip.text, "chip.ultra");
    },
);

test(
    "a refused command shows the host message and leaves the chip on the published level",
    { skip: !existsSync(bundlePath) },
    async () => {
        const { definition } = applyClient({
            remote: {
                commands: {
                    execute: async () => ({
                        ok: false,
                        error: {
                            code: "unavailable",
                            message: "no workflow tool here",
                        },
                    }),
                },
            },
        });
        const injected = definition.inject("session-1");
        const rendered = renderChip(injected, {
            props: {
                useProjection: () => ({
                    level: "off",
                    armedTurn: false,
                    keywordArmed: false,
                    revision: 1,
                }),
                t: (key) => en[key] ?? key,
            },
        });
        assert.equal(
            rendered.alert,
            null,
            "a chip that has not failed yet has no failure row",
        );
        // The click handler starts the press and returns, so the refusal arrives only
        // after the command has settled and re-rendered the chip.
        await press(rendered);
        // The refusal reaches the screen as the host's own words, and the chip itself
        // still shows the level the projection published: a refused change moves
        // neither the level nor the button's accessible name.
        assert.equal(textOf(rendered.alert), "no workflow tool here");
        // The button's own text is what the level publishes; the failure row sits
        // beside it rather than replacing it.
        assert.equal(textOf(rendered.button), "Ultracode off");
        assert.equal(rendered.button.props["aria-label"], en["chip.aria.off"]);
        assert.equal(rendered.button.props["aria-pressed"], false);
    },
);

test(
    "the real dictionaries reach the chip as its label, title and accessible name",
    { skip: !existsSync(bundlePath) },
    () => {
        const { injected } = injectedProps();
        const expected = {
            off: {
                text: zh["chip.off"],
                aria: zh["chip.aria.off"],
                title: zh["chip.title.off"],
                pressed: false,
                disabled: false,
            },
            high: {
                text: zh["chip.high"],
                aria: zh["chip.aria.high"],
                title: zh["chip.title.high"],
                pressed: true,
                disabled: false,
            },
            ultra: {
                text: zh["chip.ultra"],
                aria: zh["chip.aria.ultra"],
                title: zh["chip.title.ultra"],
                pressed: true,
                disabled: false,
            },
            connecting: {
                text: zh["chip.connecting"],
                aria: zh["chip.aria.connecting"],
                title: zh["chip.title.connecting"],
                pressed: false,
                disabled: false,
            },
        };
        for (const [state, want] of Object.entries(expected)) {
            const published =
                state === "connecting"
                    ? undefined
                    : {
                          level: state,
                          armedTurn: false,
                          keywordArmed: false,
                          revision: 1,
                      };
            const chip = renderChip(injected, {
                props: {
                    useProjection: () => published,
                    t: (key) => zh[key] ?? key,
                },
            });
            assert.equal(
                chip.text,
                want.text,
                `${state} must show its own label`,
            );
            assert.equal(
                chip.button.props["aria-label"],
                want.aria,
                `${state} must name its own next level`,
            );
            assert.equal(
                chip.button.props.title,
                want.title,
                `${state} must tooltip its own next level`,
            );
            assert.equal(
                chip.button.props["aria-pressed"],
                want.pressed,
                `${state} must report its own armed state`,
            );
            assert.equal(
                chip.button.props.disabled,
                want.disabled,
                `${state} must stay pressable`,
            );
        }
    },
);

test(
    "a chip whose dictionary answers nothing falls back to its own copy",
    { skip: !existsSync(bundlePath) },
    () => {
        const { injected } = injectedProps();
        const published = () => ({
            level: "high",
            armedTurn: false,
            keywordArmed: false,
            revision: 1,
        });
        // The copy can go missing in two ways, and both land on the fallback table:
        // a locale registry with no entry for a key answers undefined for it, while
        // a host that composed this seat without the plugin's namespace registered
        // leaves `t` absent altogether.
        const cases = [
            [
                "no entry for the key",
                renderChip(injected, {
                    props: { useProjection: published, t: () => undefined },
                }),
            ],
            [
                "no translate seat",
                renderChip(injected, {
                    props: { useProjection: published, t: undefined },
                }),
            ],
        ];
        for (const [label, chip] of cases) {
            assert.equal(chip.text, "Ultracode high", label);
            assert.equal(
                chip.button.props["aria-label"],
                "Ultracode level high, press to switch to ultra",
                label,
            );
            assert.equal(
                chip.button.props.title,
                "Ultracode level: high — click for ultra",
                label,
            );
        }
    },
);

test(
    "an armed turn shows the trigger-word badge and the pressed state",
    { skip: !existsSync(bundlePath) },
    () => {
        const { injected } = injectedProps();
        const armed = renderChip(injected, {
            props: {
                useProjection: () => ({
                    level: "ultra",
                    armedTurn: true,
                    keywordArmed: true,
                    revision: 4,
                }),
                t: (key) => zh[key] ?? key,
            },
        });
        assert.equal(armed.text, `${zh["chip.ultra"]}${zh["chip.armed"]}`);
        assert.equal(armed.button.props["aria-pressed"], true);
        // The trigger word is a reason for the badge, not a second arming signal: a
        // turn banner the level itself armed carries no badge.
        const levelArmed = renderChip(injected, {
            props: {
                useProjection: () => ({
                    level: "ultra",
                    armedTurn: true,
                    keywordArmed: false,
                    revision: 4,
                }),
                t: (key) => zh[key] ?? key,
            },
        });
        assert.equal(levelArmed.text, zh["chip.ultra"]);
    },
);

test(
    "the seat registers as its own list entry and each press asks for the next level",
    { skip: !existsSync(bundlePath) },
    async () => {
        const lines = [];
        const { definition } = applyClient({
            remote: {
                commands: {
                    execute: async (sessionId, line) => {
                        lines.push(line);
                        return { ok: true };
                    },
                },
            },
        });
        // The seat kind is the composer's `list`, so the registration carries the
        // identity and the position that keep this entry distinct from the others.
        assert.equal(definition.id, "dsh-ultracode");
        assert.equal(definition.order, 20);
        assert.equal(definition.name, "conversation.input.right");
        const injected = definition.inject("session-1");
        const published = {
            off: {
                level: "off",
                armedTurn: false,
                keywordArmed: false,
                revision: 1,
            },
            ultra: {
                level: "ultra",
                armedTurn: false,
                keywordArmed: false,
                revision: 2,
            },
            connecting: undefined,
        };
        for (const state of ["off", "ultra", "connecting"]) {
            const rendered = renderChip(injected, {
                props: { useProjection: () => published[state] },
            });
            await press(rendered);
        }
        assert.deepEqual(lines, [
            "/ultracode high",
            "/ultracode off",
            "/ultracode high",
        ]);
    },
);

test(
    "a session without the command channel renders a disabled control",
    { skip: !existsSync(bundlePath) },
    () => {
        const { definition } = applyClient({ remote: undefined });
        const injected = definition.inject("session-1");
        const { component, react } = applyClient({ remote: undefined });
        const handle = renderControl(component, react, () => ({
            sessionId: "session-1",
            t: (key) => key,
            useSession: (selector) =>
                selector({ removed: false, subagent: undefined }),
            useProjection: () => undefined,
            ...injected,
        }));
        const button = findTag(handle.tree, "button");
        assert.equal(textOf(handle.tree), "chip.connecting");
        assert.equal(
            button.props.disabled,
            true,
            "a control with no write channel must refuse presses",
        );
    },
);
