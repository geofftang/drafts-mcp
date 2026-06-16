/**
 * Tests for DraftsClient.
 *
 * In Jest ESM mode, jest.mock() does not hoist for static imports.
 * We use jest.unstable_mockModule() + dynamic import() to mock child_process.
 *
 * The mock intercepts execFile (and therefore promisify(execFile)) by replacing
 * the module before DraftsClient is imported.
 */

import { jest } from '@jest/globals';

// Shared mutable state for the execFile implementation so tests can control it.
type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;
type ExecFileImpl = (cmd: string, args: string[], cb: ExecFileCb) => void;

let execFileImpl: ExecFileImpl = (_cmd, _args, cb) => cb(null, '', '');

await jest.unstable_mockModule('child_process', () => ({
  execFile: (cmd: string, args: string[], cb: ExecFileCb) => execFileImpl(cmd, args, cb),
}));

// Dynamic imports AFTER mock is set up
const { DraftsClient } = await import('../drafts-client.js');
const { CallbackServer } = await import('../callback-server.js');

describe('DraftsClient', () => {
  let callbackServer: InstanceType<typeof CallbackServer>;
  let draftsClient: InstanceType<typeof DraftsClient>;

  beforeEach(async () => {
    // Reset mock to no-op success before each test
    execFileImpl = (_cmd, _args, cb) => cb(null, '', '');
    callbackServer = new CallbackServer();
    await callbackServer.start();
    draftsClient = new DraftsClient(callbackServer, { maxRetries: 2, retryDelay: 10 });
  });

  afterEach(async () => {
    await callbackServer.stop();
    execFileImpl = (_cmd, _args, cb) => cb(null, '', '');
  });

  it('should construct client with callback server', () => {
    expect(draftsClient).toBeDefined();
  });

  it('should use default config values', () => {
    const client = new DraftsClient(callbackServer);
    expect(client).toBeDefined();
  });

  describe('buildUrl', () => {
    it('builds a valid drafts:// x-callback-url with correct endpoint and params', async () => {
      let capturedUrl: string | undefined;

      execFileImpl = (_cmd, args, cb) => {
        capturedUrl = args[0];
        const url = new URL(capturedUrl);
        const successCallback = url.searchParams.get('x-success')!;
        // Fire x-success so the operation completes
        fetch(successCallback + '?text=hello').catch(() => {});
        cb(null, '', '');
      };

      await draftsClient.getDraft('test-uuid-123');

      expect(capturedUrl).toBeDefined();
      const parsed = new URL(capturedUrl!);
      expect(parsed.protocol).toBe('drafts:');
      expect(parsed.hostname).toBe('x-callback-url');
      expect(parsed.pathname).toBe('/get');
      expect(parsed.searchParams.get('uuid')).toBe('test-uuid-123');
      expect(parsed.searchParams.get('x-success')).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/x-success\//
      );
      expect(parsed.searchParams.get('x-error')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/x-error\//);
      expect(parsed.searchParams.get('x-cancel')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/x-cancel\//);
    });

    it('generates a unique requestId per call', async () => {
      const seenRequestIds = new Set<string>();

      execFileImpl = (_cmd, args, cb) => {
        const url = new URL(args[0]);
        const successUrl = url.searchParams.get('x-success')!;
        const requestId = successUrl.split('/x-success/')[1];
        seenRequestIds.add(requestId);
        fetch(successUrl).catch(() => {});
        cb(null, '', '');
      };

      await draftsClient.appendToDraft('uuid-1', 'some text');
      await draftsClient.appendToDraft('uuid-2', 'other text');

      expect(seenRequestIds.size).toBe(2);
    });
  });

  describe('retry behaviour', () => {
    it('retries the launch on transient failure and eventually succeeds', async () => {
      let callCount = 0;

      execFileImpl = (_cmd, args, cb) => {
        callCount++;
        if (callCount < 3) {
          cb(new Error('open: command failed'), '', '');
          return;
        }
        const url = new URL(args[0]);
        const successUrl = url.searchParams.get('x-success')!;
        fetch(successUrl).catch(() => {});
        cb(null, '', '');
      };

      await draftsClient.appendToDraft('uuid-retry', 'retry test');
      // maxRetries=2 means 3 total attempts (0, 1, 2)
      expect(callCount).toBe(3);
    });

    it('throws after exhausting all retries without success', async () => {
      execFileImpl = (_cmd, _args, cb) => {
        cb(new Error('launch failed'), '', '');
      };

      await expect(draftsClient.appendToDraft('uuid-fail', 'text')).rejects.toThrow(
        'launch failed'
      );
    });

    it('does NOT retry when a successful launch gets a Drafts error callback (write idempotency)', async () => {
      // After a successful launch, a Drafts-side error must NOT trigger a re-launch.
      // If it did, writes (create/append/prepend) could be duplicated.
      let launchCount = 0;

      execFileImpl = (_cmd, args, cb) => {
        launchCount++;
        // Launch succeeds
        cb(null, '', '');
        // Drafts fires x-error some time after launch
        const url = new URL(args[0]);
        const errorUrl = url.searchParams.get('x-error')!;
        // Use URL-safe encoding: fetch with query param
        const errorWithParam = `${errorUrl}?error=drafts+rejected`;
        setTimeout(() => fetch(errorWithParam).catch(() => {}), 20);
      };

      await expect(draftsClient.appendToDraft('uuid-once', 'text')).rejects.toThrow(
        'drafts rejected'
      );

      // The launch was called exactly once — not retried on callback error
      expect(launchCount).toBe(1);
    });

    it('cancels the pending request when all launch retries are exhausted', async () => {
      const cancelSpy = jest.spyOn(callbackServer, 'cancelRequest');

      execFileImpl = (_cmd, _args, cb) => {
        cb(new Error('launch failed permanently'), '', '');
      };

      await expect(draftsClient.createDraft({ text: 'hello' })).rejects.toThrow(
        'launch failed permanently'
      );

      // cancelRequest must be called so the pending callback doesn't orphan
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });
  });
});
