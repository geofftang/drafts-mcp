import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { CallbackServer } from './callback-server.js';
import { Draft } from './types.js';

const execFileAsync = promisify(execFile);

export interface DraftsClientConfig {
  maxRetries?: number;
  retryDelay?: number;
}

export type BuiltDraftsUrl = { url: string; requestId: string };

export class DraftsClient {
  private callbackServer: CallbackServer;
  private maxRetries: number;
  private retryDelay: number;

  constructor(callbackServer: CallbackServer, config: DraftsClientConfig = {}) {
    this.callbackServer = callbackServer;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
  }

  private buildUrl(
    endpoint: string,
    params: Record<string, string | string[] | boolean | undefined>
  ): BuiltDraftsUrl {
    const requestId = randomUUID();
    const callbacks = this.callbackServer.getCallbackUrls(requestId);

    const urlParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;

      if (Array.isArray(value)) {
        value.forEach((v) => urlParams.append(key, v));
      } else if (typeof value === 'boolean') {
        urlParams.append(key, value.toString());
      } else {
        urlParams.append(key, value);
      }
    }

    urlParams.append('x-success', callbacks.success);
    urlParams.append('x-error', callbacks.error);
    urlParams.append('x-cancel', callbacks.cancel);

    return {
      url: `drafts://x-callback-url/${endpoint}?${urlParams.toString()}`,
      requestId,
    };
  }

  private async openUrl(url: string, requestId: string): Promise<Record<string, string>> {
    // Register the pending callback BEFORE launching so we never miss a fast response.
    const responsePromise = this.callbackServer.registerRequest(requestId);

    // Retry only the launch (transport-safe, idempotent before Drafts acts).
    // The callback await is NOT retried — a write that succeeds in Drafts but
    // loses its callback must not be re-sent (duplicate draft risk).
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.retryDelay * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        await execFileAsync('open', [url]);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError !== undefined) {
      // Launch failed after all retries — cancel the pending request so it
      // doesn't orphan until the 30s timeout.
      // Attach a no-op catch to prevent an unhandled promise rejection when
      // cancelRequest rejects responsePromise (which we're about to abandon).
      responsePromise.catch(() => {});
      this.callbackServer.cancelRequest(requestId);
      throw lastError;
    }

    // Launch succeeded; now wait for the x-callback-url response exactly once.
    const response = await responsePromise;

    if (!response.success) {
      throw new Error(response.error || 'Unknown error from Drafts');
    }

    return response.data || {};
  }

  async createDraft(params: {
    text: string;
    tags?: string[];
    action?: string;
    folder?: 'inbox' | 'archive';
  }): Promise<void> {
    const { url, requestId } = this.buildUrl('create', {
      text: params.text,
      tag: params.tags,
      action: params.action,
      folder: params.folder,
    });

    await this.openUrl(url, requestId);
  }

  async getDraft(uuid: string): Promise<Draft> {
    const { url, requestId } = this.buildUrl('get', {
      uuid,
    });

    const response = await this.openUrl(url, requestId);

    // A successful callback means the draft exists. A missing `text` field just
    // means the draft is empty (a valid state) — not an error. A non-existent
    // UUID would have come back via the x-error callback and already thrown.
    const content = response.text ?? '';
    const title = response.title || content.split('\n')[0] || '';
    const tags = response.tags ? response.tags.split(',') : [];

    return {
      uuid,
      title,
      content,
      tags,
      createdAt: response.createdAt || '',
      modifiedAt: response.modifiedAt || '',
      isFlagged: response.flagged === 'true',
      isArchived: response.archived === 'true',
      isTrashed: response.trashed === 'true',
    };
  }

  async appendToDraft(uuid: string, text: string): Promise<void> {
    const { url, requestId } = this.buildUrl('append', {
      uuid,
      text,
    });

    await this.openUrl(url, requestId);
  }

  async prependToDraft(uuid: string, text: string): Promise<void> {
    const { url, requestId } = this.buildUrl('prepend', {
      uuid,
      text,
    });

    await this.openUrl(url, requestId);
  }

  async openDraft(params: { uuid?: string; title?: string }): Promise<void> {
    if (!params.uuid && !params.title) {
      throw new Error('Either uuid or title must be provided');
    }

    const { url, requestId } = this.buildUrl('open', {
      uuid: params.uuid,
      title: params.title,
    });

    await this.openUrl(url, requestId);
  }

  async runAction(actionName: string, text: string): Promise<void> {
    const { url, requestId } = this.buildUrl('runAction', {
      action: actionName,
      text,
    });

    await this.openUrl(url, requestId);
  }

  async searchDrafts(params: {
    query?: string;
    tag?: string;
    folder?: 'inbox' | 'archive' | 'flagged' | 'trash' | 'all';
  }): Promise<void> {
    const { url, requestId } = this.buildUrl('search', {
      query: params.query,
      tag: params.tag,
      folder: params.folder,
    });

    await this.openUrl(url, requestId);
  }
}
