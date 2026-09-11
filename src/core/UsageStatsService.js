/**
 * File: src/core/UsageStatsService.js
 * Description: In-memory usage statistics and request history service
 *
 * Author: OpenAI Codex
 */

const fs = require("fs");
const path = require("path");

class UsageStatsService {
    constructor(authSource, logger, dataDir, enabled = true) {
        this.authSource = authSource;
        this.logger = logger;
        this.dataDir = dataDir || path.join(process.cwd(), "data");
        this.statsFilePath = path.join(this.dataDir, "usage-stats.jsonl");
        this.enabled = enabled !== false;
        this.appendPromise = Promise.resolve();
        this.isImportingStats = false;
        this.datasetRevision = 1;

        if (this.enabled) {
            // Ensure data directory exists
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
            }

            // Load persisted state
            this._loadFromFile();
        }

        if (!this.startedAt) {
            this.startedAtMs = Date.now();
            this.startedAt = new Date(this.startedAtMs).toISOString();
        }
        if (!this.summary) {
            this.summary = {
                abortedCount: 0,
                errorCount: 0,
                successCount: 0,
                totalDurationMs: 0,
                totalRequests: 0,
            };
        }
        if (!this.activeRequests) {
            this.activeRequests = new Map();
        }
        if (!this.records) {
            this.records = [];
        }
        if (!this.accountStats) {
            this.accountStats = new Map();
        }
        if (!this.formatStats) {
            this.formatStats = new Map();
        }
        if (!this.categoryStats) {
            this.categoryStats = new Map();
        }
        if (!this.streamModeStats) {
            this.streamModeStats = new Map();
        }
        if (!this.modelStats) {
            this.modelStats = new Map();
        }
        if (this.sequence === undefined) {
            this.sequence = 0;
        }
    }

    startRequest(requestId, meta = {}) {
        if (!this.enabled) return null;
        if (!requestId) return null;

        const tracker = {
            apiFormat: meta.apiFormat || "unknown",
            attemptCount: 0,
            attempts: [],
            clientIp: meta.clientIp || null,
            initialAccountName: this._normalizeAccountName(meta.initialAccountName),
            initialAuthIndex: this._normalizeAuthIndex(meta.initialAuthIndex),
            isStreaming: Boolean(meta.isStreaming),
            method: meta.method || "GET",
            model: meta.model || null,
            path: meta.path || "/",
            requestCategory: meta.requestCategory || "request",
            requestId,
            startedAt: new Date().toISOString(),
            startedAtMs: Date.now(),
            streamMode: meta.streamMode || null,
        };

        this.activeRequests.set(requestId, tracker);
        return tracker;
    }

    updateRequest(requestId, patch = {}) {
        if (!this.enabled) return;
        const tracker = this.activeRequests.get(requestId);
        if (!tracker) return;

        if (patch.apiFormat !== undefined) tracker.apiFormat = patch.apiFormat || tracker.apiFormat;
        if (patch.clientIp !== undefined) tracker.clientIp = patch.clientIp || null;
        if (patch.isStreaming !== undefined) tracker.isStreaming = Boolean(patch.isStreaming);
        if (patch.method !== undefined) tracker.method = patch.method || tracker.method;
        if (patch.model !== undefined) tracker.model = patch.model || null;
        if (patch.path !== undefined) tracker.path = patch.path || tracker.path;
        if (patch.requestCategory !== undefined)
            tracker.requestCategory = patch.requestCategory || tracker.requestCategory;
        if (patch.streamMode !== undefined) tracker.streamMode = patch.streamMode || null;

        if (patch.initialAuthIndex !== undefined) {
            tracker.initialAuthIndex = this._normalizeAuthIndex(patch.initialAuthIndex);
        }
        if (patch.initialAccountName !== undefined) {
            tracker.initialAccountName = this._normalizeAccountName(patch.initialAccountName);
        }
    }

    recordAttempt(requestId, authIndex, accountName = undefined) {
        if (!this.enabled) return;
        const tracker = this.activeRequests.get(requestId);
        if (!tracker) return;

        const normalizedAuthIndex = this._normalizeAuthIndex(authIndex);
        if (normalizedAuthIndex === null) return;

        const resolvedAccountName =
            accountName !== undefined
                ? this._normalizeAccountName(accountName)
                : this._resolveAccountName(normalizedAuthIndex);

        this._pushAttempt(tracker, normalizedAuthIndex, resolvedAccountName);
    }

    finishRequest(requestId, result = {}) {
        if (!this.enabled) return null;
        const tracker = this.activeRequests.get(requestId);
        if (!tracker) return null;

        this.activeRequests.delete(requestId);
        if (this.isImportingStats) {
            if (this.logger) {
                this.logger.info(`[UsageStats] Dropped request ${requestId} because stats import is in progress.`);
            }
            return null;
        }

        const finishedAtMs = Date.now();
        const lastAttempt = tracker.attempts[tracker.attempts.length - 1] || null;
        const lastParsed = lastAttempt?.accountKey ? this._parseAccountKey(lastAttempt.accountKey) : {};
        const finalAuthIndex =
            this._normalizeAuthIndex(result.finalAuthIndex) ?? lastParsed.authIndex ?? tracker.initialAuthIndex ?? null;
        const finalAccountName =
            this._normalizeAccountName(result.finalAccountName) ??
            lastParsed.accountName ??
            tracker.initialAccountName ??
            null;
        const outcome = this._normalizeOutcome(result.outcome);
        const statusCode = Number.isFinite(result.statusCode) ? Number(result.statusCode) : null;
        const durationMs = Math.max(0, finishedAtMs - tracker.startedAtMs);
        const accountKey = this._buildAccountKey(finalAuthIndex, finalAccountName);

        const record = {
            accountKey,
            apiFormat: tracker.apiFormat,
            attemptCount: tracker.attemptCount,
            attempts: tracker.attempts.map(item => ({ accountKey: item.accountKey })),
            clientIp: tracker.clientIp,
            durationMs,
            errorMessage: result.errorMessage || null,
            finalAccountName,
            finalAuthIndex,
            finishedAt: new Date(finishedAtMs).toISOString(),
            initialAccountName: tracker.initialAccountName,
            initialAuthIndex: tracker.initialAuthIndex,
            isStreaming: tracker.isStreaming,
            method: tracker.method,
            model: tracker.model,
            outcome,
            path: tracker.path,
            requestCategory: tracker.requestCategory,
            requestId: tracker.requestId,
            sequence: ++this.sequence,
            startedAt: tracker.startedAt,
            statusCode,
            streamMode: tracker.requestCategory === "generation" ? tracker.streamMode || "non" : null,
        };

        this.records.push(record);
        this._updateSummary(record);
        this._updateBreakdown(this.formatStats, record.apiFormat);
        this._updateBreakdown(this.categoryStats, record.requestCategory);
        this._updateBreakdown(this.streamModeStats, record.streamMode);
        this._updateAccountStats(record);
        this._updateModelStats(record);

        // Append record to file (one line per record)
        this._appendRecord(record);

        return record;
    }

    getSnapshot() {
        return { ...this.getSummarySnapshot(), records: this.enabled ? this.records.slice().reverse() : [] };
    }

    getSummarySnapshot() {
        if (!this.enabled) {
            const empty = UsageStatsService.createEmptySnapshot();
            delete empty.records;
            return { ...empty, dataset_revision: this.datasetRevision };
        }

        const totalRequests = this.summary.totalRequests;
        const avgDurationMs = totalRequests > 0 ? Math.round(this.summary.totalDurationMs / totalRequests) : 0;
        const successRate =
            totalRequests > 0 ? Number(((this.summary.successCount / totalRequests) * 100).toFixed(1)) : 0;

        const accounts = Array.from(this.accountStats.values())
            .map(item => ({
                abortedCount: item.abortedCount,
                accountKey: item.accountKey,
                accountName: item.accountName,
                authIndex: item.authIndex,
                avgDurationMs: item.totalRequests > 0 ? Math.round(item.totalDurationMs / item.totalRequests) : 0,
                errorCount: item.errorCount,
                lastPath: item.lastPath,
                lastUsedAt: item.lastUsedAt,
                modelCounts: Object.entries(item.modelCounts || {})
                    .map(([key, count]) => ({ count, key }))
                    .sort((a, b) => b.count - a.count),
                successCount: item.successCount,
                successRate:
                    item.totalRequests > 0 ? Number(((item.successCount / item.totalRequests) * 100).toFixed(1)) : 0,
                totalDurationMs: item.totalDurationMs,
                totalRequests: item.totalRequests,
            }))
            .sort((a, b) => {
                if (b.totalRequests !== a.totalRequests) return b.totalRequests - a.totalRequests;
                return (b.lastUsedAt || "").localeCompare(a.lastUsedAt || "");
            });

        return {
            accounts,
            dataset_revision: this.datasetRevision,
            models: this._serializeModelStats(),
            startedAt: this.startedAt,
            summary: {
                abortedCount: this.summary.abortedCount,
                activeRequests: this.activeRequests.size,
                avgDurationMs,
                errorCount: this.summary.errorCount,
                formatBreakdown: this._serializeBreakdown(this.formatStats),
                requestCategoryBreakdown: this._serializeBreakdown(this.categoryStats),
                streamModeBreakdown: this._serializeBreakdown(this.streamModeStats),
                successCount: this.summary.successCount,
                successRate,
                totalRequests,
                uniqueAccountPairs: this.accountStats.size,
                uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.startedAtMs) / 1000)),
            },
        };
    }

    /**
     * Return a deliberately small public projection. Never build this from
     * getSummarySnapshot(): that object contains account and request metadata.
     */
    getPublicSummarySnapshot(visibleModels = []) {
        const modelKeys = [...new Set(visibleModels.map(value => String(value)))].sort((a, b) => a.localeCompare(b));
        if (!this.enabled) {
            return {
                enabled: false,
                models: modelKeys.map(modelKey => ({
                    averageDurationMs: null,
                    failedRequests: null,
                    modelKey,
                    successRate: null,
                    totalRequests: null,
                })),
                summary: {
                    averageDurationMs: null,
                    failedRequests: null,
                    successRate: null,
                    totalRequests: null,
                },
            };
        }

        const project = (stats = {}) => {
            const totalRequests = Number.isSafeInteger(stats.totalRequests) ? Math.max(0, stats.totalRequests) : 0;
            const successCount = Number.isSafeInteger(stats.successCount) ? Math.max(0, stats.successCount) : 0;
            const errorCount = Number.isSafeInteger(stats.errorCount) ? Math.max(0, stats.errorCount) : 0;
            const abortedCount = Number.isSafeInteger(stats.abortedCount) ? Math.max(0, stats.abortedCount) : 0;
            const totalDurationMs = Number.isFinite(stats.totalDurationMs) ? Math.max(0, stats.totalDurationMs) : 0;
            return {
                averageDurationMs: totalRequests
                    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(totalDurationMs / totalRequests))
                    : null,
                failedRequests: Math.min(Number.MAX_SAFE_INTEGER, errorCount + abortedCount),
                successRate: totalRequests
                    ? Number((Math.min(1, successCount / totalRequests) * 100).toFixed(1))
                    : null,
                totalRequests,
            };
        };

        return {
            enabled: true,
            models: modelKeys.map(modelKey => ({ modelKey, ...project(this.modelStats.get(modelKey)) })),
            summary: project(this.summary),
        };
    }

    queryRecords(options = {}) {
        if (!this.enabled) {
            return { dataset_revision: this.datasetRevision, has_more: false, next_cursor: null, records: [] };
        }
        const allowedLimits = new Set([10, 20, 50, 100]);
        const limit = Number(options.limit || 20);
        if (!allowedLimits.has(limit)) throw Object.assign(new Error("Invalid records limit"), { status: 400 });

        if (options.after_sequence !== undefined) {
            const afterSequence = Number(options.after_sequence);
            if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
                throw Object.assign(new Error("Invalid records sequence"), { status: 400 });
            if (Number(options.dataset_revision) !== this.datasetRevision) {
                return {
                    dataset_revision: this.datasetRevision,
                    has_more: this.records.length > limit,
                    latest_sequence: this.sequence,
                    next_cursor: null,
                    records: this.records.slice(-limit).reverse(),
                    reset: true,
                };
            }
            const matching = this.records.filter(record => record.sequence > afterSequence);
            const selected = matching.slice(0, limit);
            const records = selected.slice().reverse();
            return {
                dataset_revision: this.datasetRevision,
                has_more: matching.length > limit,
                latest_sequence: selected.at(-1)?.sequence ?? afterSequence,
                next_cursor: null,
                records,
                reset: false,
            };
        }

        let beforeSequence = Infinity;
        if (options.cursor) {
            try {
                const cursor = JSON.parse(Buffer.from(String(options.cursor), "base64url").toString("utf8"));
                if (cursor.revision !== this.datasetRevision || !Number.isInteger(cursor.before)) {
                    return {
                        dataset_revision: this.datasetRevision,
                        has_more: this.records.length > 0,
                        next_cursor: null,
                        records: [],
                        reset: true,
                    };
                }
                beforeSequence = cursor.before;
            } catch {
                throw Object.assign(new Error("Invalid records cursor"), { status: 400 });
            }
        }

        const values = value => {
            if (value === undefined || value === null || value === "") return null;
            return new Set((Array.isArray(value) ? value : String(value).split(",")).map(item => String(item)));
        };
        const model = values(options.model);
        const outcome = values(options.outcome);
        const statusCode = values(options.status_code);
        const authIndex = values(options.auth_index);
        const apiFormat = values(options.api_format);
        const requestCategory = values(options.request_category);
        const streamMode = values(options.stream_mode);
        const clientIp = values(options.client_ip);
        const from = options.from ? Date.parse(options.from) : null;
        const to = options.to ? Date.parse(options.to) : null;
        if ((options.from && !Number.isFinite(from)) || (options.to && !Number.isFinite(to)))
            throw Object.assign(new Error("Invalid records time range"), { status: 400 });

        const matches = record => {
            if ((record.sequence || 0) >= beforeSequence) return false;
            if (model && !model.has(String(record.model ?? ""))) return false;
            if (outcome && !outcome.has(String(record.outcome ?? ""))) return false;
            if (statusCode && !statusCode.has(String(record.statusCode ?? ""))) return false;
            if (authIndex && !authIndex.has(String(record.finalAuthIndex ?? ""))) return false;
            if (apiFormat && !apiFormat.has(String(record.apiFormat ?? ""))) return false;
            if (requestCategory && !requestCategory.has(String(record.requestCategory ?? ""))) return false;
            if (streamMode && !streamMode.has(String(record.streamMode ?? ""))) return false;
            if (clientIp && !clientIp.has(String(record.clientIp ?? ""))) return false;
            const timestamp = Date.parse(record.finishedAt);
            if (from !== null && timestamp < from) return false;
            if (to !== null && timestamp > to) return false;
            return true;
        };
        const ordered = [];
        for (let index = this.records.length - 1; index >= 0 && ordered.length <= limit; index--) {
            const record = this.records[index];
            if (matches(record)) ordered.push(record);
        }
        const hasMore = ordered.length > limit;
        const records = ordered.slice(0, limit);
        const lastSequence = records.at(-1)?.sequence;
        return {
            dataset_revision: this.datasetRevision,
            has_more: hasMore,
            latest_sequence: this.sequence,
            next_cursor:
                hasMore && Number.isInteger(lastSequence)
                    ? Buffer.from(JSON.stringify({ before: lastSequence, revision: this.datasetRevision })).toString(
                          "base64url"
                      )
                    : null,
            records,
            reset: false,
        };
    }

    /**
     * Public import entry point. Drops newly finished stats during import, waits
     * for already queued appends, then rewrites the stats file from a stable baseline.
     */
    importJsonl(content) {
        if (!this.enabled) {
            throw new Error("Usage stats are disabled");
        }
        if (this.isImportingStats) {
            throw new Error("Usage stats import is already in progress");
        }
        if (typeof content !== "string") {
            throw new Error("Invalid JSONL content");
        }

        this.isImportingStats = true;

        const importPromise = this.appendPromise
            .catch(() => {})
            .then(() => this._importJsonlContent(content))
            .finally(() => {
                this.isImportingStats = false;
            });

        this.appendPromise = importPromise.catch(() => {});
        return importPromise;
    }

    /**
     * Load persisted JSONL records during startup and rebuild derived in-memory
     * aggregates from the records that can be parsed.
     */
    _loadFromFile() {
        try {
            const { records } = this._readRecordsFromFile();
            if (records.length === 0 && !fs.existsSync(this.statsFilePath)) return;

            // Recalculate aggregates from all loaded records
            this._replaceRecords(records);
            this._recalculateFromRecords();

            if (this.logger) {
                this.logger.info(`[UsageStats] Loaded ${this.records.length} records from ${this.statsFilePath}`);
            }
        } catch (err) {
            if (this.logger) {
                this.logger.warn(`[UsageStats] Failed to load stats file: ${err.message}`);
            }
        }
    }

    _appendRecord(record) {
        if (!this.enabled) return;
        const line = JSON.stringify(record) + "\n";
        this.appendPromise = this.appendPromise
            .catch(() => {})
            .then(() => fs.promises.appendFile(this.statsFilePath, line, "utf-8"))
            .catch(err => {
                if (this.logger) {
                    this.logger.warn(`[UsageStats] Failed to append record: ${err.message}`);
                }
            });
    }

    /**
     * Import JSONL content, deduplicate by requestId, merge with current records,
     * rewrite the file in finishedAt order, and rebuild memory state.
     */
    async _importJsonlContent(content) {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }

        const { records: existingRecords } = await this._readRecordsFromFileAsync();
        const uniqueExistingRecords = [];
        const seenRequestIds = new Set();
        let duplicateCount = 0;
        let missingRequestIdCount = 0;

        for (const record of existingRecords) {
            const requestId = this._normalizeRequestId(record.requestId);
            if (!requestId) {
                missingRequestIdCount += 1;
                continue;
            }

            record.requestId = requestId;
            if (seenRequestIds.has(requestId)) {
                duplicateCount += 1;
                continue;
            }

            seenRequestIds.add(requestId);
            uniqueExistingRecords.push(record);
        }

        const importedRecords = [];
        let invalidLineCount = 0;
        const lines = content.split(/\r?\n/);

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let record;
            try {
                record = this._normalizeLoadedRecord(JSON.parse(trimmed));
            } catch {
                invalidLineCount += 1;
                continue;
            }

            const requestId = this._normalizeRequestId(record.requestId);
            if (!requestId) {
                missingRequestIdCount += 1;
                continue;
            }
            record.requestId = requestId;

            if (seenRequestIds.has(requestId)) {
                duplicateCount += 1;
                continue;
            }

            seenRequestIds.add(requestId);
            importedRecords.push(record);
        }

        const mergedRecords = this._normalizeImportedRecords(uniqueExistingRecords.concat(importedRecords));
        const fileContent = mergedRecords.map(record => JSON.stringify(record)).join("\n");
        await fs.promises.writeFile(this.statsFilePath, fileContent ? `${fileContent}\n` : "", "utf-8");
        this._replaceRecords(mergedRecords);
        this._recalculateFromRecords({ resetStartedAt: false });

        if (this.logger) {
            this.logger.info(
                `[UsageStats] Imported ${importedRecords.length} records from JSONL. ` +
                    `Skipped ${duplicateCount} duplicates, ${invalidLineCount} invalid lines, ` +
                    `${missingRequestIdCount} without requestId.`
            );
        }

        return {
            duplicateCount,
            importedCount: importedRecords.length,
            invalidLineCount,
            missingRequestIdCount,
            totalRecords: mergedRecords.length,
        };
    }

    /**
     * Read valid records from the persisted usage-stats JSONL file. Malformed
     * lines are ignored so one bad line does not prevent loading the rest.
     */
    async _readRecordsFromFileAsync() {
        try {
            const content = await fs.promises.readFile(this.statsFilePath, "utf-8");
            return { records: this._parseRecordsContent(content) };
        } catch (error) {
            if (error?.code === "ENOENT") {
                return { records: [] };
            }

            throw error;
        }
    }

    _readRecordsFromFile() {
        try {
            const content = fs.readFileSync(this.statsFilePath, "utf-8");
            return { records: this._parseRecordsContent(content) };
        } catch (error) {
            if (error?.code === "ENOENT") {
                return { records: [] };
            }

            throw error;
        }
    }

    _parseRecordsContent(content) {
        const records = [];
        const lines = content.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
            try {
                records.push(this._normalizeLoadedRecord(JSON.parse(line)));
            } catch {
                // Skip malformed lines
            }
        }

        return records;
    }

    /**
     * Normalize imported data by finished time and assign continuous sequence
     * numbers from 1..N after records from multiple files have been merged.
     */
    _normalizeImportedRecords(records) {
        return records
            .map((record, originalIndex) => ({ originalIndex, record }))
            .sort((a, b) => {
                const aTime = this._getRecordSortTime(a.record);
                const bTime = this._getRecordSortTime(b.record);
                if (aTime !== bTime) return aTime - bTime;
                return a.originalIndex - b.originalIndex;
            })
            .map((item, index) => ({
                ...item.record,
                sequence: index + 1,
            }));
    }

    /**
     * Return the timestamp used for import ordering: finishedAt first, then
     * startedAt, then the previous sequence as a final fallback.
     */
    _getRecordSortTime(record) {
        const finishedAtMs = Date.parse(record?.finishedAt);
        if (Number.isFinite(finishedAtMs)) return finishedAtMs;

        const startedAtMs = Date.parse(record?.startedAt);
        if (Number.isFinite(startedAtMs)) return startedAtMs;

        const sequence = Number(record?.sequence);
        return Number.isFinite(sequence) ? sequence : Number.MAX_SAFE_INTEGER;
    }

    /**
     * Replace the in-memory record list and reset sequence to the highest record
     * sequence so new records continue after the current data set.
     */
    _replaceRecords(records) {
        this.records = records;
        this.datasetRevision = (this.datasetRevision || 0) + 1;
        this.sequence = 0;
        for (const record of records) {
            if (record.sequence > this.sequence) {
                this.sequence = record.sequence;
            }
        }
    }

    _recalculateFromRecords(options = {}) {
        const { resetStartedAt = true } = options;
        if (resetStartedAt) {
            this.startedAtMs = Date.now();
            this.startedAt = new Date(this.startedAtMs).toISOString();
        }
        this.summary = {
            abortedCount: 0,
            errorCount: 0,
            successCount: 0,
            totalDurationMs: 0,
            totalRequests: 0,
        };
        this.accountStats = new Map();
        this.formatStats = new Map();
        this.categoryStats = new Map();
        this.streamModeStats = new Map();
        this.modelStats = new Map();

        for (const record of this.records) {
            this._updateSummary(record);
            this._updateBreakdown(this.formatStats, record.apiFormat);
            this._updateBreakdown(this.categoryStats, record.requestCategory);
            this._updateBreakdown(this.streamModeStats, record.streamMode);
            this._updateAccountStats(record);
            this._updateModelStats(record);
        }
    }

    _pushAttempt(tracker, authIndex, accountName) {
        const normalizedAccountName = this._normalizeAccountName(accountName);
        const accountKey = this._buildAccountKey(authIndex, normalizedAccountName);

        tracker.attemptCount += 1;
        tracker.attempts.push({ accountKey });
    }

    _updateSummary(record) {
        const durationMs = this._normalizeDurationMs(record.durationMs);
        this.summary.totalRequests += 1;
        this.summary.totalDurationMs += durationMs;

        if (record.outcome === "success") {
            this.summary.successCount += 1;
        } else if (record.outcome === "aborted") {
            this.summary.abortedCount += 1;
        } else {
            this.summary.errorCount += 1;
        }
    }

    _updateBreakdown(targetMap, key) {
        const currentKey = key || "unknown";
        const existing = targetMap.get(currentKey) || { count: 0, key: currentKey };
        existing.count += 1;
        targetMap.set(currentKey, existing);
    }

    _updateAccountStats(record) {
        const durationMs = this._normalizeDurationMs(record.durationMs);
        const accountKey = record.accountKey || this._buildAccountKey(record.finalAuthIndex, record.finalAccountName);
        const existing = this.accountStats.get(accountKey) || {
            abortedCount: 0,
            accountKey,
            accountName: record.finalAccountName,
            authIndex: record.finalAuthIndex,
            errorCount: 0,
            lastPath: null,
            lastUsedAt: record.finishedAt,
            modelCounts: {},
            successCount: 0,
            totalDurationMs: 0,
            totalRequests: 0,
        };

        existing.accountName = record.finalAccountName;
        existing.authIndex = record.finalAuthIndex;
        const modelKey = record.model || "unknown";
        existing.modelCounts[modelKey] = (existing.modelCounts[modelKey] || 0) + 1;
        existing.lastPath = record.path || existing.lastPath;
        existing.lastUsedAt = record.finishedAt;
        existing.totalDurationMs += durationMs;
        existing.totalRequests += 1;

        if (record.outcome === "success") {
            existing.successCount += 1;
        } else if (record.outcome === "aborted") {
            existing.abortedCount += 1;
        } else {
            existing.errorCount += 1;
        }

        this.accountStats.set(accountKey, existing);
    }

    _updateModelStats(record) {
        const modelKey = record.model || "unknown";
        const existing = this.modelStats.get(modelKey) || {
            abortedCount: 0,
            accountCounts: {},
            errorCount: 0,
            modelKey,
            successCount: 0,
            totalDurationMs: 0,
            totalRequests: 0,
        };
        existing.totalRequests += 1;
        existing.totalDurationMs += this._normalizeDurationMs(record.durationMs);
        if (record.outcome === "success") existing.successCount += 1;
        else if (record.outcome === "aborted") existing.abortedCount += 1;
        else existing.errorCount += 1;

        const accountKey = record.accountKey || this._buildAccountKey(record.finalAuthIndex, record.finalAccountName);
        const account = existing.accountCounts[accountKey] || {
            accountName: record.finalAccountName,
            authIndex: record.finalAuthIndex,
            count: 0,
            error: 0,
            key: accountKey,
        };
        account.count += 1;
        if (record.outcome === "error") account.error += 1;
        existing.accountCounts[accountKey] = account;
        this.modelStats.set(modelKey, existing);
    }

    _serializeModelStats() {
        return [...this.modelStats.values()]
            .map(model => ({
                ...model,
                accountCounts: Object.values(model.accountCounts).sort((a, b) => b.count - a.count),
                avgDurationMs: model.totalRequests > 0 ? Math.round(model.totalDurationMs / model.totalRequests) : 0,
                successRate:
                    model.totalRequests > 0 ? Number(((model.successCount / model.totalRequests) * 100).toFixed(1)) : 0,
            }))
            .sort((a, b) => b.totalRequests - a.totalRequests);
    }

    _serializeBreakdown(sourceMap) {
        return Array.from(sourceMap.values()).sort((a, b) => b.count - a.count);
    }

    _normalizeOutcome(outcome) {
        if (outcome === "success" || outcome === "aborted") {
            return outcome;
        }
        return "error";
    }

    _normalizeDurationMs(value) {
        const durationMs = Number(value);
        return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    }

    _normalizeLoadedRecord(record) {
        return {
            ...record,
            durationMs: this._normalizeDurationMs(record?.durationMs),
            outcome: this._normalizeOutcome(record?.outcome),
            statusCode: Number.isFinite(Number(record?.statusCode)) ? Number(record.statusCode) : null,
        };
    }

    /**
     * Normalize requestId for import deduplication. Non-string IDs are treated
     * as missing so they cannot be used as merge keys.
     */
    _normalizeRequestId(value) {
        if (typeof value !== "string") return "";
        return value.trim();
    }

    _normalizeAuthIndex(value) {
        return Number.isInteger(value) && value >= 0 ? value : null;
    }

    _normalizeAccountName(value) {
        if (typeof value !== "string") return null;
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
    }

    _resolveAccountName(authIndex) {
        if (!this.authSource?.accountNameMap || authIndex === null) return null;
        return this._normalizeAccountName(this.authSource.accountNameMap.get(authIndex));
    }

    _buildAccountKey(authIndex, accountName) {
        if (authIndex === null) {
            return accountName ? `unassigned:${accountName}` : "unassigned";
        }

        return `${authIndex}:${accountName || "N/A"}`;
    }

    _parseAccountKey(accountKey) {
        if (!accountKey || accountKey === "unassigned") {
            return { accountName: null, authIndex: null };
        }
        const colonIdx = accountKey.indexOf(":");
        if (colonIdx === -1) {
            return { accountName: accountKey, authIndex: null };
        }
        const authIndex = Number(accountKey.slice(0, colonIdx));
        const accountName = accountKey.slice(colonIdx + 1);
        return { accountName, authIndex: Number.isFinite(authIndex) ? authIndex : null };
    }

    static createEmptySnapshot() {
        return {
            accounts: [],
            models: [],
            records: [],
            startedAt: null,
            summary: {
                abortedCount: 0,
                activeRequests: 0,
                avgDurationMs: 0,
                errorCount: 0,
                formatBreakdown: [],
                requestCategoryBreakdown: [],
                streamModeBreakdown: [],
                successCount: 0,
                successRate: 0,
                totalRequests: 0,
                uniqueAccountPairs: 0,
                uptimeSeconds: 0,
            },
        };
    }

    static createEmptySummarySnapshot() {
        const snapshot = UsageStatsService.createEmptySnapshot();
        delete snapshot.records;
        return { ...snapshot, dataset_revision: 0 };
    }
}

module.exports = UsageStatsService;
