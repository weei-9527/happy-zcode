// Happy-Zcode E2E simulator.
// Provisions an account on the Happy server, installs credentials on the NAS,
// starts `happy zcode` there, then plays the phone: sends a message and
// verifies the agent response comes back encrypted end-to-end.
//
// Usage: node sim/e2e.mjs [prompt]
import { execSync, } from 'node:child_process';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tweetnacl from 'tweetnacl';
import axios from 'axios';

const NAS = 'weei@192.168.31.100';
const SSH = ['-F', '/dev/null', '-i', `${process.env.HOME}/.ssh/id_ed25519_codex_nas`];
const SERVER = 'https://api.cluster-fluster.com';
const NAS_CLI = '/home/weei/happy-cli/bin/happy.mjs';
const NAS_ZCODE_CMD = '/home/weei/.local/bin/zcode';
const NAS_NODE = '/vol4/1000/zcode-research/3.12.3/extracted/opt/ZCode/zcode';
const ACCOUNT_FILE = '/tmp/happy-sim/account.json';

const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const sshQuote = (s) => JSON.stringify(s);
const sshArgs = () => SSH.map((s) => sshQuote(s)).join(' ');
const ssh = (cmd, opts = '') => execSync(`ssh ${opts} ${sshArgs()} ${sshQuote(NAS)} ${sshQuote(cmd)}`, { encoding: 'utf8', timeout: 45000 });

function log(msg) { console.log(`[sim ${new Date().toISOString().slice(11, 19)}] ${msg}`); }

async function provisionAccount() {
    const seed = randomBytes(32);
    const signPair = tweetnacl.sign.keyPair.fromSeed(seed);
    const challenge = randomBytes(32);
    const signature = tweetnacl.sign.detached(challenge, signPair.secretKey);
    const res = await axios.post(`${SERVER}/v1/auth`, {
        challenge: b64(challenge),
        publicKey: b64(signPair.publicKey),
        signature: b64(signature),
    });
    if (!res.data.success || !res.data.token) throw new Error('account creation failed: ' + JSON.stringify(res.data));
    const boxPair = tweetnacl.box.keyPair();
    const machineKey = randomBytes(32);
    const account = { token: res.data.token, boxSecret: b64(boxPair.secretKey), boxPublic: b64(boxPair.publicKey) };
    fs.mkdirSync(path.dirname(ACCOUNT_FILE), { recursive: true });
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(account, null, 2), { mode: 0o600 });
    const accessKey = { encryption: { publicKey: b64(boxPair.publicKey), machineKey: b64(machineKey) }, token: res.data.token };
    const localAccessKey = '/tmp/happy-sim/access.key.json';
    fs.writeFileSync(localAccessKey, JSON.stringify(accessKey, null, 2), { mode: 0o600 });
    ssh('mkdir -p ~/.happy');
    execSync(`scp ${sshArgs()} ${sshQuote(localAccessKey)} ${sshQuote(NAS + ':~/.happy/access.key')}`, { shell: '/bin/bash', timeout: 30000 });
    log('account provisioned, credentials installed on NAS');
}

function startCli() {
    try {
        ssh('pkill -f "happy.mjs zcode"; sleep 1; echo killed');
    } catch { /* no old process */ }
    const remote = `export ELECTRON_RUN_AS_NODE=1; export HOME=/home/weei; cd /home/weei/zcode-test && nohup ${NAS_NODE} ${NAS_CLI} zcode --zcode-command ${NAS_ZCODE_CMD} > /tmp/happy-zcode-cli.log 2>&1 < /dev/null & disown; echo LAUNCHED`;
    let out = '';
    try { out = ssh(remote); } catch (e) { out = String(e.stdout || ''); }
    log('cli started: ' + out.trim());
}

