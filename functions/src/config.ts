function env(name: string, defaultValue?: string) {
  return {
    value: () => process.env[name] || defaultValue || "",
  };
}

export const REGION = "us-central1";

export const stripeSecretKey = env("STRIPE_SECRET_KEY");
export const stripeWebhookSecret = env("STRIPE_WEBHOOK_SECRET");
export const emailApiKey = env("EMAIL_API_KEY");

export const appUrl = env("APP_URL");
export const supportEmail = env("SUPPORT_EMAIL");

// Auth - usando variable de entorno normal para evitar depender de Secret Manager inicialmente
export const jwtSecret = env("JWT_SECRET", "cambiar-esto-en-produccion-por-un-secreto-largo-y-seguro");

// WhatsApp configuration
export const whatsappEnabled = env("WHATSAPP_ENABLED", "false");
export const whatsappPhoneNumber = env("WHATSAPP_PHONE_NUMBER", "");
