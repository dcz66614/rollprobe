/**
 * Discard-and-retry, as a self-contained unit so its ordering can be tested directly.
 *
 * The rule that matters: the retry is only allowed to happen after the proxy has consumed the
 * first response *and* proven on an independent connection that the business effect is
 * committed. If either step cannot be proven, this function fails closed — it returns without
 * ever issuing the second request. Sending the retry anyway would mean the tool itself creates
 * business operations it cannot account for.
 */

import type { EventLogger } from '@rollprobe/evidence';
import type { DiscardProxyHandle } from '@rollprobe/oracle';
import { HttpExecutor, type HttpExecutionResult, type HttpRequestSpec } from '@rollprobe/scenario';

export interface DiscardRetrySpec {
  target: 'old' | 'new';
  retryTarget: 'old' | 'new';
  logicalOperationId: string;
  idempotencyKey: string;
  request: HttpRequestSpec;
  effectSql: string;
  effectExpectedMin: number;
}

export interface DiscardRetryDeps {
  /** Starts a proxy bound to an independent observer connection. */
  startProxy: () => Promise<DiscardProxyHandle>;
  targetUrl: (version: 'old' | 'new') => string;
}

export interface DiscardRetryOutcome {
  status: 'ok' | 'failed';
  /** True when the retry was suppressed because the first effect could not be proven. */
  failClosed: boolean;
  retried: boolean;
  detail: Record<string, unknown>;
  firstAttempt?: HttpExecutionResult;
  retryAttempt?: HttpExecutionResult;
  effectCount?: number;
}

export async function executeDiscardRetry(
  spec: DiscardRetrySpec,
  deps: DiscardRetryDeps
): Promise<DiscardRetryOutcome> {
  const handle = await deps.startProxy();

  try {
    const firstAttempt = await new HttpExecutor(handle.url).execute(spec.request, {
      extraHeaders: {
        'x-rollprobe-upstream': deps.targetUrl(spec.target),
        'x-rollprobe-effect-sql': spec.effectSql,
        'x-rollprobe-effect-min': String(spec.effectExpectedMin),
        'x-rollprobe-logical-op': spec.logicalOperationId,
        'idempotency-key': spec.idempotencyKey,
      },
    });

    const record = handle.records[handle.records.length - 1];

    // (a) the proxy must have been able to prove the effect; when it could not, it answers
    // with an explicit error instead of faking a transport fault.
    if (record && !record.discarded) {
      return {
        status: 'failed',
        failClosed: true,
        retried: false,
        detail: {
          stage: 'effect-confirmation',
          error: `proxy did not confirm the committed effect: ${record.reason ?? 'no reason recorded'}`,
          effectCount: record.effectCount,
        },
        firstAttempt,
      };
    }

    // (b) the client must genuinely have lost the response
    if (firstAttempt.transportError === undefined) {
      return {
        status: 'failed',
        failClosed: true,
        retried: false,
        detail: {
          stage: 'discard',
          error: 'expected a transport fault, but the client received a response',
          upstreamStatus: firstAttempt.status,
        },
        firstAttempt,
      };
    }

    if (!record) {
      return {
        status: 'failed',
        failClosed: true,
        retried: false,
        detail: { stage: 'effect-confirmation', error: 'proxy produced no discard record' },
        firstAttempt,
      };
    }

    // Only now is a retry a faithful simulation of a lost response.
    const retryAttempt = await new HttpExecutor(deps.targetUrl(spec.retryTarget)).execute(spec.request, {
      extraHeaders: { 'idempotency-key': spec.idempotencyKey },
    });

    if (retryAttempt.status === null) {
      return {
        status: 'failed',
        failClosed: false,
        retried: true,
        detail: { stage: 'retry', error: `retry failed at the transport layer: ${retryAttempt.transportError}` },
        firstAttempt,
        retryAttempt,
        effectCount: record.effectCount,
      };
    }

    return {
      status: 'ok',
      failClosed: false,
      retried: true,
      detail: {
        discarded: true,
        effectCount: record.effectCount,
        upstreamStatus: record.upstreamStatus,
        retryStatus: retryAttempt.status,
      },
      firstAttempt,
      retryAttempt,
      effectCount: record.effectCount,
    };
  } finally {
    await handle.close();
  }
}

/** Convenience for logging: the proxy records are already persisted by the logger. */
export function discardLogHint(logger?: EventLogger): EventLogger | undefined {
  return logger;
}
