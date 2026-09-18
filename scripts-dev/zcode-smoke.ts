// Smoke test for ZcodeBackend against the mock zcode CLI.
import { ZcodeBackend } from '../src/zcode/zcodeBackend';
import { chmodSync } from 'node:fs';

chmodSync('/tmp/zcode-smoke/mock-zcode.sh', 0o755);

let failures = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`, cond ? '' : extra ?? '');
    if (!cond) failures++;
};

async function main() {
    // 1. startSession validates the command
    const backend = new ZcodeBackend({ cwd: '/tmp/zcode-smoke', command: '/tmp/zcode-smoke/mock-zcode.sh' });
    const events: any[] = [];
    backend.onMessage((msg) => events.push(msg));

    const start = await backend.startSession();
    check('startSession ok', start.sessionId === 'zcode-headless');

    // 2. First turn: --json result parsed, sessionId captured, fullText emitted
    await backend.sendPrompt('x', 'first message');
    const fullText = events.find((e) => e.type === 'model-output' && e.fullText);
    check('first turn captured sessionId', (backend as any).zcodeSessionId === 'sess_mock_0001');
    check('first turn emitted fullText', fullText?.fullText === 'First turn response for: first message', fullText);

    // 3. Second turn: streamed deltas
    events.length = 0;
    await backend.sendPrompt('x', 'second message');
    const deltas = events.filter((e) => e.type === 'model-output' && e.textDelta).map((e) => e.textDelta).join('');
    check('second turn streamed deltas', deltas.includes('Streamed') && deltas.includes('reply for: second message'), JSON.stringify(deltas));

    // 4. Failure surfaces stderr cause
    backend.setMode('build');
    const mockFail = new ZcodeBackend({ cwd: '/tmp/zcode-smoke', command: '/tmp/zcode-smoke/mock-zcode-fail.sh' });
    chmodSync('/tmp/zcode-smoke/mock-zcode-fail.sh', 0o755);
    let errText = '';
    try {
        await mockFail.sendPrompt('x', 'boom');
    } catch (error) {
        errText = (error as Error).message;
    }
    check('failure produces error message', errText.includes('mock exploded'), errText);

    // 5. Missing command yields friendly error
    const missing = new ZcodeBackend({ cwd: '/tmp/zcode-smoke', command: '/tmp/zcode-smoke/does-not-exist' });
    let missingErr = '';
    try {
        await missing.startSession();
    } catch (error) {
        missingErr = (error as Error).message;
    }
    check('missing command gives install hint', missingErr.includes('Is the zcode CLI installed'), missingErr);

    // 6. resetSession clears id
    backend.resetSession();
    check('resetSession clears id', (backend as any).zcodeSessionId === null);

    await backend.dispose();
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('SMOKE TEST CRASHED', error);
    process.exit(1);
});
