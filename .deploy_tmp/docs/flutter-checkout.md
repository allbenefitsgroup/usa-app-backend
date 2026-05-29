# Flutter: Checkout Y Acceso

Dependencias sugeridas:

```yaml
dependencies:
  firebase_auth: ^5.0.0
  cloud_functions: ^5.0.0
  cloud_firestore: ^5.0.0
  url_launcher: ^6.3.0
```

## Crear Perfil

Llama esto después del registro o cuando el usuario actualice su perfil.

```dart
import 'package:cloud_functions/cloud_functions.dart';

Future<void> syncUserProfile({
  required String name,
  String? phone,
}) async {
  final functions = FirebaseFunctions.instanceFor(region: 'us-central1');
  final callable = functions.httpsCallable('syncUserProfile');

  await callable.call({
    'name': name,
    'phone': phone,
  });
}
```

## Crear Checkout Session

```dart
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:url_launcher/url_launcher.dart';

Future<void> buyCourse(String courseId) async {
  final user = FirebaseAuth.instance.currentUser;
  if (user == null) {
    throw Exception('User must be signed in.');
  }

  final functions = FirebaseFunctions.instanceFor(region: 'us-central1');
  final callable = functions.httpsCallable('createCheckoutSession');

  final result = await callable.call({
    'userId': user.uid,
    'courseId': courseId,
  });

  final checkoutUrl = result.data['checkoutUrl'] as String;
  final uri = Uri.parse(checkoutUrl);

  if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
    throw Exception('Could not open Stripe Checkout.');
  }
}
```

## Consultar Compras Y Acceso

```dart
import 'package:cloud_functions/cloud_functions.dart';

Future<List<dynamic>> getMyCourses() async {
  final functions = FirebaseFunctions.instanceFor(region: 'us-central1');
  final callable = functions.httpsCallable('getMyCourseAccess');

  final result = await callable.call();
  return result.data['purchases'] as List<dynamic>;
}
```

Cada item devuelve:

```json
{
  "id": "purchase_abc123",
  "userId": "abc123",
  "courseId": "credit-repair-basics",
  "status": "paid",
  "amount": 9900,
  "currency": "usd",
  "customerEmail": "maria@example.com",
  "createdAt": 1710000000000,
  "paidAt": 1710000100000,
  "canViewContent": true,
  "course": {
    "id": "credit-repair-basics",
    "title": "Credit Repair Basics",
    "description": "Learn the foundations of credit repair in the United States.",
    "duration": "4h 30m",
    "level": "Beginner",
    "lessons": 12,
    "thumbnailUrl": "https://cdn.example.com/images/credit-repair-basics.jpg"
  }
}
```

## Leer Contenido Privado

Cuando `canViewContent == true`, puedes leer:

```dart
import 'package:cloud_firestore/cloud_firestore.dart';

Future<Map<String, dynamic>?> getCourseContent(String courseId) async {
  final doc = await FirebaseFirestore.instance
      .collection('courseContent')
      .doc(courseId)
      .get();

  return doc.data();
}
```

Las reglas bloquean este documento si el usuario no tiene acceso activo.
