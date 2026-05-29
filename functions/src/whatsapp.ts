import * as logger from "firebase-functions/logger";

// WARNING: @open-wa/wa-automate uses Puppeteer (headless Chrome).
// It does NOT work in Firebase Functions serverless environment.
// For production WhatsApp messaging, use the WhatsApp Business API (Meta) instead.
// This module is kept for local development only.

const isEmulator = !!process.env.FUNCTIONS_EMULATOR;
const isLocalServer = !process.env.K_SERVICE && !isEmulator;

let waAutomateModule: any = null;
let whatsappClient: any = null;

async function getWaAutomate() {
  if (!waAutomateModule) {
    waAutomateModule = await import("@open-wa/wa-automate");
  }
  return waAutomateModule;
}

/**
 * Initialize WhatsApp client. Must be called before sending messages.
 * In development, this scans a QR code. In production, session is persisted.
 * NOTE: This will NOT work inside Firebase Functions. Only run locally.
 */
export async function initializeWhatsappClient(): Promise<any> {
  if (whatsappClient) {
    return whatsappClient;
  }

  if (!isLocalServer) {
    logger.warn("WhatsApp Web client initialization skipped in serverless environment.");
    return null;
  }

  try {
    const { create } = await getWaAutomate();
    whatsappClient = await create({
      sessionId: "all-benefits-group",
      headless: true,
      qrTimeout: 0,
      statusFind: true,
      autoRefresh: true,
      browserArgs: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    logger.info("WhatsApp client initialized successfully");
    return whatsappClient;
  } catch (error) {
    logger.error("Failed to initialize WhatsApp client", error);
    throw error;
  }
}

/**
 * Send a WhatsApp message to a phone number
 * @param phoneNumber - Phone number in international format (e.g., +1234567890)
 * @param message - Message text to send
 */
export async function sendWhatsappMessage(phoneNumber: string, message: string): Promise<boolean> {
  if (!isLocalServer) {
    logger.warn("WhatsApp message skipped in serverless environment.", { phoneNumber });
    return false;
  }

  try {
    if (!whatsappClient) {
      whatsappClient = await initializeWhatsappClient();
    }

    if (!whatsappClient) {
      return false;
    }

    // Ensure phone number is in correct format (remove any non-digits except +)
    const cleanedPhone = phoneNumber.replace(/\D/g, "");
    const formattedPhone = `${cleanedPhone}@c.us`;

    const result = await whatsappClient.sendText(formattedPhone, message);

    logger.info("WhatsApp message sent successfully", {
      phoneNumber,
      messageLength: message.length,
    });

    return !!result;
  } catch (error) {
    logger.error("Failed to send WhatsApp message", {
      phoneNumber,
      error,
    });
    return false;
  }
}

/**
 * Close the WhatsApp client connection
 */
export async function closeWhatsappClient(): Promise<void> {
  if (whatsappClient) {
    try {
      await whatsappClient.kill();
      whatsappClient = null;
      logger.info("WhatsApp client closed");
    } catch (error) {
      logger.error("Error closing WhatsApp client", error);
    }
  }
}
