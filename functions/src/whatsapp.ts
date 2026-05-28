import { create } from "@open-wa/wa-automate";
import * as logger from "firebase-functions/logger";

type WhatsappClient = any; // OpenWA doesn't export types properly

let whatsappClient: WhatsappClient | null = null;

/**
 * Initialize WhatsApp client. Must be called before sending messages.
 * In development, this scans a QR code. In production, session is persisted.
 */
export async function initializeWhatsappClient(): Promise<WhatsappClient> {
  if (whatsappClient) {
    return whatsappClient;
  }

  try {
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
  try {
    if (!whatsappClient) {
      whatsappClient = await initializeWhatsappClient();
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
