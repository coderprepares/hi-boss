import type { WechatClawbotDoctorResult } from "./doctor.js";
import type { WechatClawbotMonitorResult, WechatClawbotMonitorStatusResult } from "./monitor.js";

function valueOrNone(value: unknown): string {
  return value === undefined || value === null || value === "" ? "(none)" : String(value);
}

export function buildWechatClawbotMonitorAlertText(doctor: WechatClawbotDoctorResult): string {
  const summary = doctor.summary;
  const lines = [
    `Hi-Boss WeChat monitor: ${doctor.status}`,
    `pending-outbox: ${valueOrNone(summary.pendingOutbox)}`,
    `sent-messages: ${valueOrNone(summary.sentMessages)}`,
    `last-sent-at: ${valueOrNone(summary.lastSentAt)}`,
    `ilink-poll-in-flight: ${valueOrNone(summary.ilinkPollInFlight)}`,
    `ilink-poll-current-duration-ms: ${valueOrNone(summary.ilinkPollCurrentDurationMs)}`,
    `ilink-poll-last-duration-ms: ${valueOrNone(summary.ilinkPollLastDurationMs)}`,
    `ilink-poll-consecutive-failures: ${valueOrNone(summary.ilinkPollConsecutiveFailures)}`,
    `hiboss-cursor-matches-sidecar: ${valueOrNone(summary.hibossCursorMatchesSidecar)}`,
    `hiboss-recent-wechat-poll-failures: ${valueOrNone(summary.hibossRecentWechatPollFailures)}`,
    `issue-count: ${doctor.issues.length}`,
  ];
  doctor.issues.forEach((issue, index) => {
    lines.push(`issue-${index + 1}: ${issue.level} ${issue.name} - ${issue.message}`);
  });
  return lines.join("\n");
}

export function formatWechatClawbotMonitorResult(result: WechatClawbotMonitorResult): string {
  const summary = result.doctor.summary;
  const lines = [
    `ok: ${result.ok ? "true" : "false"}`,
    `run-at: ${result.runAt}`,
    `monitor-status: ${result.monitorStatus}`,
    `doctor-status: ${result.doctor.status}`,
    `notified: ${result.notified ? "true" : "false"}`,
    `dry-run: ${result.dryRun ? "true" : "false"}`,
    `cooldown-active: ${result.cooldownActive ? "true" : "false"}`,
    `grace-active: ${result.graceActive ? "true" : "false"}`,
    `cooldown-file: ${valueOrNone(result.cooldownFile)}`,
    `cooldown-until: ${valueOrNone(result.cooldownUntil)}`,
    `grace-until: ${valueOrNone(result.graceUntil)}`,
    `envelope-id: ${valueOrNone(result.envelopeId)}`,
    `notification-error: ${valueOrNone(result.notificationError)}`,
    `pending-outbox: ${valueOrNone(summary.pendingOutbox)}`,
    `sent-messages: ${valueOrNone(summary.sentMessages)}`,
    `last-sent-at: ${valueOrNone(summary.lastSentAt)}`,
    `ilink-poll-in-flight: ${valueOrNone(summary.ilinkPollInFlight)}`,
    `ilink-poll-current-duration-ms: ${valueOrNone(summary.ilinkPollCurrentDurationMs)}`,
    `ilink-poll-last-duration-ms: ${valueOrNone(summary.ilinkPollLastDurationMs)}`,
    `ilink-poll-consecutive-failures: ${valueOrNone(summary.ilinkPollConsecutiveFailures)}`,
    `hiboss-cursor-matches-sidecar: ${valueOrNone(summary.hibossCursorMatchesSidecar)}`,
    `hiboss-recent-wechat-poll-failures: ${valueOrNone(summary.hibossRecentWechatPollFailures)}`,
    `issue-count: ${result.doctor.issues.length}`,
  ];
  result.doctor.issues.forEach((issue, index) => {
    const prefix = `issue-${index + 1}`;
    lines.push(`${prefix}-level: ${issue.level}`);
    lines.push(`${prefix}-name: ${issue.name}`);
    lines.push(`${prefix}-message: ${issue.message}`);
  });
  return lines.join("\n");
}

export function formatWechatClawbotMonitorStatusResult(result: WechatClawbotMonitorStatusResult): string {
  return [
    `ok: ${result.ok ? "true" : "false"}`,
    `max-age-minutes: ${result.maxAgeMinutes}`,
    `cron-file: ${result.cronFile}`,
    `cron-file-exists: ${result.cronFileExists ? "true" : "false"}`,
    `cron-command-present: ${valueOrNone(result.cronCommandPresent)}`,
    `cron-notify-target-configured: ${valueOrNone(result.cronNotifyTargetConfigured)}`,
    `cron-active: ${valueOrNone(result.cronActive)}`,
    `log-file: ${result.logFile}`,
    `log-file-exists: ${result.logFileExists ? "true" : "false"}`,
    `last-run-at: ${valueOrNone(result.lastRunAt)}`,
    `last-run-fresh: ${valueOrNone(result.lastRunFresh)}`,
    `last-run-age-seconds: ${valueOrNone(result.lastRunAgeSeconds)}`,
    `last-monitor-status: ${valueOrNone(result.lastMonitorStatus)}`,
    `last-doctor-status: ${valueOrNone(result.lastDoctorStatus)}`,
    `last-notified: ${valueOrNone(result.lastNotified)}`,
    `last-issue-count: ${valueOrNone(result.lastIssueCount)}`,
  ].join("\n");
}
