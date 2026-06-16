import sgMail from "@sendgrid/mail";
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

interface WelcomeEmailInput {
  apiKey: string;
  supportEmail: string;
  appUrl: string;
  to: string;
  userName: string;
  role: string;
}

function canSendEmail(input: CourseEmailInput): boolean {
  if (!input.apiKey || !input.supportEmail) {
    console.warn("Email was skipped because EMAIL_API_KEY or SUPPORT_EMAIL is missing.");
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

interface AdminNotificationInput {
  apiKey: string;
  supportEmail: string;
  to: string;
  userName: string;
  email: string;
  role: string;
  phone?: string | null;
}

export async function sendAdminNotificationEmail(input: AdminNotificationInput): Promise<void> {
  if (!input.apiKey || !input.supportEmail) {
    console.warn("Admin notification email skipped because EMAIL_API_KEY or SUPPORT_EMAIL is missing.");
    return;
  }

  sgMail.setApiKey(input.apiKey);

  const roleLabels: Record<string, string> = {
    client: "Cliente",
    customer: "Cliente",
    student: "Estudiante",
    seller: "Vendedor",
  };
  const roleLabel = roleLabels[input.role] || "Usuario";

  await sgMail.send({
    to: input.to,
    from: input.supportEmail,
    subject: `Nuevo registro: ${input.userName} (${roleLabel})`,
    text: [
      `Nuevo usuario registrado en la plataforma.`,
      "",
      `Nombre: ${input.userName}`,
      `Email: ${input.email}`,
      `Rol: ${roleLabel}`,
      `Teléfono: ${input.phone || "No proporcionado"}`,
      `Fecha: ${new Date().toLocaleString("es-ES", { timeZone: "America/Argentina/Buenos_Aires" })}`,
    ].join("\n"),
    html: `
      <h2>Nuevo usuario registrado</h2>
      <table style="border-collapse: collapse; width: 100%; max-width: 400px;">
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Nombre</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${input.userName}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Email</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${input.email}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Rol</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${roleLabel}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Teléfono</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${input.phone || "No proporcionado"}</td>
        </tr>
        <tr>
          <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Fecha</td>
          <td style="padding: 8px; border: 1px solid #ddd;">${new Date().toLocaleString("es-ES", { timeZone: "America/Argentina/Buenos_Aires" })}</td>
        </tr>
      </table>
    `,
  });
}

export async function sendWelcomeEmail(input: WelcomeEmailInput): Promise<void> {
  if (!input.apiKey || !input.supportEmail) {
    console.warn("Welcome email was skipped because EMAIL_API_KEY or SUPPORT_EMAIL is missing.");
    return;
  }

  sgMail.setApiKey(input.apiKey);

  const roleLabels: Record<string, string> = {
    client: "Cliente",
    customer: "Cliente",
    student: "Estudiante",
    seller: "Vendedor",
  };
  const roleLabel = roleLabels[input.role] || "Usuario";
  const loginUrl = input.appUrl ? `${input.appUrl.replace(/\/$/, "")}/login` : "https://your-app.example.com/login";

  await sgMail.send({
    to: input.to,
    from: input.supportEmail,
    subject: `Bienvenido${input.userName ? `, ${input.userName}` : ""} - Tu cuenta de ${roleLabel} está lista`,
    text: [
      `Hola ${input.userName || "nuevo usuario"},`,
      "",
      `Tu cuenta de ${roleLabel} ha sido creada exitosamente.`,
      "",
      `Ahora puedes iniciar sesión aquí: ${loginUrl}`,
      "",
      `Si tienes alguna pregunta, contacta a ${input.supportEmail}.`,
    ].join("\n"),
    html: `
      <p>Hola <strong>${input.userName || "nuevo usuario"}</strong>,</p>
      <p>Tu cuenta de <strong>${roleLabel}</strong> ha sido creada exitosamente.</p>
      <p><a href="${loginUrl}">Inicia sesión aquí</a></p>
      <p>Si tienes alguna pregunta, contacta a <a href="mailto:${input.supportEmail}">${input.supportEmail}</a>.</p>
    `,
  });
}
