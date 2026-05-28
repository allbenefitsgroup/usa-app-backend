import sgMail from "@sendgrid/mail";
import * as logger from "firebase-functions/logger";
import { formatMoney } from "./money";

interface CourseEmailInput {
  apiKey: string;
  supportEmail: string;
  appUrl: string;
  to: string;
  userName?: string;
  courseTitle: string;
  courseId: string;
  amount: number;
  currency: string;
}

function canSendEmail(input: CourseEmailInput): boolean {
  if (!input.apiKey || !input.supportEmail) {
    logger.warn("Email was skipped because EMAIL_API_KEY or SUPPORT_EMAIL is missing.");
    return false;
  }

  return true;
}

function courseLink(appUrl: string, courseId: string): string {
  const baseUrl = appUrl || "https://your-app.example.com";
  return `${baseUrl.replace(/\/$/, "")}/learn/course/${encodeURIComponent(courseId)}`;
}

export async function sendPurchaseConfirmation(input: CourseEmailInput): Promise<void> {
  if (!canSendEmail(input)) {
    return;
  }

  sgMail.setApiKey(input.apiKey);

  const link = courseLink(input.appUrl, input.courseId);
  const price = formatMoney(input.amount, input.currency);

  await sgMail.send({
    to: input.to,
    from: input.supportEmail,
    subject: `Your course access is ready: ${input.courseTitle}`,
    text: [
      `Hi ${input.userName || "there"},`,
      "",
      `Your purchase of ${input.courseTitle} for ${price} was confirmed.`,
      `Open your course here: ${link}`,
      "",
      `Need help? Contact ${input.supportEmail}.`,
    ].join("\n"),
    html: `
      <p>Hi ${input.userName || "there"},</p>
      <p>Your purchase of <strong>${input.courseTitle}</strong> for <strong>${price}</strong> was confirmed.</p>
      <p><a href="${link}">Open your course</a></p>
      <p>Need help? Contact <a href="mailto:${input.supportEmail}">${input.supportEmail}</a>.</p>
    `,
  });
}

export async function sendPaymentFailedEmail(input: CourseEmailInput): Promise<void> {
  if (!canSendEmail(input)) {
    return;
  }

  sgMail.setApiKey(input.apiKey);

  await sgMail.send({
    to: input.to,
    from: input.supportEmail,
    subject: `Payment failed: ${input.courseTitle}`,
    text: [
      `Hi ${input.userName || "there"},`,
      "",
      `We could not complete the payment for ${input.courseTitle}.`,
      `You can try again from ${input.appUrl || "the app"}.`,
      "",
      `Need help? Contact ${input.supportEmail}.`,
    ].join("\n"),
    html: `
      <p>Hi ${input.userName || "there"},</p>
      <p>We could not complete the payment for <strong>${input.courseTitle}</strong>.</p>
      <p>You can try again from <a href="${input.appUrl}">the app</a>.</p>
      <p>Need help? Contact <a href="mailto:${input.supportEmail}">${input.supportEmail}</a>.</p>
    `,
  });
}

export async function sendRefundEmail(input: CourseEmailInput): Promise<void> {
  if (!canSendEmail(input)) {
    return;
  }

  sgMail.setApiKey(input.apiKey);

  await sgMail.send({
    to: input.to,
    from: input.supportEmail,
    subject: `Refund processed: ${input.courseTitle}`,
    text: [
      `Hi ${input.userName || "there"},`,
      "",
      `Your refund for ${input.courseTitle} was processed.`,
      "",
      `Need help? Contact ${input.supportEmail}.`,
    ].join("\n"),
    html: `
      <p>Hi ${input.userName || "there"},</p>
      <p>Your refund for <strong>${input.courseTitle}</strong> was processed.</p>
      <p>Need help? Contact <a href="mailto:${input.supportEmail}">${input.supportEmail}</a>.</p>
    `,
  });
}
