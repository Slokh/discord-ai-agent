import type { PgBoss } from "pg-boss";
import { logger } from "../util/logger.js";
import type { ReminderWakeup } from "../db/reminderRepository.js";

export const REMINDER_DELIVERY_JOB = "reminder.deliver";
export const REMINDER_RECONCILIATION_JOB = "reminder.reconcile";
export const REMINDER_RECONCILIATION_CRON = "* * * * *";

type ReminderDeliveryJob = { reminderId: string };

export type ReminderJobRunner = {
  deliver: (reminderId: string) => Promise<ReminderWakeup | null>;
  listDueReminderWakeups: () => Promise<ReminderWakeup[]>;
};

export async function configureReminderQueues(boss: PgBoss) {
  await boss.createQueue(REMINDER_DELIVERY_JOB, { policy: "short", retryLimit: 5, retryDelay: 15, retryBackoff: true });
  await boss.updateQueue(REMINDER_DELIVERY_JOB, { retryLimit: 5, retryDelay: 15, retryBackoff: true });
  await boss.createQueue(REMINDER_RECONCILIATION_JOB, { policy: "short", retryLimit: 2, retryDelay: 30, retryBackoff: true });
  await boss.updateQueue(REMINDER_RECONCILIATION_JOB, { retryLimit: 2, retryDelay: 30, retryBackoff: true });
}

export async function enqueueReminderDelivery(boss: PgBoss, reminderId: string, scheduledFor: Date) {
  return (await boss.send(REMINDER_DELIVERY_JOB, { reminderId }, {
    singletonKey: `${reminderId}:${scheduledFor.toISOString()}`,
    startAfter: scheduledFor,
    retryLimit: 5,
    retryDelay: 15,
    retryBackoff: true,
  })) ?? null;
}

export async function registerReminderWorkers(boss: PgBoss, runner: ReminderJobRunner) {
  await boss.work<ReminderDeliveryJob>(REMINDER_DELIVERY_JOB, { batchSize: 10, pollingIntervalSeconds: 1 }, async (jobs) => {
    await Promise.all(jobs.map(async (job) => {
      const next = await runner.deliver(job.data.reminderId);
      if (next) await enqueueReminderDelivery(boss, next.reminderId, next.scheduledFor);
    }));
  });
  await boss.work(REMINDER_RECONCILIATION_JOB, { batchSize: 1, pollingIntervalSeconds: 2 }, async () => {
    const reminders = await runner.listDueReminderWakeups();
    for (let index = 0; index < reminders.length; index += 25) {
      await Promise.all(reminders.slice(index, index + 25).map((reminder) => enqueueReminderDelivery(boss, reminder.reminderId, reminder.scheduledFor)));
    }
    logger.info({ queue: REMINDER_RECONCILIATION_JOB, dueCount: reminders.length }, "Reminder reconciliation complete");
  });
  await boss.schedule(REMINDER_RECONCILIATION_JOB, REMINDER_RECONCILIATION_CRON);
  await boss.send(REMINDER_RECONCILIATION_JOB, {});
}
