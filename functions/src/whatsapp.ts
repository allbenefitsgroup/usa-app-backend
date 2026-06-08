// WARNING: @open-wa/wa-automate uses Puppeteer (headless Chrome).
// For production WhatsApp messaging, use the WhatsApp Business API (Meta) instead.

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
 */
export async function initializeWhatsappClient(): Promise<any> {
  if (whatsappClient) {
    return whatsappClient;
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

    console.log("WhatsApp client initialized successfully");
    return whatsappClient;
  } catch (error) {
    console.error("Failed to initialize WhatsApp client", error);
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

    if (!whatsappClient) {
      return false;
    }

    // Ensure phone number is in correct format (remove any non-digits except +)
    const cleanedPhone = phoneNumber.replace(/\D/g, "");
    const formattedPhone = `${cleanedPhone}@c.us`;

    const result = await whatsappClient.sendText(formattedPhone, message);

    console.log("WhatsApp message sent successfully", {
      phoneNumber,
      messageLength: message.length,
    });

    return !!result;
  } catch (error) {
    console.error("Failed to send WhatsApp message", {
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
      console.log("WhatsApp client closed");
    } catch (error) {
      console.error("Error closing WhatsApp client", error);
    }
  }
}
