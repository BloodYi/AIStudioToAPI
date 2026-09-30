const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
class LoginArtifactService {
    constructor(directory) {
        this.directory = path.resolve(directory);
    }
    async initialize() {
        await fs.mkdir(this.directory, { mode: 0o700, recursive: true });
        await fs.chmod(this.directory, 0o700);
    }
    async save(accountId, taskId, buffer) {
        const id = randomUUID();
        await fs.writeFile(path.join(this.directory, `${id}.png`), buffer, { flag: "wx", mode: 0o600 });
        return { accountId, createdAt: Date.now(), expired: false, id, taskId };
    }
    async read(artifact) {
        if (!artifact) throw Object.assign(new Error("Artifact not found"), { status: 404 });
        if (artifact.expired) throw Object.assign(new Error("Artifact expired"), { status: 410 });
        try {
            return await fs.readFile(path.join(this.directory, `${artifact.id}.png`));
        } catch {
            throw Object.assign(new Error("Artifact storage unavailable"), { status: 503 });
        }
    }
    async cleanup(artifacts, config) {
        for (const accountId of new Set(artifacts.map(item => item.accountId))) {
            const items = artifacts
                .filter(item => item.accountId === accountId && !item.expired)
                .sort((a, b) => b.createdAt - a.createdAt);
            for (const [index, item] of items.entries())
                if (
                    index >= config.screenshotsPerAccount ||
                    item.createdAt < Date.now() - config.screenshotDays * 86400000
                ) {
                    await fs.unlink(path.join(this.directory, `${item.id}.png`)).catch(error => {
                        if (error.code !== "ENOENT") throw error;
                    });
                    item.expired = true;
                }
        }
        // Recover files orphaned by an interrupted metadata commit.
        const known = new Set(artifacts.filter(item => !item.expired).map(item => `${item.id}.png`));
        for (const file of await fs.readdir(this.directory))
            if (/^[\da-f-]{36}\.png$/.test(file) && !known.has(file)) await fs.unlink(path.join(this.directory, file));
    }
}
module.exports = LoginArtifactService;
