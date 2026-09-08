// Google upload sessions and generated file URIs belong to the issuing account.
// Keep that affinity when model-aware scheduling chooses subsequent requests.
function fileKeys(value) {
    const keys = new Set();
    const visit = item => {
        if (typeof item === "string") {
            const file = item.match(/(?:^|\/)files\/([a-zA-Z0-9_-]+)(?:$|[?/:])/);
            if (file) keys.add(`file:${file[1]}`);
        } else if (Array.isArray(item)) item.forEach(visit);
        else if (item && typeof item === "object") {
            for (const [key, entry] of Object.entries(item)) {
                if (key === "upload_id" && typeof entry === "string") keys.add(`upload:${entry}`);
                else visit(entry);
            }
        }
    };
    visit(value);
    return keys;
}

function rememberUploadHeaders(scheduler, headers, accountKey) {
    for (const [name, value] of Object.entries(headers || {})) {
        if (name.toLowerCase() !== "x-goog-upload-url") continue;
        try {
            const upload = new URL(value).searchParams.get("upload_id");
            if (upload) scheduler.fileAffinities.set(`upload:${upload}`, accountKey);
        } catch {
            /* Not a resumable upload URL. */
        }
    }
    scheduler.saveSoon();
}
module.exports = { fileKeys, rememberUploadHeaders };
