import { Request, Response } from "express";
import QRCode from "qrcode";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, USERS_TABLE } from "./dynamodb";

/**
 * Public endpoint that returns the seller profile data.
 * Anyone can access this (no auth required) so the QR link works for anyone scanning it.
 */
export async function handleGetPublicSellerProfile(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: { message: "id is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    const userResult = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { uid: id },
      })
    );

    if (!userResult.Item) {
      res.status(404).json({ error: { message: "Seller not found.", status: "NOT_FOUND" } });
      return;
    }

    const user = userResult.Item;
    const sellerData = {
      nombre: user.name || null,
      cargo: user.title || user.position || user.role || null,
      descripcion: user.description || null,
      ubicacion: user.location || null,
      calificacion: user.rating || null,
      tiempo_respuesta: user.responseTime || null,
      especialidades: user.specialties || [],
      telefono: user.phone || null,
      correo: user.email || null,
    };

    res.json({
      ok: true,
      seller: sellerData,
    });
  } catch (error: any) {
    console.error("GetPublicSellerProfile error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
    }
  }
}

/**
 * Public endpoint that generates a QR code for a seller.
 * The QR contains a public URL to the seller profile so that unregistered users can scan it.
 */
export async function handleGenerateSellerQR(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: { message: "id is required.", status: "INVALID_ARGUMENT" } });
      return;
    }

    // Verify the seller exists
    const userResult = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { uid: id },
      })
    );

    if (!userResult.Item) {
      res.status(404).json({ error: { message: "Seller not found.", status: "NOT_FOUND" } });
      return;
    }

    const user = userResult.Item;
    const allowedRoles = ["seller", "admin"];
    if (!allowedRoles.includes(user.role)) {
      res.status(403).json({ error: { message: "User is not a seller.", status: "PERMISSION_DENIED" } });
      return;
    }

    // Build a public URL that points to the seller profile endpoint
    const publicUrl = `${req.protocol}://${req.get("host")}/api/public/sellers/${id}`;

    // Generate QR as a base64 PNG data URL
    const qrDataUrl = await QRCode.toDataURL(publicUrl, {
      width: 400,
      margin: 2,
      color: {
        dark: "#000000",
        light: "#FFFFFF",
      },
    });

    res.json({
      ok: true,
      qrCode: qrDataUrl,
      url: publicUrl,
    });
  } catch (error: any) {
    console.error("GenerateSellerQR error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message || "Internal server error", status: "INTERNAL" } });
    }
  }
}
