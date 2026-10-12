const session = require("express-session");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { atomicWrite } = require("./ConfigurationService");
// Private sessions survive a supervised restart; authentication remains required for configuration reads.
class RestartSessionStore extends session.Store {
    constructor() {
        super();
        this.directory = path.join(process.cwd(), "data", "console-sessions");
        fs.mkdirSync(this.directory, { mode: 0o700, recursive: true });
        for (const file of fs.readdirSync(this.directory)) {
            try {
                const target = path.join(this.directory, file);
                const value = JSON.parse(fs.readFileSync(target, "utf8"));
                if (new Date(value.cookie?.expires).getTime() <= Date.now()) fs.unlinkSync(target);
            } catch {
                /* A stale partial file is harmless and never read as a session. */
            }
        }
    }
    file(id) {
        return path.join(this.directory, crypto.createHash("sha256").update(id).digest("hex") + ".json");
    }
    get(id, callback) {
        try {
            const file = this.file(id);
            if (!fs.existsSync(file)) return callback(null, null);
            const value = JSON.parse(fs.readFileSync(file, "utf8"));
            if (new Date(value.cookie?.expires).getTime() <= Date.now())
                return this.destroy(id, () => callback(null, null));
            callback(null, value);
        } catch (error) {
            callback(error);
        }
    }
    set(id, value, callback = () => {}) {
        try {
            atomicWrite(this.file(id), value);
            callback(null);
        } catch (error) {
            callback(error);
        }
    }
    destroy(id, callback = () => {}) {
        try {
            fs.rmSync(this.file(id), { force: true });
            callback(null);
        } catch (error) {
            callback(error);
        }
    }
    touch(id, value, callback) {
        this.set(id, value, callback);
    }
}
module.exports = RestartSessionStore;
