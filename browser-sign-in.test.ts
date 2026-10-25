// Browser sign-in, in a Pi Pocket of its own, with a real Chromium (skipped without one): a temporary data folder, a
// scripted model, the module in the drop-in folder, and a small sign-in site on this machine.
// Run with POCKET_DIR set to a Pi Pocket 0.22.0 (or later) checkout with its packages installed:
//   POCKET_DIR=~/work/pi-pocket node --test browser-sign-in.test.ts
import assert from "node:assert/strict";
import { cpSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const POCKET = resolve(process.env.POCKET_DIR ?? "../pi-pocket");
// Pi Pocket's test helpers first: they point Pi Pocket at a temporary folder before it loads.
const helpers = await import(join(POCKET, "test", "helpers.ts"));
const { cleanUp, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } =
    helpers;
const { fauxAssistantMessage, fauxText, fauxToolCall } = await import(
    join(POCKET, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "faux.js")
);
const { findBrowser } = await import(join(POCKET, "src", "server", "browser", "discovery.ts"));

type App = Awaited<ReturnType<typeof openApp>>;
type Id = Awaited<ReturnType<typeof newSession>>;

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
};
const PASSWORD = "correct-horse-battery";
const CODE = "482913";
/** Everything the model was sent: no value may be in it. */
const sent: string[] = [];
let base = "";

const call = (name: string, args: Record<string, unknown>) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const model = scriptedModel((request: { messages: unknown[] }) => {
    sent.push(JSON.stringify(request));
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
    }

    if (text.endsWith("open the site")) {
        return call("browser", { action: "navigate", url: `${base}/`, snapshot: true });
    }

    if (text.endsWith("sign me in")) {
        return call("browser_sign_in", {});
    }

    if (text.endsWith("read the password")) {
        return call("browser", {
            action: "evaluate",
            script: "document.querySelector('input[type=password]').value",
        });
    }

    if (text.endsWith("type the password")) {
        return call("browser", {
            action: "type",
            selector: "input[type=password]",
            text: "typed-by-pi",
        });
    }

    if (text.endsWith("type the user")) {
        return call("browser", { action: "type", selector: "#user", text: "typed-by-pi" });
    }

    if (text.endsWith("get the code")) {
        return call("browser_ask_code", { field: "e3", text: "The 6-digit code we texted you" });
    }

    if (text.endsWith("read the code")) {
        return call("browser", {
            action: "evaluate",
            script: "document.querySelector('#code').value",
        });
    }

    if (text.endsWith("solve it")) {
        return call("browser_ask_person", { text: "Solve the CAPTCHA" });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
});

const dataDir = join(root, "data");
let app: App;
let site: Server;

before(async () => {
    if (real.skip !== false) {
        return;
    }

    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "browser-sign-in.ts"), join(dropIns, "browser-sign-in.ts"));
    cpSync(join(import.meta.dirname, "browser-sign-in.js"), join(dropIns, "browser-sign-in.js"));
    site = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
            `<title>Acme sign in</title><form><label for="user">Email</label><input id="user" type="email"><label for="pw">Password</label><input id="pw" type="password"><label for="code">Code</label><input id="code"><button>Sign in</button></form>`,
        );
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    app = await openApp(model, dataDir);
    await app.setExtensionEnabled(owner(app), "browser-sign-in.ts", true);
});

after(async () => {
    site?.close();
    await app?.close();
    cleanUp();
});

/** Send as the owner, and give back how to wait for the run. */
async function submit(id: Id, text: string) {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
    });

    return async () =>
        (await app.harness.submission(submissionId, helpers.context))!.wait(helpers.context);
}

const say = async (id: Id, text: string) => (await submit(id, text))();
const lastSeen = async (id: Id) => (await modelTexts(app, id)).at(-1) ?? "";
const stored = async (id: Id) => JSON.stringify(await app.transcripts.allEntries(id, true));

/** Wait for the session's card, and answer it. */
async function answer(id: Id, allow: boolean, values?: Record<string, string>) {
    await until(() => app.approvals.forConversation(id).length === 1, "the card", 20_000);
    const [card] = app.approvals.forConversation(id);

    await app.answerApproval(card!.id, allow, owner(app), values);

    return card!;
}

let id: Id;

test(
    "browser_sign_in finds the fields, and the person's values go into the page, never to Pi",
    real,
    async () => {
        id = await newSession(app);
        await say(id, "open the site");

        const done = await submit(id, "sign me in");

        await until(() => app.approvals.forConversation(id).length === 1, "the card", 20_000);
        const [card] = app.approvals.forConversation(id);

        assert.deepEqual(
            card!.form?.fields.map((field: { name: string; secret?: boolean }) => [
                field.name,
                field.secret === true,
            ]),
            [
                ["username", false],
                ["password", true],
            ],
        );
        // A plain Allow is not an answer.
        await assert.rejects(app.answerApproval(card!.id, true, owner(app)), { status: 400 });
        await app.answerApproval(card!.id, true, owner(app), {
            username: "tuan@acme.test",
            password: PASSWORD,
        });
        await done();

        const seen = await lastSeen(id);

        assert.match(seen, /filled in the sign-in/);
        assert.match(seen, /tuan@acme\.test/);
        assert.match(seen, /••••/);
        assert.ok(!(await stored(id)).includes(PASSWORD));
        assert.ok(!sent.join("").includes(PASSWORD));
    },
);

test("the password stays hidden when a tool reads it back", real, async () => {
    await say(id, "read the password");

    const seen = await lastSeen(id);

    assert.match(seen, /\[password for 127\.0\.0\.1:\d+\]/);
    assert.ok(!seen.includes(PASSWORD));
});

test(
    "Pi's own browser tool does not type into a password field, and types into others",
    real,
    async () => {
        await say(id, "type the password");
        assert.match(await lastSeen(id), /Pi never types a password/);
        await say(id, "type the user");
        assert.doesNotMatch(await lastSeen(id), /Pi never types a password/);
    },
);

test("browser_ask_code fills the code, and it stays out of what Pi reads", real, async () => {
    await say(id, "open the site");

    const done = await submit(id, "get the code");

    await answer(id, true, { code: CODE });
    await done();
    assert.match(await lastSeen(id), /filled in the code/);
    await say(id, "read the code");
    assert.match(await lastSeen(id), /\[code for 127\.0\.0\.1:\d+\]/);
    assert.ok(!sent.join("").includes(CODE));
});

test("browser_ask_person: Done gives the page; Decline says so", real, async () => {
    let done = await submit(id, "solve it");

    await answer(id, true);
    await done();
    assert.match(await lastSeen(id), /said it is done[\s\S]*The page now/);

    done = await submit(id, "solve it");
    await answer(id, false);
    await done();
    assert.match(await lastSeen(id), /declined/);
});

test("with no page open, the tools say to open one first", real, async () => {
    const fresh = await newSession(app);

    await say(fresh, "sign me in");
    assert.match(await lastSeen(fresh), /No page is open/);
});
