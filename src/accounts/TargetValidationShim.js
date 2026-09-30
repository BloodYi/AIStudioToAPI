/* eslint-env browser */
// Runs in the page's main world, exclusively in the disposable login browser.
function validationShim() {
    if (window.__accountLoginValidationShim) return;
    window.__accountLoginValidationShim = true;
    document.documentElement?.setAttribute("data-account-login-shim-installed", "true");
    const nonce = document.currentScript?.nonce || document.querySelector("script[nonce]")?.nonce;
    const shim =
        "<script" +
        (nonce && /^[\w+/=-]+$/.test(nonce) ? ' nonce="' + nonce + '"' : "") +
        ">(" +
        validationShim.toString() +
        ")();<" +
        "/script>";
    const inject = html => {
        if (html.includes("__accountLoginValidationShim")) return html;
        const doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0] || "";
        return doctype + shim + html.slice(doctype.length);
    };
    // App previews can be srcdoc/blob documents, which HTTP routing never sees.
    const srcdoc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc");
    if (srcdoc?.set)
        Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", {
            ...srcdoc,
            set(value) {
                srcdoc.set.call(this, inject(String(value)));
            },
        });
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        return setAttribute.call(
            this,
            name,
            this instanceof HTMLIFrameElement && String(name).toLowerCase() === "srcdoc" ? inject(String(value)) : value
        );
    };
    window.Blob = new Proxy(window.Blob, {
        construct(Target, args) {
            if (
                /^text\/html(?:;|$)/i.test(args[1]?.type || "") &&
                Array.isArray(args[0]) &&
                args[0].every(part => typeof part === "string")
            )
                return Reflect.construct(Target, [[inject(args[0].join(""))], args[1]]);
            return Reflect.construct(Target, args);
        },
    });
    const NativeSocket = window.WebSocket;
    class ValidationSocket extends EventTarget {
        constructor(url) {
            super();
            this.url = String(url);
            this.readyState = 0;
            this.bufferedAmount = 0;
            this.protocol = this.extensions = "";
            setTimeout(() => {
                this.readyState = 1;
                document.documentElement.setAttribute("data-account-login-initialized", "true");
                const event = new Event("open");
                this.dispatchEvent(event);
                this.onopen?.(event);
            }, 0);
        }
        send() {}
        close() {
            this.readyState = 3;
        }
    }
    for (const [key, value] of Object.entries({ CLOSED: 3, CLOSING: 2, CONNECTING: 0, OPEN: 1 })) {
        ValidationSocket[key] = value;
        ValidationSocket.prototype[key] = value;
    }
    window.WebSocket = new Proxy(NativeSocket, {
        construct(Target, args) {
            const url = new URL(args[0], location.href);
            if (["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "9998")
                return new ValidationSocket(args[0]);
            return Reflect.construct(Target, args);
        },
    });
    const isolatedFrames = new WeakSet();
    window.addEventListener("message", event => {
        if (event.data?.type === "accountLoginValidationShimReady" && event.source) isolatedFrames.add(event.source);
        if (event.data?.type === "requestAuthIndex")
            event.source.postMessage(
                { authIndex: isolatedFrames.has(event.source) ? 0 : -1, type: "authIndexResponse" },
                "*"
            );
    });
    if (window.parent !== window) window.parent.postMessage({ type: "accountLoginValidationShimReady" }, "*");
}
module.exports = validationShim;
