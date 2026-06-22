import { ddb, SERVICES_TABLE, USERS_TABLE } from "./dynamodb";
import { ScanCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { sendPaymentReminderEmail } from "./email";
import { sendWhatsappMessage } from "./whatsapp";
import { emailApiKey, supportEmail, appUrl, whatsappEnabled } from "./config";
import { formatMoney } from "./money";

function isSameDay(dateA: string, dateB: Date): boolean {
  const a = new Date(dateA);
  return (
    a.getUTCFullYear() === dateB.getUTCFullYear() &&
    a.getUTCMonth() === dateB.getUTCMonth() &&
    a.getUTCDate() === dateB.getUTCDate()
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("es-ES", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function advanceOneMonth(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  if (d.getUTCDate() !== day) {
    d.setUTCDate(0);
  }
  return d.toISOString();
}

export async function checkAndSendPaymentReminders(): Promise<number> {
  let lastEvaluatedKey: Record<string, any> | undefined = undefined;
  const servicesToNotify: any[] = [];
  const now = new Date();

  do {
    const result: any = await ddb.send(
      new ScanCommand({
        TableName: SERVICES_TABLE,
        FilterExpression: "#st = :active AND #mp > :zero",
        ExpressionAttributeNames: {
          "#st": "status",
          "#mp": "monthpay",
        },
        ExpressionAttributeValues: {
          ":active": "active",
          ":zero": 0,
        },
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    if (result.Items) {
      const todayStr = now.toISOString().split("T")[0];
      for (const item of result.Items) {
        const expiryDate = item.expiryDate;
        if (!expiryDate) continue;

        const lastNotified = item.lastPaymentNotificationSent || null;
        if (lastNotified && isSameDay(lastNotified, now)) continue;

        const expiryDay = new Date(expiryDate).toISOString().split("T")[0];
        if (expiryDay !== todayStr) continue;

        servicesToNotify.push(item);
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  if (servicesToNotify.length === 0) return 0;

  let notifiedCount = 0;

  for (const service of servicesToNotify) {
    try {
      let userName = service.userEmail || "Cliente";
      let phoneNumber: string | null = null;

      if (service.userId) {
        const userResult = await ddb.send(
          new GetCommand({
            TableName: USERS_TABLE,
            Key: { uid: service.userId },
          })
        );
        if (userResult.Item) {
          userName = userResult.Item.name || userName;
          phoneNumber = userResult.Item.phone || null;
        }
      }

      const currency = service.currency || "USD";
      const amount = formatMoney(service.monthpay, currency);
      const dueDateStr = formatDate(service.expiryDate);

      await sendPaymentReminderEmail({
        apiKey: emailApiKey.value(),
        supportEmail: supportEmail.value(),
        appUrl: appUrl.value(),
        to: service.userEmail || "",
        userName,
        serviceName: service.serviceName,
        monthpay: service.monthpay,
        currency,
        dueDate: dueDateStr,
      });

      if (whatsappEnabled.value() === "true" && phoneNumber) {
        const waMessage = [
          `Hola ${userName},`,
          "",
          `Te recordamos que tu pago mensual de ${amount} por el servicio "${service.serviceName}" vence el ${dueDateStr}.`,
          "Por favor realiza el pago a tiempo para evitar la suspensión del servicio.",
          "",
          "Si ya realizaste el pago, ignora este mensaje.",
        ].join("\n");

        await sendWhatsappMessage(phoneNumber, waMessage);
      }

      const newExpiryDate = advanceOneMonth(service.expiryDate);

      await ddb.send(
        new UpdateCommand({
          TableName: SERVICES_TABLE,
          Key: { id: service.id },
          UpdateExpression:
            "set lastPaymentNotificationSent = :now, expiryDate = :newExpiry, updatedAt = :now",
          ExpressionAttributeValues: {
            ":now": now.toISOString(),
            ":newExpiry": newExpiryDate,
          },
        })
      );

      notifiedCount++;
    } catch (err) {
      console.error(`Failed to send reminder for service ${service.id}:`, err);
    }
  }

  return notifiedCount;
}

export function startPaymentReminderScheduler(): void {
  const run = async () => {
    try {
      const count = await checkAndSendPaymentReminders();
      if (count > 0) {
        console.log(`Payment reminders sent: ${count}`);
      }
    } catch (err) {
      console.error("Payment reminder scheduler error:", err);
    }
  };

  const now = new Date();
  const msUntilNextRun =
    new Date(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      8,
      0,
      0,
      0
    ).getTime() - now.getTime();

  setTimeout(() => {
    run();
    setInterval(run, 24 * 60 * 60 * 1000);
  }, msUntilNextRun > 0 ? msUntilNextRun : 24 * 60 * 60 * 1000);

  console.log("Payment reminder scheduler started");
}
