import { defineSecret, defineString } from "firebase-functions/params";

export const REGION = "us-central1";

export const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
export const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
export const emailApiKey = defineSecret("EMAIL_API_KEY");

export const appUrl = defineString("APP_URL");
export const supportEmail = defineString("SUPPORT_EMAIL");

// WhatsApp configuration
export const whatsappEnabled = defineString("WHATSAPP_ENABLED", { default: "false" });
