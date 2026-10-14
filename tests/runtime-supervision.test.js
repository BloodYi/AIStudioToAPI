const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const supervisor = JSON.stringify(path.resolve(__dirname, "../src/config/ServiceSupervisor.js"));
const waitFor = async predicate => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
        const result = predicate();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Runtime supervision fixture did not finish");
};

test(
    "external supervisor recovers a blocked main thread and terminates detached descendants",
    { timeout: 20000 },
    async t => {
        if (process.platform !== "linux") {
            t.skip("Linux process-tree validation");
            return;
        }
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-supervisor-"));
        const entry = path.join(directory, "fixture.cjs");
        fs.writeFileSync(
            entry,
            `
const fs = require('fs'), { spawn } = require('child_process');
if (!process.send) require(${supervisor}).supervise(__filename);
else {
    const runs = fs.existsSync('runs') ? Number(fs.readFileSync('runs')) + 1 : 1;
    fs.writeFileSync('runs', String(runs));
    const helper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'});
    fs.writeFileSync('helper-' + runs, String(helper.pid));
    process.send({type:'supervision-policy',policy:{supervisorHeartbeatMs:200,supervisorTimeoutMs:1500,supervisorShutdownMs:100,supervisorMaxRestarts:1}});
    process.on('message', message => {
        if (message.type === 'health-probe') process.send({type:'health-reply',sequence:message.sequence,progress:{ready:1,pending:0}});
        if (message.type === 'shutdown') process.exit(0);
    });
    process.send({type:'ready',configuration:{version:1,overrides:{}}});
    if (runs === 1) setTimeout(()=>{while(true){}},100);
}
`
        );
        const parent = spawn(process.execPath, [entry], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        parent.stderr.on("data", bytes => {
            output += bytes;
        });
        t.after(async () => {
            if (parent.exitCode === null && parent.signalCode === null) {
                const exit = once(parent, "exit");
                parent.kill("SIGTERM");
                await exit;
            }
            fs.rmSync(directory, { force: true, recursive: true });
        });
        await waitFor(() => fs.existsSync(path.join(directory, "helper-2")));
        assert.equal(fs.readFileSync(path.join(directory, "runs"), "utf8"), "2", output);
        const oldPid = fs.readFileSync(path.join(directory, "helper-1"), "utf8");
        await waitFor(() => {
            try {
                return /\) Z /.test(fs.readFileSync(`/proc/${oldPid}/stat`, "utf8"));
            } catch {
                return true;
            }
        });
        // The replacement remains responsive; an idle service must not exhaust its budget.
        await new Promise(resolve => setTimeout(resolve, 2500));
        assert.equal(parent.exitCode, null, output);
        assert.equal(fs.readFileSync(path.join(directory, "runs"), "utf8"), "2");
    }
);

test(
    "repeated runtime failures exhaust a bounded budget without a Docker restart loop",
    { timeout: 20000 },
    async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-budget-"));
        const entry = path.join(directory, "fixture.cjs");
        fs.writeFileSync(
            entry,
            `
const fs=require('fs');
if(!process.send) require(${supervisor}).supervise(__filename);
else {
    fs.writeFileSync('runs',String(fs.existsSync('runs')?Number(fs.readFileSync('runs'))+1:1));
    process.send({type:'supervision-policy',policy:{supervisorMaxRestarts:1,supervisorShutdownMs:100}});
    process.send({type:'ready',configuration:{version:1,overrides:{}}},()=>{
        process.send({type:'runtime-recovery',reason:'test_failure'});
    });
    process.on('message',message=>{if(message.type==='shutdown') process.exit(0);});
}
`
        );
        const parent = spawn(process.execPath, [entry], { cwd: directory, stdio: ["ignore", "ignore", "ignore"] });
        t.after(async () => {
            if (parent.exitCode === null && parent.signalCode === null) {
                const exit = once(parent, "exit");
                parent.kill("SIGTERM");
                await exit;
            }
            fs.rmSync(directory, { force: true, recursive: true });
        });
        const errorPath = path.join(directory, "data", "restart-status.json");
        await waitFor(() => fs.existsSync(errorPath) && fs.readFileSync(errorPath, "utf8").includes("预算耗尽"));
        assert.equal(fs.readFileSync(path.join(directory, "runs"), "utf8"), "2");
        assert.equal(parent.exitCode, null, "Parent must not exit into Docker's automatic restart policy");
    }
);

test("a responsive IPC channel cannot hide a stalled HTTP listener", { timeout: 15000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-http-"));
    const entry = path.join(directory, "fixture.cjs");
    fs.writeFileSync(
        entry,
        `
const fs=require('fs'),http=require('http');
if(!process.send) require(${supervisor}).supervise(__filename);
else {
    const runs=fs.existsSync('runs')?Number(fs.readFileSync('runs'))+1:1;
    fs.writeFileSync('runs',String(runs));
    process.send({type:'supervision-policy',policy:{supervisorHeartbeatMs:200,supervisorTimeoutMs:1500,supervisorShutdownMs:100,supervisorMaxRestarts:1}});
    const server=http.createServer((req,res)=>{if(runs>1)res.end('alive');});
    server.listen(0,'127.0.0.1',()=>{
        fs.writeFileSync('listening-'+runs,'1');
        process.send({type:'ready',configuration:{version:1,overrides:{}},healthEndpoint:{host:'127.0.0.1',port:server.address().port}});
    });
    process.on('message',message=>{
        if(message.type==='health-probe')process.send({type:'health-reply',sequence:message.sequence,progress:{ready:1,pending:0}});
        if(message.type==='shutdown')process.exit(0);
    });
}
`
    );
    const parent = spawn(process.execPath, [entry], { cwd: directory, stdio: ["ignore", "ignore", "ignore"] });
    t.after(async () => {
        if (parent.exitCode === null && parent.signalCode === null) {
            const exit = once(parent, "exit");
            parent.kill("SIGTERM");
            await exit;
        }
        fs.rmSync(directory, { force: true, recursive: true });
    });
    await waitFor(() => fs.existsSync(path.join(directory, "listening-2")));
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(parent.exitCode, null);
    assert.equal(fs.readFileSync(path.join(directory, "runs"), "utf8"), "2");
});
