import { defineSecret, defineString } from "firebase-functions/params";

const isFirebaseFunctions = !!process.env.FUNCTIONS_EMULATOR || !!process.env.K_SERVICE;

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

// Auth - usando variable de entorno normal para evitar depender de Secret Manager inicialmente
export const jwtSecret = createString("JWT_SECRET", "cambiar-esto-en-produccion-por-un-secreto-largo-y-seguro");

// WhatsApp configuration
export const whatsappEnabled = createString("WHATSAPP_ENABLED", "false");
export const whatsappPhoneNumber = createString("WHATSAPP_PHONE_NUMBER", "");
