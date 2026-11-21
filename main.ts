// main.ts — the process lifecycle the trial harness expects.
//
// The forge itself lives in app.ts. This file only wires it into a trial:
// pick a free port, hand that port to the harness environment, then wait
// until the environment reports the trial is finished.
//
// The five steps, in order:
//   1. Read MAKEFUN_ENV_URL. It is the environment's base URL
//      (http://store:8080 inside a trial container). If it is missing
//      there is no environment to talk to, so exit 1 immediately.
//   2. Start the app on port 0 and let the kernel choose a port.
//      Never bind 8080: that port belongs to the environment.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The environment
//      notes the caller's address plus N as this entry's base URL and
//      starts driving it. The first register wins; a 409 means another
//      entry registered first, and this process simply waits like the rest.
//   4. Poll GET $MAKEFUN_ENV_URL/done until the body reads {"done": true}.
//      The environment answers right away ({"done": false} while the suite
//      is still running), so this is a poll, not a held-open request.
//      A failed or slow poll is retried with a short exponential backoff;
//      the process never leaves before the environment says done.
//   5. Close the server and exit 0. The harness then stops the
//      environment, which writes the export the scorer reads.
//
// This file imports its own server and nothing else: no package, no Node
// built-in, no model call.

import { createApp } from './app.ts';

// The environment's origin, with any trailing slashes trimmed off.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Longest a single register or done request may run before it is dropped and retried. */
const REQUEST_TIMEOUT = 30_000;
/** First pause between retries, and the longest pause. */
const RETRY_FIRST_PAUSE = 250;
const RETRY_LONGEST_PAUSE = 2_000;

/** Resolve after `ms` milliseconds. */
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Pause after `failures` failed requests: exponential from RETRY_FIRST_PAUSE, capped. */
function nextPause(failures: number): number {
  return Math.min(RETRY_LONGEST_PAUSE, RETRY_FIRST_PAUSE * 2 ** Math.min(failures, 8));
}

/** Prefix of the error a contract failure raises; only those errors escape the retry loop. */
const CONTRACT_ERROR_PREFIX = 'register answered HTTP ';

/**
 * POST the bound port until the environment takes it. 200 is the usual
 * answer; 409 means an earlier register already won, which is not this
 * process's problem to fix. 400 and 405 are contract errors and end the
 * program; a network error or any other status is retried, since the
 * environment may still be coming up.
 */
async function register(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const answer = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`${CONTRACT_ERROR_PREFIX}${answer.status}: ${await answer.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(CONTRACT_ERROR_PREFIX)) throw err;
    }
    await pause(nextPause(failures));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const answer = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The environment is not answering yet, or the poll timed out: it is
      // not done, so poll again.
    }
    await pause(nextPause(failures));
  }
}

/** Bind a port, register it, then wait for the environment: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((started, failed) => {
    server.once('error', failed);
    server.listen(0, () => started());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await register(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
