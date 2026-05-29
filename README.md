# USA All Benefits Group Backend

Backend Firebase para vender cursos digitales desde la seccion **Aprende** de una app Flutter.

## Stack

- **Auth propio** con JWT, bcrypt y endpoints REST.
- Firestore como base de datos.
- Firebase Cloud Functions para backend seguro.
- Stripe Checkout para pagos.
- SendGrid para emails transaccionales.

## Estructura

```text
.
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── functions
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   └── src
│       ├── api.ts
│       ├── auth.ts
│       ├── config.ts
│       ├── email.ts
│       ├── firebase.ts
│       ├── index.ts
│       ├── models.ts
│       ├── money.ts
│       ├── server.ts
│       ├── stripeClient.ts
│       └── swagger.yaml
└── docs
    ├── firestore-examples.md
    └── flutter-checkout.md
```

## Endpoints REST (Auth propio)

La API expone endpoints REST bajo la funcion `api` (o servidor Express local).

### Auth

- `POST /api/auth/register` - Registro de nuevos usuarios (cliente, customer, student, seller).
- `POST /api/auth/login` - Inicio de sesion con email y password. Devuelve JWT.
- `GET /api/auth/me` - Obtener perfil del usuario autenticado.

### Negocio (requieren `Authorization: Bearer <token>`)

- `POST /api/syncUserProfile` - Guardar/actualizar nombre, telefono y rol.
- `POST /api/createCheckoutSession` - Crear sesion de pago Stripe.
- `POST /api/getMyCourseAccess` - Listar compras y acceso a cursos.
- `POST /api/requestProductInfo` - Solicitar info de producto (WhatsApp lead).
- `POST /api/sendWhatsappNotification` - Enviar notificacion WhatsApp.

### Webhooks

- `POST /stripeWebhook` - Webhook de Stripe (raw body).

## Documentacion Swagger

Puedes probar todos los endpoints desde el navegador:

- **Local:** http://localhost:3000/docs
- **Produccion (Firebase):** `https://us-central1-TU_PROJECT_ID.cloudfunctions.net/api/docs`

La interfaz Swagger UI permite ver los schemas, probar peticiones y copiar los `curl` directamente.

## Registro y Login

### 1. Registro

```http
POST /api/auth/register
Content-Type: application/json

{
  "name": "Juan Perez",
  "email": "juan@example.com",
  "password": "secreto123",
  "phone": "+13051234567",
  "role": "client"
}
```

Roles validos: `client`, `customer`, `student`, `seller`.

Respuesta:
```json
{
  "ok": true,
  "uid": "abc123...",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": { ... }
}
```

### 2. Login

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "juan@example.com",
  "password": "secreto123"
}
```

Respuesta:
```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": { ... }
}
```

### 3. Usar el token

Incluir en todas las peticiones protegidas:

```
Authorization: Bearer <token>
```

## Modelo Firestore

Colecciones principales:

- `users/{uid}`: perfil basico del usuario (incluye `passwordHash`).
- `courses/{courseId}`: catalogo publico de cursos activos.
- `purchases/{purchaseId}`: compras creadas y actualizadas solo por Cloud Functions.
- `users/{uid}/courseAccess/{courseId}`: acceso habilitado o revocado por curso.
- `courseContent/{courseId}`: contenido privado del curso, solo admin o usuarios con acceso pago.

Importante: si `courses/{courseId}` es publico, no guardes alli URLs privadas de clases pagas. Firestore no puede ocultar campos individuales. El campo `videoUrl` del curso debe ser un trailer o preview publico. Las URLs privadas reales van en `courseContent/{courseId}`.

## Configuracion

1. Instala dependencias:

```bash
cd functions
npm install
```

2. Cambia el proyecto Firebase en `.firebaserc`:

```json
{
  "projects": {
    "default": "tu-project-id"
  }
}
```

3. Configura variables no secretas. Puedes crear `functions/.env.tu-project-id`:

```bash
APP_URL=https://tu-app.com
SUPPORT_EMAIL=soporte@tu-dominio.com
JWT_SECRET=tu-clave-secreta-muy-larga-y-aleatoria
```

4. Configura secretos:

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
firebase functions:secrets:set EMAIL_API_KEY
firebase functions:secrets:set JWT_SECRET
```

`SUPPORT_EMAIL` debe ser un sender verificado en SendGrid.

## Stripe

En Stripe Dashboard crea un webhook apuntando a:

```text
https://us-central1-TU_PROJECT_ID.cloudfunctions.net/api/stripeWebhook
```

> Si usas la funcion `stripeWebhook` separada, la URL es:
> `https://us-central1-TU_PROJECT_ID.cloudfunctions.net/stripeWebhook`

Eventos requeridos:

- `checkout.session.completed`
- `payment_intent.payment_failed`
- `charge.refunded`

Copia el signing secret del webhook en `STRIPE_WEBHOOK_SECRET`.

## Despliegue

```bash
firebase login
firebase use tu-project-id
firebase deploy --only functions,firestore:rules,firestore:indexes
```

Tambien puedes usar:

```bash
cd functions
npm run deploy
```

## Flujo Completo De Compra

1. El frontend llama `POST /api/auth/register` (o `/login`) y guarda el JWT.
2. El frontend llama `POST /api/syncUserProfile` para guardar nombre y telefono (rol se define en el registro).
3. Flutter lista cursos activos desde `courses`.
4. El usuario toca comprar.
5. Flutter llama `POST /api/createCheckoutSession` con `userId` y `courseId`.
6. El backend valida el usuario autenticado, busca el curso, crea `purchases/{purchaseId}` en `pending` y crea Stripe Checkout.
7. La app abre la URL devuelta por Stripe.
8. Stripe envia `checkout.session.completed` al webhook.
9. `stripeWebhook` verifica la firma, marca la compra como `paid`, crea `users/{uid}/courseAccess/{courseId}` con `status: active` y envia email de confirmacion.
10. Flutter llama `POST /api/getMyCourseAccess` o lee sus compras para saber si el curso esta `paid`, `pending`, `failed` o `refunded`.
11. Si Stripe reporta fallo, la compra pasa a `failed` y se envia email.
12. Si hay reembolso, la compra pasa a `refunded`, el acceso se revoca y se envia email.

## Seguridad

Las reglas en `firestore.rules` hacen que:

- cada usuario lea solo su propio perfil;
- cada usuario lea solo sus propias compras;
- clientes no puedan crear ni modificar compras;
- clientes no puedan marcar compras como pagadas;
- cursos activos sean publicos;
- escritura de cursos sea solo admin;
- contenido privado del curso requiera acceso pago;
- Cloud Functions use Admin SDK y pueda escribir compras/accesos sin pasar por reglas.

## Notas De Precio

`courses.price` esta en unidades menores para evitar errores de decimales.

- USD 99.00 se guarda como `9900`.
- USD 19.99 se guarda como `1999`.

Stripe Checkout recibe ese mismo valor como `unit_amount`.
