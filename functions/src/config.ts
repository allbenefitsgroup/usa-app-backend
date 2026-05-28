import { defineSecret, defineString } from "firebase-functions/params";

const isFirebaseFunctions = !!process.env.FUNCTIONS_EMULATOR || !!process.env.K_SERVICE || !!process.env.GOOGLE_CLOUD_PROJECT;

function createSecret(name: string) {
  if (isFirebaseFunctions) {
    return defineSecret(name);
  }
  return {
    value: () => process.env[name] || "",
  };
}

function createString(name: string, defaultValue?: string) {
  if (isFirebaseFunctions) {
    const opts = defaultValue !== undefined ? { default: defaultValue } : undefined;
    return defineString(name, opts);
  }
  return {
    value: () => process.env[name] || defaultValue || "",
  };
}

export const REGION = "us-central1";

export const stripeSecretKey = createSecret("STRIPE_SECRET_KEY");
export const stripeWebhookSecret = createSecret("STRIPE_WEBHOOK_SECRET");
export const emailApiKey = createSecret("EMAIL_API_KEY");

export const appUrl = createString("APP_URL");
export const supportEmail = createString("SUPPORT_EMAIL");

// WhatsApp configuration
export const whatsappEnabled = createString("WHATSAPP_ENABLED", "false");
