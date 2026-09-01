/**
 * swarm_api.mjs - a headless CLI/module for driving SwarmUI's HTTP + WebSocket API.
 *
 * Zero dependencies. Requires Node >= 22 (global `fetch` and `WebSocket`). This box runs
 * Node 25.
 *
 * PORT RULE: a running server's port is NOT necessarily the SwarmUI source default of
 * 7801. Read `Port:` out of `Data/Settings.fds` to find the real one - on this box that is
 * 8085, which is why this script's CLI default (below) is 8085, not 7801. That default is
 * only a convenience for this box; on any other machine, re-check `Settings.fds` (or ask
 * the user) and pass `--url` explicitly rather than trusting either hardcoded number.
 *
 * SAFETY: only read-only/inspection routes (GetCurrentStatus, ListT2IParams, and the like)
 * should ever be run against a real/live server. Anything that mutates state - generating
 * images, changing settings, touching backends or models - should be aimed at a throwaway
 * server instead, e.g.:
 *   dotnet src/bin/Release/net8.0/SwarmUI.dll --launch_mode none --data_dir <tmp> --port <n>
 *
 * CLI usage:
 *   node tools/swarm_api.mjs [--url http://localhost:8085] [--ws] <Route> ['<json body>']
 *
 * Examples:
 *   node tools/swarm_api.mjs GetCurrentStatus
 *   node tools/swarm_api.mjs --url http://localhost:7895 ListT2IParams '{"compact":true}'
 *   node tools/swarm_api.mjs --ws GenerateText2ImageWS '{"prompt":"test","images":1}'
 *
 * The script POSTs `{}` to `<url>/API/GetNewSession`, takes `session_id` from the reply,
 * merges it into the request body, and POSTs `<url>/API/<Route>` with that body (see
 * docs/API.md lines 17-47 for the full session/error contract). If a call comes back with
 * `error_id == "invalid_session_id"`, a new session is fetched once and the call is retried.
 *
 * WebSocket routes carry a `WS` suffix (docs/API.md:13) - this script never adds or strips
 * it, the route is passed through exactly as given on the command line.
 *
 * Also usable as an ES module:
 *   import { getSession, call, callWs } from "./tools/swarm_api.mjs";
 */

import { pathToFileURL } from "node:url";

/**
 * Requests a fresh session from the server.
 * @param {string} url Base server URL, e.g. "http://localhost:8085".
 * @returns {Promise<object>} The parsed JSON response, including `session_id`.
 */
export async function getSession(url) {
    let response = await fetch(`${url}/API/GetNewSession`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
    });
    let data = await response.json();
    if (!response.ok || data.error) {
        throw new Error(`GetNewSession failed: ${response.status} ${JSON.stringify(data)}`);
    }
    return data;
}

/**
 * Calls a standard (non-websocket) API route, handling session acquisition and one retry
 * on an expired/invalid session.
 * @param {string} url Base server URL, e.g. "http://localhost:8085".
 * @param {string} route API route name, eg "GetCurrentStatus".
 * @param {object} body Request body (without `session_id` - it is added automatically).
 * @returns {Promise<object>} The parsed JSON response.
 */
export async function call(url, route, body) {
    let session = await getSession(url);
    let result = await doCall(url, route, body, session.session_id);
    if (result.data.error_id == "invalid_session_id") {
        session = await getSession(url);
        result = await doCall(url, route, body, session.session_id);
    }
    if (!result.response.ok || result.data.error || result.data.error_id) {
        let message = result.data.error ? result.data.error : (result.data.error_id ? result.data.error_id : `HTTP ${result.response.status}`);
        throw new Error(message);
    }
    return result.data;
}

/**
 * Performs one raw POST to an API route with a session ID injected into the body.
 * @param {string} url Base server URL.
 * @param {string} route API route name.
 * @param {object} body Request body without `session_id`.
 * @param {string} sessionId Session ID to inject.
 * @returns {Promise<{response: Response, data: object}>} The fetch response and parsed JSON.
 */