async function waitForSession(token, tries = 30) {
    for (let i = 0; i < tries; i++) {
        try {
            const res = await axios.get(`${SERVER}/v1/sessions`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
            const sessions = Array.isArray(res.data) ? res.data : (res.data.sessions ?? []);
            if (sessions.length > 0) return sessions[0];
        } catch (e) {
            log(`list sessions attempt ${i}: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('no session appeared');
}

function unsealDataKey(encB64, boxSecretB64) {
    const raw = unb64(encB64);
    const version = raw[0];
    if (version !== 0) throw new Error('unknown dataKey version ' + version);
    const bundle = raw.slice(1);
    const ephPub = bundle.slice(0, 32);
    const nonce = bundle.slice(32, 32 + 24);
    const boxed = bundle.slice(56);
    const opened = tweetnacl.box.open(boxed, nonce, ephPub, unb64(boxSecretB64));
    if (!opened) throw new Error('failed to unseal session data key');
    return opened;
}

// Session content encryption: version(1) + gcm nonce(12) + ciphertext + tag(16)
function encryptWithKey(obj, key) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce);
    const pt = Buffer.from(JSON.stringify(obj));
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    const bundle = Buffer.concat([Buffer.from([0]), nonce, ct, tag]);
    return b64(bundle);
}

function decryptWithKey(b64Data, key) {
    const raw = Buffer.from(b64Data, 'base64');
    const nonce = raw.subarray(1, 13);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(13, raw.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), nonce);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString());
}

async function runPhoneFlow(account, session, prompt) {
    const { io } = await import('socket.io-client');
    const sessionId = session.id;
    const sessionKey = unsealDataKey(session.dataEncryptionKey, account.boxSecret);
    log(`session ${sessionId} data key unsealed`);

    const socket = io(SERVER, {
        auth: { token: account.token, clientType: 'user-scoped' },
        path: '/v1/updates',
        transports: ['websocket'],
        withCredentials: true,
    });
    const received = [];
    let doneResolve;
    const done = new Promise((r) => { doneResolve = r; });

    socket.on('connect', () => log('phone socket connected: ' + socket.id));
    socket.on('connect_error', (e) => log('socket connect error: ' + e.message));
    socket.on('update', (data) => {
        try {
            const body = data?.body;
            if (!body) return;
            if (body.t === 'new-message' && body.message?.content?.t === 'encrypted') {
                const decoded = decryptWithKey(body.message.content.c, sessionKey);
                received.push(decoded);
                const summary = decoded.role === 'agent'
                    ? `agent/${decoded.content?.type}: ${JSON.stringify(decoded.content?.data).slice(0, 140)}`
                    : JSON.stringify(decoded).slice(0, 140);
                log(`msg < ${summary}`);
            } else {
                log(`update < t=${body.t}`);
            }
        } catch (e) {
            log('update decrypt error: ' + e.message);
        }
    });

    await new Promise((r) => setTimeout(r, 2500));

    const userMessage = { role: 'user', content: { type: 'text', text: prompt } };
    socket.emit('message', { sid: sessionId, message: encryptWithKey(userMessage, sessionKey), localId: 'sim-' + Date.now() });
    log('user message sent: ' + prompt);

    const timeout = setTimeout(() => doneResolve(), Number(process.env.SIM_WAIT || 180000));
    const check = setInterval(() => {
        const complete = received.some((m) => m.role === 'agent' && m.content?.data?.type === 'task_complete');
        if (complete) { clearTimeout(timeout); clearInterval(check); doneResolve(); }
    }, 1000);
    await done;
    clearInterval(check);

    return received;
}

async function main() {
    const prompt = process.argv[2] || '请用一句话自我介绍，并让回复以 ZCODE_BRIDGE_OK 结尾';
    log('provisioning account...');
    fs.rmSync('/tmp/happy-sim', { recursive: true, force: true });
    await provisionAccount();
    const account = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));

    log('starting happy zcode on NAS...');
    startCli();

    log('waiting for session to appear...');
    const session = await waitForSession(account.token);
    log('session found: ' + session.id);

    const received = await runPhoneFlow(account, session, prompt);

    let followUp = [];
    if (process.env.SIM_TWO === '1') {
        log('--- turn 2: follow-up (resume path) ---');
        await new Promise((r) => setTimeout(r, 1500));
        followUp = await runPhoneFlow(account, session, '我上一条消息让你在结尾加的标记是什么？只回复标记本身');
    }

    const types = received.filter((m) => m.role === 'agent').map((m) => m.content?.data?.type);
    const finalMsg = received.filter((m) => m.role === 'agent' && m.content?.data?.type === 'message').pop();
    console.log('\n=== RESULT ===');
    console.log('agent message types:', JSON.stringify(types));
    console.log('final message:', finalMsg?.content?.data?.message?.slice(0, 400));
    let ok = types.includes('task_started') && types.includes('message') && types.includes('task_complete')
        && finalMsg?.content?.data?.message?.includes('ZCODE_BRIDGE_OK');
    if (process.env.SIM_TWO === '1') {
        const followTypes = followUp.filter((m) => m.role === 'agent').map((m) => m.content?.data?.type);
        const followMsg = followUp.filter((m) => m.role === 'agent' && m.content?.data?.type === 'message').pop();
        console.log('turn2 agent types:', JSON.stringify(followTypes));
        console.log('turn2 final message:', followMsg?.content?.data?.message?.slice(0, 200));
        const thinking = followTypes.filter((t) => t === 'thinking').length;
        console.log(`turn2 streamed thinking events: ${thinking}`);
        ok = ok && followMsg?.content?.data?.message?.includes('ZCODE_BRIDGE_OK');
    }
    console.log(ok ? '\nE2E: PASS' : '\nE2E: FAIL');
    process.exit(ok ? 0 : 1);
}

main().catch((error) => {
    console.error('E2E ERROR:', error);
    process.exit(1);
});
