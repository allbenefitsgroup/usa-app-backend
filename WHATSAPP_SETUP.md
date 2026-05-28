# WhatsApp Integration Setup

Esta guía explica cómo configurar y usar OpenWA para enviar mensajes de WhatsApp.

## Instalación

Ya hemos instalado `@open-wa/wa-automate`:
```bash
npm install @open-wa/wa-automate
```

## Configuración

### 1. Habilitar WhatsApp en Firebase

```bash
# En desarrollo (local):
firebase functions:config:set whatsapp.enabled true

# O usando variables de entorno en .env.local:
WHATSAPP_ENABLED=true
```

### 2. Estructura del Código

- **`src/whatsapp.ts`** - Servicio de WhatsApp con funciones:
  - `initializeWhatsappClient()` - Inicializa el cliente (requiere escanear QR)
  - `sendWhatsappMessage(phoneNumber, message)` - Envía un mensaje
  - `closeWhatsappClient()` - Cierra la conexión

- **`src/index.ts`** - Endpoint `sendWhatsappNotification` que:
  - Requiere autenticación
  - Valida el número de teléfono
  - Envía el mensaje

## Uso

### 1. Solicitar Información sobre un Producto (Flujo Principal)

Cuando el usuario hace click en "Solicitar información" en un producto:

```typescript
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";

const requestProductInfo = httpsCallable(functions, "requestProductInfo");

async function handleProductInfoRequest(
  productId: string,
  productName: string,
  customerName: string,
  phoneNumber: string,
  customerEmail?: string
) {
  try {
    const result = await requestProductInfo({
      productId,
      productName,
      phoneNumber,        // Formato: +1234567890
      customerName,
      customerEmail
    });
    
    console.log("✅ Lead creado:", result.data);
    // Mostrar: "Se ha enviado un mensaje a tu WhatsApp"
  } catch (error) {
    console.error("❌ Error:", error);
    // Mostrar error al usuario
  }
}
```

**El endpoint automáticamente:**
- Guarda la solicitud en Firestore (colección `leads`)
- Envía un mensaje de WhatsApp:
  ```
  "Hola [nombre], has solicitado información sobre [producto]. 
   En breves se comunicará un agente para brindarte más detalles. ¡Gracias!"
  ```

### 2. Enviar Mensaje Personalizado (Uso Avanzado)

Para mensajes manuales (requiere autenticación):

```typescript
const sendWhatsappNotification = httpsCallable(functions, "sendWhatsappNotification");

const result = await sendWhatsappNotification({
  phoneNumber: "+12125551234",
  message: "Tu mensaje personalizado aquí"
});
```

## Importante

### Limitaciones de OpenWA

1. **QR Scan Requerido**: La primera vez que se ejecute, necesita escanear un código QR de WhatsApp Web
2. **Rate Limiting**: WhatsApp tiene límites de mensajes por hora/día
3. **Número de Teléfono Único**: Solo puedes usar UN número de WhatsApp por instancia
4. **Frágil a Cambios**: Si WhatsApp actualiza su interfaz web, la librería puede romperse
5. **Requiere Headless Browser**: Necesita Puppeteer/Chrome instalado

### Alternativa Recomendada

Para producción, considera usar la **API Oficial de WhatsApp Business**:
- Más confiable
- Mejor soporte
- Rate limits más generosos
- Validado por WhatsApp

https://developers.facebook.com/docs/whatsapp/cloud-api/

## Desarrollo Local

1. Habilitar WhatsApp en local:
   ```bash
   firebase functions:config:set whatsapp.enabled true
   ```

2. Ejecutar emulador:
   ```bash
   npm run serve
   ```

3. La primera vez que se llame a `sendWhatsappNotification`:
   - Se mostrará un código QR en la terminal
   - Escanea con tu teléfono de WhatsApp
   - Se guardará la sesión para futuras llamadas

## Variables de Sesión

OpenWA guarda la sesión automáticamente. En producción, considera:
- Guardar la sesión en Cloud Storage de Firebase
- Usar variables de entorno para configurar la ruta de sesión

## Estructura de Datos en Firestore

### Colección: `leads`

```json
{
  "id": "abc123def456",
  "productId": "prod_xyz",
  "productName": "Seguro de Salud Premium",
  "phoneNumber": "+12125551234",
  "customerName": "Juan Pérez",
  "customerEmail": "juan@example.com",
  "userId": "uid_12345",              // null si es usuario anónimo
  "status": "pending",                 // pending | contacted | scheduled | completed | cancelled
  "notes": null,
  "whatsappSentAt": Timestamp,        // Cuándo se envió el WhatsApp
  "contactedAt": null,                // Cuándo el agente se contactó
  "createdAt": Timestamp,
  "updatedAt": Timestamp
}
```

**Para consultas en el dashboard:**
```javascript
// Todas las solicitudes pendientes
db.collection("leads")
  .where("status", "==", "pending")
  .orderBy("createdAt", "desc")
  .get()

// Por producto
db.collection("leads")
  .where("productId", "==", "prod_xyz")
  .orderBy("createdAt", "desc")
  .get()
```

## Troubleshooting

### "QR timeout"
- Aumenta el timeout en `whatsapp.ts`
- O escanea más rápido

### "Message not sent"
- Verifica el formato del número: `+[código país][número]`
- Asegúrate de que el número tenga WhatsApp activo
- Revisa los logs de Firebase

### "Headless browser not found"
- En Cloud Functions, ya está incluido
- En local, instala: `npm install puppeteer-extra-plugin-stealth`