async function doCall(url, route, body, sessionId) {
    let fullBody = Object.assign({}, body, { session_id: sessionId });
    let response = await fetch(`${url}/API/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fullBody)
    });
    let data = await response.json();
    return { response: response, data: data };
}

/**
 * Calls a websocket API route (a route with a `WS` suffix). Opens the socket, sends the
 * body (with a fresh `session_id` injected) on open, and invokes `onFrame` for each
 * received message. Resolves when the socket closes cleanly, rejects on socket error.
 * @param {string} url Base server URL, e.g. "http://localhost:8085".
 * @param {string} route Websocket API route name, eg "GenerateText2ImageWS". Passed through
 *     exactly as given - this function never adds or strips the `WS` suffix.
 * @param {object} body Request body (without `session_id` - it is added automatically).
 * @param {function(object|string): void} onFrame Called once per received frame. Receives
 *     the parsed JSON object if the frame is valid JSON, otherwise the raw text.
 * @returns {Promise<void>} Resolves when the socket closes normally.
 */
export async function callWs(url, route, body, onFrame) {
    let session = await getSession(url);
    let wsUrl = url.replace(/^http/, "ws") + "/API/" + route;
    return new Promise(function (resolve, reject) {
        let socket = new WebSocket(wsUrl);
        socket.onopen = function () {
            let fullBody = Object.assign({}, body, { session_id: session.session_id });
            socket.send(JSON.stringify(fullBody));
        };
        socket.onmessage = function (event) {
            let text = event.data;
            let parsed = text;
            let isJson = true;
            try {
                parsed = JSON.parse(text);
            }
            catch (e) {
                isJson = false;
            }
            if (isJson) {
                onFrame(parsed);
            }
            else {
                onFrame(text);
            }
        };
        socket.onerror = function (event) {
            reject(new Error("WebSocket error"));
        };
        socket.onclose = function () {
            resolve();
        };
    });
}

/**
 * Parses CLI arguments into `{ url, ws, route, body }`.
 * @param {string[]} argv Arguments after the script path (process.argv.slice(2)).
 * @returns {{url: string, ws: boolean, route: string, body: object}} Parsed arguments.
 */
function parseArgs(argv) {
    let url = "http://localhost:8085";
    let ws = false;
    let positional = [];
    let i;
    for (i = 0; i < argv.length; i++) {
        let arg = argv[i];
        if (arg == "--url") {
            i++;
            if (i >= argv.length) {
                throw new Error("--url requires a value, e.g. --url http://localhost:8085");
            }
            url = argv[i];
        }
        else if (arg == "--ws") {
            ws = true;
        }
        else {
            positional.push(arg);
        }
    }
    if (positional.length < 1) {
        throw new Error("Usage: node tools/swarm_api.mjs [--url http://localhost:8085] [--ws] <Route> ['<json body>']");
    }
    let route = positional[0];
    let body = {};
    if (positional.length > 1 && positional[1].length > 0) {
        body = JSON.parse(positional[1]);
    }
    return { url: url, ws: ws, route: route, body: body };
}

/**
 * Runs the CLI: parses arguments, performs the call, and prints the result. Sets
 * `process.exitCode` rather than calling `process.exit()` directly, so the event loop is
 * allowed to drain naturally - forcing an immediate exit while a `fetch`/WebSocket handle
 * is still being torn down crashes Node on Windows (a libuv assertion in `src/win/async.c`).
 * @returns {Promise<void>} Resolves when the CLI run is complete.
 */
async function runCli() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    }
    catch (e) {
        console.error(e.message);
        process.exitCode = 1;
        return;
    }
    if (args.ws) {
        try {
            await callWs(args.url, args.route, args.body, function (frame) {
                if (typeof frame == "string") {
                    console.log(frame);
                }
                else {
                    console.log(JSON.stringify(frame, null, 4));
                }
            });
            process.exitCode = 0;
        }
        catch (e) {
            console.error(e.message);
            process.exitCode = 1;
        }
        return;
    }
    try {
        let data = await call(args.url, args.route, args.body);
        console.log(JSON.stringify(data, null, 4));
        process.exitCode = 0;
    }
    catch (e) {
        console.error(e.message);
        process.exitCode = 1;
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli();
}
