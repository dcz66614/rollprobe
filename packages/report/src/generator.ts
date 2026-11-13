/**
 * Offline HTML report.
 *
 * The output is a single self-contained file: no CDN, no external CSS, no JavaScript
 * required to read it. Every number in it comes from run.json / checks.json / coverage.json
 * produced by a real campaign, never from the scenario's declared expectations.
 */

import type { CampaignResult } from '@rollprobe/core';

/** Structural mirror of the shrinker result, so the report does not depend on it. */
export interface ShrinkReport {
  scenarioId: string;
  oldMode: string;
  originalOperations: string[];
  reducedOperations: string[];
  removedOperations: string[];
  reproduced: boolean;
  oneMinimal: boolean;
  signature: { status: string; violated: string[] };
  runs: Array<{
    index: number;
    candidateOperations: string[];
    removed: string[];
    status: string;
    violated: string[];
    reproduced: boolean;
    durationMs: number;
    error?: string;
  }>;
}

export interface ReportRun {
  result: CampaignResult;
  shrink?: ShrinkReport;
  bundle?: { zipPath: string; manifestSha256: string; verified: boolean; checkedFiles: number };
  eventCount?: number;
}

export interface ReportInput {
  title?: string;
  runs: ReportRun[];
  generatedAt?: string;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusClass(status: string): string {
  switch (status) {
    case 'BOUNDED_PASS':
    case 'satisfied':
    case 'ok':
      return 'ok';
    case 'VIOLATION':
    case 'violated':
    case 'failed':
      return 'bad';
    default:
      return 'warn';
  }
}

function renderCoverageRow(entry: CampaignResult['coverage']['entries'][number]): string {
  return `<tr>
    <td><code>${escapeHtml(entry.invariantId)}</code></td>
    <td>${escapeHtml(entry.title)}</td>
    <td>${escapeHtml(entry.authority)}</td>
    <td>${escapeHtml(entry.requirement)}</td>
    <td><span class="pill ${statusClass(entry.status)}">${escapeHtml(entry.status)}</span></td>
  </tr>`;
}

function renderCheck(check: CampaignResult['checks'][number]): string {
  return `<tr>
    <td><code>${escapeHtml(check.invariantId)}</code></td>
    <td><span class="pill ${statusClass(check.status)}">${escapeHtml(check.status)}</span></td>
    <td>${escapeHtml(check.reason ?? '')}</td>
    <td><code>${escapeHtml(JSON.stringify(check.observed ?? null))}</code></td>
    <td><code>${escapeHtml(JSON.stringify(check.expected ?? null))}</code></td>
  </tr>`;
}

function renderOperation(op: CampaignResult['operations'][number]): string {
  const detail = op.detail ? JSON.stringify(op.detail) : '';
  return `<tr>
    <td><code>${escapeHtml(op.operationId)}</code></td>
    <td>${escapeHtml(op.kind)}</td>
    <td>${escapeHtml(op.phase)}</td>
    <td>${escapeHtml(op.actor)}</td>
    <td><span class="pill ${statusClass(op.status)}">${escapeHtml(op.status)}</span></td>
    <td>${op.durationMs} ms</td>
    <td><code class="small">${escapeHtml(detail.slice(0, 220))}</code></td>
  </tr>`;
}

function renderShrink(shrink: ShrinkReport): string {
  return `<h3>Causal reduction</h3>
    <table>
      <tr><th>Operations before</th><td>${shrink.originalOperations.length}</td></tr>
      <tr><th>Operations after</th><td>${shrink.reducedOperations.length}</td></tr>
      <tr><th>Removed</th><td><code>${escapeHtml(shrink.removedOperations.join(', ') || '(none)')}</code></td></tr>
      <tr><th>Failure signature</th><td><code>${escapeHtml(shrink.signature.violated.join(', '))}</code></td></tr>
      <tr><th>1-minimal</th><td><span class="pill ${shrink.oneMinimal ? 'ok' : 'warn'}">${shrink.oneMinimal ? 'proven' : 'not proven'}</span></td></tr>
      <tr><th>Replays executed</th><td>${shrink.runs.length}</td></tr>
    </table>
    <table><thead><tr><th>#</th><th>Candidate</th><th>Status</th><th>Reproduced</th><th>Duration</th></tr></thead>
      <tbody>${shrink.runs
        .map(
          (step) => `<tr>
            <td>${step.index}</td>
            <td><code class="small">${escapeHtml(step.candidateOperations.join(' → '))}</code></td>
            <td><span class="pill ${statusClass(step.status)}">${escapeHtml(step.status)}</span></td>
            <td>${step.reproduced ? 'yes' : 'no'}</td>
            <td>${(step.durationMs / 1000).toFixed(1)}s</td>
          </tr>`
        )
        .join('')}</tbody></table>`;
}

function renderRun(run: ReportRun): string {
  const { result } = run;
  const db = result.environment.database;
  const apps = result.environment.apps;

  return `<section class="run">
    <h2>${escapeHtml(result.scenarioId)} <span class="pill ${statusClass(result.status)}">${escapeHtml(result.status)}</span></h2>
    <p class="muted">${escapeHtml(result.scenarioTitle)} &middot; control build <strong>${escapeHtml(result.oldMode)}</strong> &middot; run <code>${escapeHtml(result.runId)}</code></p>

    <div class="grid">
      <div class="card"><span class="k">Invariants planned</span><span class="v">${result.coverage.summary.totalPlanned}</span></div>
      <div class="card"><span class="k">Executed</span><span class="v">${result.coverage.summary.totalExecuted}</span></div>
      <div class="card"><span class="k">Satisfied</span><span class="v">${result.coverage.summary.totalSatisfied}</span></div>
      <div class="card"><span class="k">Violated</span><span class="v">${result.coverage.summary.totalViolations}</span></div>
      <div class="card"><span class="k">Inconclusive</span><span class="v">${result.coverage.summary.totalInconclusive}</span></div>
      <div class="card"><span class="k">Duration</span><span class="v">${(result.durationMs / 1000).toFixed(1)}s</span></div>
    </div>

    <h3>Determination</h3>
    <ul>${result.determination.reasoning.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
    ${result.error ? `<p class="error">Environment error: ${escapeHtml(result.error)}</p>` : ''}

    <h3>Environment</h3>
    <table>
      <tr><th>PostgreSQL container</th><td><code>${escapeHtml(db?.containerName ?? 'n/a')}</code></td></tr>
      <tr><th>Container id</th><td><code>${escapeHtml(db?.containerId ?? 'n/a')}</code></td></tr>
      <tr><th>Server version</th><td><code>${escapeHtml(db?.postgresVersion ?? 'n/a')}</code></td></tr>
      <tr><th>Endpoint</th><td><code>${escapeHtml(db ? `${db.host}:${db.port}` : 'n/a')}</code></td></tr>
      <tr><th>Applications</th><td><code>${escapeHtml(
        apps.map((app) => `${app.version}/${app.mode} pid ${app.pid} :${app.port}`).join('  |  ')
      )}</code></td></tr>
    </table>

    <h3>Coverage (planned denominator)</h3>
    <table><thead><tr><th>Invariant</th><th>Title</th><th>Authority</th><th>Requirement</th><th>Status</th></tr></thead>
      <tbody>${result.coverage.entries.map(renderCoverageRow).join('')}</tbody></table>

    <h3>Checks</h3>
    <table><thead><tr><th>Invariant</th><th>Status</th><th>Reason</th><th>Observed</th><th>Expected</th></tr></thead>
      <tbody>${result.checks.map(renderCheck).join('')}</tbody></table>

    <h3>Operations</h3>
    <table><thead><tr><th>Operation</th><th>Kind</th><th>Phase</th><th>Actor</th><th>Status</th><th>Duration</th><th>Detail</th></tr></thead>
      <tbody>${result.operations.map(renderOperation).join('')}</tbody></table>

    ${run.shrink ? renderShrink(run.shrink) : ''}

    ${run.bundle
      ? `<h3>Evidence bundle</h3>
         <table>
           <tr><th>Archive</th><td><code>${escapeHtml(run.bundle.zipPath)}</code></td></tr>
           <tr><th>Manifest SHA-256</th><td><code>${escapeHtml(run.bundle.manifestSha256)}</code></td></tr>
           <tr><th>Files verified</th><td>${run.bundle.checkedFiles}</td></tr>
           <tr><th>Verification</th><td><span class="pill ${run.bundle.verified ? 'ok' : 'bad'}">${run.bundle.verified ? 'verified' : 'failed'}</span></td></tr>
         </table>`
      : ''}
  </section>`;
}

export function renderReport(input: ReportInput): string {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const overall = input.runs.some((run) => run.result.status === 'VIOLATION')
    ? 'VIOLATION'
    : input.runs.every((run) => run.result.status === 'BOUNDED_PASS')
      ? 'BOUNDED_PASS'
      : 'INCONCLUSIVE';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title ?? 'Rollprobe report')}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #f7f8fa; color: #14181f; line-height: 1.55; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 20px; margin: 32px 0 6px; display: flex; gap: 10px; align-items: center; }
  h3 { font-size: 15px; margin: 22px 0 8px; text-transform: uppercase; letter-spacing: .06em; color: #5a6472; }
  .muted { color: #5a6472; margin: 0 0 14px; font-size: 13px; }
  .run { background: #fff; border: 1px solid #e3e7ee; border-radius: 12px; padding: 22px 24px; margin-bottom: 26px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; background: #fff; }
  th, td { border-bottom: 1px solid #eceff4; padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f4f6f9; font-weight: 600; font-size: 12px; color: #47505d; }
  code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
  code.small { font-size: 11px; color: #47505d; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin: 12px 0 4px; }
  .card { background: #f8fafc; border: 1px solid #e6eaf1; border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; }
  .card .k { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #6b7482; }
  .card .v { font-size: 22px; font-weight: 650; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 650; letter-spacing: .02em; }
  .pill.ok { background: #e5f6ec; color: #10693c; }
  .pill.bad { background: #fdeaea; color: #8f1d1d; }
  .pill.warn { background: #fdf3dd; color: #7a5310; }
  .error { background: #fdeaea; border-left: 3px solid #c0392b; padding: 8px 12px; border-radius: 6px; }
  footer { margin-top: 28px; color: #6b7482; font-size: 12px; }
</style>
</head>
<body>
  <h1>${escapeHtml(input.title ?? 'Rollprobe campaign report')}</h1>
  <p class="muted">Generated ${escapeHtml(generatedAt)} &middot; overall <span class="pill ${statusClass(overall)}">${escapeHtml(overall)}</span></p>
  ${input.runs.map(renderRun).join('\n')}
  <footer>Rollprobe &mdash; local-first rolling deployment verification. This report is static and requires no network access.</footer>
</body>
</html>`;
}
