# Ejemplos Firestore

## users/{uid}

```json
{
  "uid": "abc123",
  "name": "Maria Lopez",
  "email": "maria@example.com",
  "phone": "+1 555 111 2222",
  "createdAt": "serverTimestamp",
  "updatedAt": "serverTimestamp"
}
```

## courses/{courseId}

```json
{
  "id": "credit-repair-basics",
  "title": "Credit Repair Basics",
  "description": "Learn the foundations of credit repair in the United States.",
  "price": 9900,
  "currency": "usd",
  "duration": "4h 30m",
  "level": "Beginner",
  "lessons": 12,
  "videoUrl": "https://cdn.example.com/previews/credit-repair-basics.mp4",
  "thumbnailUrl": "https://cdn.example.com/images/credit-repair-basics.jpg",
  "isActive": true,
  "createdAt": "serverTimestamp",
  "updatedAt": "serverTimestamp"
}
```

`videoUrl` debe ser un preview público. No guardes una clase paga en un documento que todos pueden leer.

## courseContent/{courseId}

```json
{
  "courseId": "credit-repair-basics",
  "lessons": [
    {
      "id": "lesson-1",
      "title": "Welcome and Course Roadmap",
      "duration": "08:15",
      "videoUrl": "https://secure-cdn.example.com/courses/credit-repair-basics/lesson-1.mp4",
      "resources": [
        "https://secure-cdn.example.com/courses/credit-repair-basics/workbook.pdf"
      ]
    }
  ],
  "updatedAt": "serverTimestamp"
}
```

Este documento solo lo leen admins o usuarios con `courseAccess/{courseId}.status == "active"`.

## purchases/{purchaseId}

```json
{
  "id": "purchase_abc123",
  "userId": "abc123",
  "courseId": "credit-repair-basics",
  "stripeCheckoutSessionId": "cs_test_123",
  "stripePaymentIntentId": "pi_123",
  "status": "paid",
  "amount": 9900,
  "currency": "usd",
  "customerEmail": "maria@example.com",
  "createdAt": "serverTimestamp",
  "updatedAt": "serverTimestamp",
  "paidAt": "serverTimestamp",
  "failedAt": null,
  "refundedAt": null
}
```

Estados válidos:

- `pending`
- `paid`
- `failed`
- `refunded`

## users/{uid}/courseAccess/{courseId}

```json
{
  "userId": "abc123",
  "courseId": "credit-repair-basics",
  "purchaseId": "purchase_abc123",
  "status": "active",
  "grantedAt": "serverTimestamp",
  "revokedAt": null,
  "updatedAt": "serverTimestamp"
}
```

Estados válidos:

- `active`
- `revoked`
